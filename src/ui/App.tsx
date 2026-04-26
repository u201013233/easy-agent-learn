import React, {useRef, useState, useCallback} from "react";
import {Box, Text, useApp, useInput} from "ink";
import {MessageParam} from "@anthropic-ai/sdk/resources/messages.js";
import {query} from "../core/agenticLoop.js";
import type {LoopEvent, ContentBlock} from "../types/message.js";
import {ToolCallInfo} from "./type.js";
import Anthropic from "@anthropic-ai/sdk";
import {Spinner} from "./components/Spinner.js";
import type {PermissionRequest, PermissionBehavior, PermissionMode} from "../permissions/types.js";

interface AppProps {
    model: string;
    toolsApiParams: Anthropic.Tool[];
    system?: string;
    permissionMode?: PermissionMode;
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

export function App({model, system, toolsApiParams, permissionMode}: AppProps): React.ReactNode {
    const {exit} = useApp();

    // 对话数据
    const [messages, setMessages] = useState<MessageParam[]>([]);
    const [inputValue, setInputValue] = useState("");

    // UI 状态
    const [isLoading, setIsLoading] = useState(false);
    const [spinnerLabel, setSpinnerLabel] = useState("Thinking");
    const [streamingText, setStreamingText] = useState("");
    const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
    const [lastUsage, setLastUsage] = useState<{ input: number; output: number } | null>(null);
    const [infoMessage, setInfoMessage] = useState<string | null>(null);
    const [errorText, setErrorText] = useState<string | null>(null);

    // 权限确认状态
    const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
    const permissionResolveRef = useRef<((decision: PermissionBehavior) => void) | null>(null);
    const sessionAllowRulesRef = useRef<string[]>([]);

    // 中断控制
    const abortRef = useRef<AbortController | null>(null);
    const messagesRef = useRef<MessageParam[]>([]);
    messagesRef.current = messages;

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
                // Always allow: add session rule
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

            // Slash commands 本地拦截
            if (trimmed === "/exit" || trimmed === "/quit") {
                exit();
                return;
            }
            if (trimmed === "/clear") {
                setMessages([]);
                messagesRef.current = [];
                setInfoMessage("Conversation cleared.");
                return;
            }
            if (trimmed === "/history") {
                setInfoMessage(`${messagesRef.current.length} messages in conversation.`);
                return;
            }

            // 重置 UI 状态
            setStreamingText("");
            setToolCalls([]);
            setErrorText(null);
            setInfoMessage(null);
            setIsLoading(true);
            setSpinnerLabel("Thinking");

            // 追加 user message
            const userMsg: MessageParam = {role: "user", content: trimmed};
            const updatedMessages = [...messagesRef.current, userMsg];
            setMessages(updatedMessages);
            messagesRef.current = updatedMessages;

            const abort = new AbortController();
            abortRef.current = abort;

            try {
                const loop = query({
                    messages: updatedMessages,
                    model,
                    system,
                    tools: toolsApiParams.length > 0 ? toolsApiParams : undefined,
                    signal: abort.signal,
                    permissionMode: permissionMode ?? "default",
                    sessionAllowRules: sessionAllowRulesRef.current,
                    onPermissionRequest: handlePermissionRequest,
                });

                while (true) {
                    const {value, done} = await loop.next();
                    if (done) {
                        // 最终结果
                        const result = value;
                        setMessages(result.messages);
                        messagesRef.current = result.messages;
                        setLastUsage({
                            input: result.usage.input_tokens,
                            output: result.usage.output_tokens,
                        });

                        if (result.terminationReason === "aborted" || abort.signal.aborted) {
                            setInfoMessage("Interrupted.");
                        }
                        break;
                    }

                    const event = value as LoopEvent;
                    switch (event.type) {
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
                            setMessages((prev) => [...prev, event.message]);
                            messagesRef.current = [...messagesRef.current, event.message];
                            setStreamingText("");
                            break;

                        case "tool_result_message":
                            setMessages((prev) => [...prev, event.message]);
                            messagesRef.current = [...messagesRef.current, event.message];
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
        [exit, model, system, toolsApiParams, permissionMode, handlePermissionRequest],
    );

    return (
        <Box flexDirection="column" paddingX={1}>
            {/* 头部 */}
            <Box marginBottom={1}>
                <Text bold color="cyan">Easy Agent</Text>
                <Text dimColor> ({model})</Text>
                {permissionMode && permissionMode !== "default" && (
                    <Text color="yellow"> [{permissionMode}]</Text>
                )}
            </Box>
            <Text dimColor>Type a message to start. Ctrl+C to interrupt, Ctrl+D to exit.</Text>

            {/* 对话历史：user + assistant 交替 */}
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

            {/* Spinner：等待 API 响应时显示 */}
            {isLoading && !streamingText && !permissionRequest && <Spinner label={spinnerLabel}/>}

            {/* 流式文本：API 正在回复时实时显示 */}
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
