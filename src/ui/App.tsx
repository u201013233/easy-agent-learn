import React, {useRef, useState, useCallback} from "react";
import {Box, Text, useApp, useInput} from "ink";
import {MessageParam} from "@anthropic-ai/sdk/resources/messages.js";
import type {QueryEngine, QueryEngineEvent} from "../core/queryEngine.js";
import type {LoopEvent, ContentBlock} from "../types/message.js";
import {ToolCallInfo} from "./type.js";
import {Spinner} from "./components/Spinner.js";
import type {PermissionRequest, PermissionBehavior} from "../permissions/types.js";

interface AppProps {
    engine: QueryEngine;
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractAssistantText(msg: MessageParam): string | null {
    if (typeof msg.content === "string") return msg.content;
    if (!Array.isArray(msg.content)) return null;
    return msg.content
        .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
        .map((b) => b.text)
        .join("");
}

function permissionRiskColor(level: string): string {
    switch (level) {
        case "high": return "red";
        case "medium": return "yellow";
        default: return "green";
    }
}

export function App({engine}: AppProps): React.ReactNode {
    const {exit} = useApp();

    // UI 状态
    const [messages, setMessages] = useState<MessageParam[]>([]);
    const [inputValue, setInputValue] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [spinnerLabel, setSpinnerLabel] = useState("Thinking");
    const [streamingText, setStreamingText] = useState("");
    const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
    const [lastUsage, setLastUsage] = useState<{ input: number; output: number } | null>(null);
    const [infoMessage, setInfoMessage] = useState<string | null>(null);
    const [errorText, setErrorText] = useState<string | null>(null);
    const [activeModel, setActiveModel] = useState(engine.getActiveModel());

    // 权限确认状态
    const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
    const permissionResolveRef = useRef<((decision: PermissionBehavior) => void) | null>(null);
    const sessionAllowRulesRef = useRef<string[]>([]);

    // 中断控制
    const abortRef = useRef<AbortController | null>(null);
    const engineRef = useRef(engine);
    engineRef.current = engine;

    useInput((input, key) => {
        // 权限确认模式下处理按键
        if (permissionRequest && permissionResolveRef.current) {
            if (input === "y") {
                permissionResolveRef.current("allow");
                permissionResolveRef.current = null;
                setPermissionRequest(null);
                return;
            }
            if (input === "n") {
                permissionResolveRef.current("deny");
                permissionResolveRef.current = null;
                setPermissionRequest(null);
                return;
            }
            if (input === "a") {
                const req = permissionRequest;
                if (req.toolName === "Bash") {
                    const cmd = (req.input.command as string) || "";
                    sessionAllowRulesRef.current = [...sessionAllowRulesRef.current, `Bash(command=${cmd}*)`];
                } else {
                    sessionAllowRulesRef.current = [...sessionAllowRulesRef.current, req.toolName];
                }
                permissionResolveRef.current("allow");
                permissionResolveRef.current = null;
                setPermissionRequest(null);
                setInfoMessage(`Always allow: ${req.toolName}`);
                return;
            }
            return;
        }

        // Ctrl+C：中断当前请求
        if (key.ctrl && input === "c") {
            if (abortRef.current) {
                abortRef.current.abort();
                abortRef.current = null;
            }
            return;
        }

        // Ctrl+D：退出程序
        if (key.ctrl && input === "d") {
            exit();
            return;
        }

        // 正在加载时忽略普通输入
        if (isLoading) return;

        // 回车：提交消息
        if (key.return) {
            const text = inputValue;
            setInputValue("");
            void handleSubmit(text);
            return;
        }

        // 退格
        if (key.backspace || key.delete) {
            setInputValue((prev) => prev.slice(0, -1));
            return;
        }

        // 普通字符追加到输入框
        if (input && !key.ctrl && !key.meta) {
            setInputValue((prev) => prev + input);
        }
    });

    // 权限请求回调：返回 Promise，等待用户按键
    const handlePermissionRequest = useCallback(
        (request: PermissionRequest): Promise<PermissionBehavior> => {
            return new Promise((resolve) => {
                setPermissionRequest(request);
                permissionResolveRef.current = resolve;
            });
        },
        [],
    );

    const handleSubmit = useCallback(
        async (text: string) => {
            if (!text.trim()) return;
            const trimmed = text.trim();

            // /exit /quit 由 UI 层处理（QueryEngine 不处理退出）
            if (trimmed === "/exit" || trimmed === "/quit") {
                exit();
                return;
            }

            // 重置 UI 状态
            setStreamingText("");
            setToolCalls([]);
            setErrorText(null);
            setInfoMessage(null);
            setIsLoading(true);
            setSpinnerLabel("Thinking");

            // 设置权限回调
            engineRef.current.setOnPermissionRequest(handlePermissionRequest);

            try {
                const generator = engineRef.current.submitMessage(trimmed);

                while (true) {
                    const {value, done} = await generator.next();
                    if (done) {
                        const result = value;
                        if (result.handled && result.terminationReason) {
                            // QueryEngine 内部已更新 messages，从 getState 同步
                        }
                        break;
                    }

                    const event = value as QueryEngineEvent;

                    switch (event.type) {
                        // ── 会话级事件 ──
                        case "messages_updated":
                            setMessages([...event.messages]);
                            break;

                        case "usage_updated":
                            setLastUsage({
                                input: event.turnUsage.input_tokens,
                                output: event.turnUsage.output_tokens,
                            });
                            break;

                        case "command":
                            if (event.kind === "error") {
                                setErrorText(event.message);
                            } else {
                                setInfoMessage(event.message);
                            }
                            break;

                        case "model_changed":
                            setActiveModel(event.model);
                            break;

                        // ── Loop 事件透传 ──
                        case "text":
                            setStreamingText((prev) => prev + event.text);
                            break;

                        case "tool_use_start":
                            setToolCalls((prev) => [...prev, {id: event.id, name: event.name}]);
                            setSpinnerLabel("Using tool: " + event.name);
                            break;

                        case "tool_use_call":
                            setToolCalls((prev) =>
                                prev.map((tc) =>
                                    tc.id === event.id && tc.input === undefined
                                        ? {...tc, input: JSON.stringify(event.input)}
                                        : tc,
                                ),
                            );
                            break;

                        case "tool_use_done":
                            setToolCalls((prev) =>
                                prev.map((tc) =>
                                    tc.id === event.id
                                        ? {...tc, resultLength: event.resultLength, isError: event.isError}
                                        : tc,
                                ),
                            );
                            setSpinnerLabel("Thinking");
                            break;

                        case "assistant_message":
                            setStreamingText("");
                            break;

                        case "tool_result_message":
                            break;

                        case "permission_request":
                            // QueryEngine 透传 permission_request，UI 处理显示
                            break;

                        case "error":
                            setErrorText(event.error.message);
                            break;
                    }
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === "AbortError") {
                    setInfoMessage("Interrupted.");
                } else {
                    setErrorText(err instanceof Error ? err.message : String(err));
                }
            } finally {
                setIsLoading(false);
                setStreamingText("");
                abortRef.current = null;
            }
        },
        [exit, handlePermissionRequest],
    );

    return (
        <Box flexDirection="column" paddingX={1}>
            {/* 头部 */}
            <Box marginBottom={1}>
                <Text bold color="cyan">Easy Agent</Text>
                <Text dimColor> ({activeModel})</Text>
            </Box>
            <Text dimColor>Type a message to start. Ctrl+C to interrupt, Ctrl+D to exit.</Text>

            {/* 对话历史 */}
            {messages.map((msg, i) => {
                if (msg.role === "user" && typeof msg.content === "string") {
                    return (
                        <Box key={`u${i}`} marginTop={1}>
                            <Text color="green" bold>{"❯ "}</Text>
                            <Text>{msg.content}</Text>
                        </Box>
                    );
                }
                if (msg.role === "assistant") {
                    const text = extractAssistantText(msg);
                    if (text) {
                        return (
                            <Box key={`a${i}`}>
                                <Text color="magenta">{"▎ "}</Text>
                                <Text>{text}</Text>
                            </Box>
                        );
                    }
                }
                return null;
            })}

            {/* 工具调用指示器 */}
            {toolCalls.map((tc, i) => (
                <Box key={`tc${i}`} marginLeft={2} flexDirection="column">
                    {tc.resultLength !== undefined
                        ? <Text color="green">{"✓ "}{tc.name} ({tc.resultLength} chars)</Text>
                        : <Text color="yellow">{"⚡ Using tool: "}{tc.name}</Text>}
                    {tc.input && (
                        <Text dimColor>{"  args: "}{tc.input}</Text>
                    )}
                </Box>
            ))}

            {/* 权限确认框 */}
            {permissionRequest && (
                <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
                    <Box>
                        <Text bold color="yellow">⚡ Permission required: </Text>
                        <Text bold>{permissionRequest.toolName}</Text>
                    </Box>
                    <Text dimColor>  args: {permissionRequest.summary}</Text>
                    <Text color={permissionRiskColor(permissionRequest.riskLevel)}>
                        {"  risk: "}{permissionRequest.riskLevel} — {permissionRequest.reason}
                    </Text>
                    <Box marginTop={1}>
                        <Text color="green" bold>{"[y]"} </Text>
                        <Text>allow once   </Text>
                        <Text color="red" bold>{"[n]"} </Text>
                        <Text>deny   </Text>
                        <Text color="cyan" bold>{"[a]"} </Text>
                        <Text>always allow</Text>
                    </Box>
                </Box>
            )}

            {/* Spinner */}
            {isLoading && !streamingText && !permissionRequest && <Spinner label={spinnerLabel}/>}

            {/* 流式文本 */}
            {isLoading && streamingText && (
                <Box>
                    <Text color="magenta">{"▎ "}</Text>
                    <Text>{streamingText}</Text>
                </Box>
            )}

            {/* 错误 / 信息 / token 用量 */}
            {errorText && <Text color="red">{"✗ "}{errorText}</Text>}
            {infoMessage && <Text dimColor>{"  "}{infoMessage}</Text>}
            {lastUsage && !isLoading && (
                <Text dimColor>{"  tokens: "}{lastUsage.input} in / {lastUsage.output} out</Text>
            )}

            {/* 输入行 */}
            {!isLoading && !permissionRequest && (
                <Box marginTop={1}>
                    <Text color="green" bold>{"❯ "}</Text>
                    <Text>{inputValue}</Text>
                    <Text dimColor>▋</Text>
                </Box>
            )}
        </Box>
    );
}
