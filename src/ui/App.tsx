import React, {useRef, useState, ReactNode, useCallback} from "react";
import {Box, Text, useApp, useInput} from "ink";
import {MessageParam} from "@anthropic-ai/sdk/resources/messages.js";
import {streamMessage, StreamResult} from "../services/stream.js";
import {StreamEvent} from "../types/message.js";
import {ToolCallInfo} from "./type.js";
import Anthropic from "@anthropic-ai/sdk";
import {Spinner} from "./components/Spinner.js";
import type {ContentBlock, ToolUseBlock, ToolResultBlock} from "../types/message.js";

interface AppProps {
    model: string;
    toolsApiParams: Anthropic.Tool[];
    system?: string;
}

export const MAX_TOOL_TURNS = 50;

// ─── Helpers ────────────────────────────────────────────────────────

function extractAssistantText(msg: MessageParam): string | null {
    if (typeof msg.content === "string") return msg.content;
    if (!Array.isArray(msg.content)) return null;
    return msg.content
        .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
        .map((b) => b.text)
        .join("");
}

async function executeTools(
    contentBlocks: ContentBlock[],
    _signal?: AbortSignal,
): Promise<MessageParam> {
    const results: ToolResultBlock[] = [];
    for (const block of contentBlocks) {
        if (block.type !== "tool_use") continue;
        results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `[Tool "${block.name}" not implemented]`,
        });
    }
    return { role: "user", content: results } as MessageParam;
}

export function App({model, system, toolsApiParams}: AppProps): React.ReactNode {
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

    // 中断控制（不触发重渲染，用 useRef）
    const abortRef = useRef<AbortController | null>(null);
    const messagesRef = useRef<MessageParam[]>([]);
    messagesRef.current = messages;

    useInput((input, key) => {
        // Ctrl+C：中断当前请求
        if (key.ctrl && input === "c") {
            if (abortRef.current) {
                abortRef.current.abort();
                abortRef.current = null;
                setIsLoading(false);
                setStreamingText("");
                setInfoMessage("Interrupted.");
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

    const runStreamingTurn = useCallback(
        async (
            currentMessages: MessageParam[],
            signal?: AbortSignal,
        ): Promise<StreamResult | null> => {
            const generator = streamMessage({
                messages: [...currentMessages],
                model,
                system,
                tools: toolsApiParams.length > 0 ? toolsApiParams : undefined,
                signal,
            });

            let accumulatedText = "";

            while (true) {
                const {value, done} = await generator.next();
                if (done) return value ?? null;

                const event = value as StreamEvent;
                switch (event.type) {
                    case "text":
                        accumulatedText += event.text;
                        setStreamingText(accumulatedText);  // 触发重渲染，终端实时更新
                        break;
                    case "tool_use_start":
                        setToolCalls((prev) => [...prev, {name: event.name}]);
                        break;
                    case "error":
                        setErrorText(event.error.message);
                        return null;
                }
            }
        },
        [model, system, toolsApiParams],
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

            // 追加 user message，创建本轮消息数组
            const userMsg: MessageParam = {role: "user", content: trimmed};
            let loopMessages = [...messagesRef.current, userMsg];
            setMessages(loopMessages);
            messagesRef.current = loopMessages;

            const abort = new AbortController();
            abortRef.current = abort;

            let totalIn = 0;
            let totalOut = 0;

            try {
                let turnCount = 0;
                // Agentic Loop：AI 调用工具 → 执行 → 结果喂回去 → 循环
                while (turnCount < MAX_TOOL_TURNS) {
                    turnCount++;
                    setStreamingText("");

                    const result = await runStreamingTurn(loopMessages, abort.signal);
                    if (!result || abort.signal.aborted) break;

                    totalIn += result.usage.input_tokens;
                    totalOut += result.usage.output_tokens;

                    // 追加 assistant message
                    const assistantMsg: MessageParam = {
                        role: "assistant",
                        content: result.assistantMessage.content as any,
                    };
                    loopMessages = [...loopMessages, assistantMsg];
                    setMessages(loopMessages);
                    messagesRef.current = loopMessages;

                    // 如果 AI 想调工具 → 执行工具 → 追加 tool_result → 继续循环
                    if (result.stopReason === "tool_use") {
                        const contentBlocks = result.assistantMessage.content;
                        if (Array.isArray(contentBlocks)) {
                            const toolResultMsg = await executeTools(contentBlocks, abort.signal);
                            loopMessages = [...loopMessages, toolResultMsg];
                            setMessages(loopMessages);
                            messagesRef.current = loopMessages;
                            setSpinnerLabel("Thinking");
                            continue;
                        }
                    }
                    break;  // stop_reason 不是 tool_use → 对话结束
                }

                setLastUsage({input: totalIn, output: totalOut});
            } catch (err: unknown) {
                if (err instanceof Error && err.name === "AbortError") {
                    setInfoMessage("Interrupted.");
                } else {
                    setErrorText(err instanceof Error ? err.message : String(err));
                }
            } finally {
                setIsLoading(false);
                abortRef.current = null;
            }
        },
        [exit, runStreamingTurn, executeTools],
    );

    return (
        <Box flexDirection="column" paddingX={1}>
            {/* 头部 */}
            <Box marginBottom={1}>
                <Text bold color="cyan">Easy Agent</Text>
                <Text dimColor> ({model})</Text>
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
                <Box key={`tc${i}`} marginLeft={2}>
                    {tc.resultLength !== undefined
                        ? <Text color="green">{"✓ "}{tc.name} ({tc.resultLength} chars)</Text>
                        : <Text color="yellow">{"⚡ Using tool: "}{tc.name}</Text>}
                </Box>
            ))}

            {/* Spinner：等待 API 响应时显示 */}
            {isLoading && !streamingText && <Spinner label={spinnerLabel}/>}

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
            {!isLoading && (
                <Box marginTop={1}>
                    <Text color="green" bold>{"❯ "}</Text>
                    <Text>{inputValue}</Text>
                    <Text dimColor>▋</Text>
                </Box>
            )}
        </Box>
    );

}