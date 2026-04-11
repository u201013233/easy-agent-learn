import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { getAnthropicClient, DEFAULT_MODEL, DEFAULT_MAX_TOKENS } from "./client.js";
import type { AssistantMessage, TextBlock, ContentBlock, StreamEvent, Usage, StreamMessageStartEvent, StreamTextEvent, StreamToolUseInputEvent, StreamToolUseStartEvent } from "../types/message.js";
import constants from "node:constants";


// ─── Request Parameters ────────────────────────────────────────────

export interface StreamRequestParams {
  messages: MessageParam[];
  model?: string;
  maxTokens?: number;
  system?: string;
  tools?: Anthropic.Tool[];
  signal?: AbortSignal;
}

// ─── Streaming Result ──────────────────────────────────────────────

export interface StreamResult {
  assistantMessage: AssistantMessage;
  usage: Usage;
  stopReason: string;
}


export async function* streamMessage(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
    const client = getAnthropicClient();
    const model = params.model ?? DEFAULT_MODEL;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Build the API request
    const requestParams: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: maxTokens,
    messages: params.messages,
    stream: true,
    ...(params.system && { system: params.system }),
    ...(params.tools && params.tools.length > 0 && { tools: params.tools }),
  };

    // Initiate the stream
  const stream = client.messages.stream(requestParams, {
    signal: params.signal,
  });

  const contentBlocks: ContentBlock[] = [];
  let currentToolInputJson = "";
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "";

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        usage.input_tokens = event.message.usage.input_tokens;
        yield { type: "message_start", messageId: event.message.id };
        break;

      case "content_block_start":
        if (event.content_block.type === "text") {
          contentBlocks[event.index] = { type: "text", text: "" };
        } else if (event.content_block.type === "tool_use") {
          const b = event.content_block;
          contentBlocks[event.index] = {
            type: "tool_use", id: b.id, name: b.name, input: {},
          };
          currentToolInputJson = "";
          yield { type: "tool_use_start", id: b.id, name: b.name };
        }
        break;

      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          (contentBlocks[event.index] as TextBlock).text += event.delta.text;
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          currentToolInputJson += event.delta.partial_json;
        }
        break;

      case "content_block_stop":
        // 工具参数的 JSON 是碎片化到达的，在 block 结束时才能 parse
        const block = contentBlocks[event.index];
        if (block?.type === "tool_use" && currentToolInputJson) {
          block.input = JSON.parse(currentToolInputJson);
          currentToolInputJson = "";
        }
        break;

      case "message_delta":
        usage.output_tokens = event.usage.output_tokens;
        stopReason = event.delta.stop_reason ?? "";
        break;

      case "message_stop":
        yield { type: "message_done", stopReason, usage };
        break;
    }
  }

  return {
    assistantMessage: { role: "assistant", content: contentBlocks },
    usage,
    stopReason,
  };
}