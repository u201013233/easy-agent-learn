import type { MessageParam, Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages.js";
import { streamMessage } from "../services/stream.js";
import type { LoopEvent, LoopTerminationReason, Usage, ContentBlock, ToolUseBlock, ToolResultBlock } from "../types/message.js";
import { findToolByName } from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";

// ─── Types ──────────────────────────────────────────────────────

export interface QueryParams {
  messages: MessageParam[];
  model: string;
  system?: string;
  tools?: AnthropicTool[];
  signal?: AbortSignal;
  toolContext?: ToolContext;
  maxTurns?: number;
}

export interface QueryResult {
  messages: MessageParam[];
  usage: Usage;
  terminationReason: LoopTerminationReason;
  turnCount: number;
}

// ─── Loop State ─────────────────────────────────────────────────

interface LoopState {
  messages: MessageParam[];
  turnCount: number;
  aborted: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 50;

// ─── Core: query() ──────────────────────────────────────────────

export async function* query(
  params: QueryParams,
): AsyncGenerator<LoopEvent, QueryResult> {
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const toolContext: ToolContext = params.toolContext ?? { cwd: process.cwd() };

  let state: LoopState = {
    messages: [...params.messages],
    turnCount: 0,
    aborted: false,
  };

  const totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };

  while (state.turnCount < maxTurns) {
    // 1. Check abort
    if (params.signal?.aborted) {
      state = { ...state, aborted: true };
      return {
        messages: state.messages,
        usage: totalUsage,
        terminationReason: "aborted",
        turnCount: state.turnCount,
      };
    }

    state = { ...state, turnCount: state.turnCount + 1 };
    process.stderr.write(`[loop] turn ${state.turnCount}/${maxTurns}, messages: ${state.messages.length}\n`);

    // 2. Call streamMessage()
    let result;
    try {
      const generator = streamMessage({
        messages: state.messages,
        model: params.model,
        system: params.system,
        tools: params.tools,
        signal: params.signal,
      });

      // 3. Yield streaming events, collect assistant message
      let done = false;
      while (!done) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          done = true;
          continue;
        }

        const event = next.value;

        // Propagate stream events to UI
        yield event;

        // If aborted during streaming, stop
        if (params.signal?.aborted) {
          state = { ...state, aborted: true };
          return {
            messages: state.messages,
            usage: totalUsage,
            terminationReason: "aborted",
            turnCount: state.turnCount,
          };
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield { type: "error", error };
      return {
        messages: state.messages,
        usage: totalUsage,
        terminationReason: "model_error",
        turnCount: state.turnCount,
      };
    }

    if (!result) {
      yield { type: "error", error: new Error("streamMessage returned no result") };
      return {
        messages: state.messages,
        usage: totalUsage,
        terminationReason: "model_error",
        turnCount: state.turnCount,
      };
    }

    // Accumulate usage
    totalUsage.input_tokens += result.usage.input_tokens;
    totalUsage.output_tokens += result.usage.output_tokens;

    // 4. Append assistant message
    const assistantMsg: MessageParam = {
      role: "assistant",
      content: result.assistantMessage.content as MessageParam["content"],
    };
    state = {
      ...state,
      messages: [...state.messages, assistantMsg],
    };
    yield { type: "assistant_message", message: assistantMsg };

    // 6. If not tool_use → completed
    if (result.stopReason !== "tool_use") {
      process.stderr.write(`[loop] completed (stopReason: ${result.stopReason}), turns: ${state.turnCount}, tokens: ${totalUsage.input_tokens}in/${totalUsage.output_tokens}out\n`);
      return {
        messages: state.messages,
        usage: totalUsage,
        terminationReason: "completed",
        turnCount: state.turnCount,
      };
    }

    // 7. Execute tools
    const contentBlocks = result.assistantMessage.content;
    if (!Array.isArray(contentBlocks)) {
      return {
        messages: state.messages,
        usage: totalUsage,
        terminationReason: "completed",
        turnCount: state.turnCount,
      };
    }

    try {
      // Yield tool_use_call events (with full input) before executing
      for (const block of contentBlocks) {
        if (block.type === "tool_use") {
          const tb = block as ToolUseBlock;
          yield { type: "tool_use_call", id: tb.id, name: tb.name, input: tb.input };
        }
      }

      const toolResultMsg = await runTools(contentBlocks, toolContext, params.signal);
      state = {
        ...state,
        messages: [...state.messages, toolResultMsg.message],
      };

      // 8. Yield tool_use_done events and tool_result_message
      for (const detail of toolResultMsg.details) {
        yield {
          type: "tool_use_done",
          id: detail.id,
          name: detail.name,
          resultLength: detail.resultLength,
          isError: detail.isError,
        };
      }
      yield { type: "tool_result_message", message: toolResultMsg.message };

      // Continue to next turn
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield { type: "error", error };
      return {
        messages: state.messages,
        usage: totalUsage,
        terminationReason: "model_error",
        turnCount: state.turnCount,
      };
    }
  }

  // max_turns reached
  process.stderr.write(`[loop] max_turns (${maxTurns}) reached\n`);
  return {
    messages: state.messages,
    usage: totalUsage,
    terminationReason: "max_turns",
    turnCount: state.turnCount,
  };
}

// ─── Tool Execution ─────────────────────────────────────────────

interface ToolExecutionDetail {
  id: string;
  name: string;
  resultLength: number;
  isError?: boolean;
}

interface ToolExecutionResult {
  message: MessageParam;
  details: ToolExecutionDetail[];
}

async function runTools(
  contentBlocks: ContentBlock[],
  toolContext: ToolContext,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const results: ToolResultBlock[] = [];
  const details: ToolExecutionDetail[] = [];

  for (const block of contentBlocks) {
    if (block.type !== "tool_use") continue;

    // Check abort before each tool
    if (signal?.aborted) break;

    const toolUseBlock = block as ToolUseBlock;
    const tool = findToolByName(toolUseBlock.name);

    if (!tool) {
      process.stderr.write(`[tool] not found: ${toolUseBlock.name}\n`);
      const errorContent = `Tool "${toolUseBlock.name}" not found`;
      results.push({
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: errorContent,
        is_error: true,
      });
      details.push({
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        resultLength: errorContent.length,
        isError: true,
      });
      continue;
    }

    process.stderr.write(`[tool] calling ${toolUseBlock.name}(${JSON.stringify(toolUseBlock.input)})\n`);

    try {
      const toolResult = await tool.call(toolUseBlock.input, toolContext);
      process.stderr.write(`[tool] ${toolUseBlock.name} → ${toolResult.isError ? "ERROR" : "ok"} (${toolResult.content.length} chars)\n`);
      results.push({
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: toolResult.content,
        is_error: toolResult.isError,
      });
      details.push({
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        resultLength: toolResult.content.length,
        isError: toolResult.isError,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tool] ${toolUseBlock.name} threw: ${errMsg}\n`);
      const errorContent = `Error executing ${toolUseBlock.name}: ${errMsg}`;
      results.push({
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: errorContent,
        is_error: true,
      });
      details.push({
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        resultLength: errorContent.length,
        isError: true,
      });
    }
  }

  return {
    message: { role: "user", content: results } as MessageParam,
    details,
  };
}