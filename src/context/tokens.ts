import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";

// ─── Constants ──────────────────────────────────────────────

const TEXT_CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 2;
const MESSAGE_OVERHEAD_TOKENS = 12;
const TOOL_BLOCK_OVERHEAD_TOKENS = 24;
const FIXED_BINARY_BLOCK_TOKENS = 2_000;

export const MODEL_CONTEXT_WINDOW = 200_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

// ─── Token Estimation ───────────────────────────────────────

function roughTokenCount(content: string, charsPerToken = TEXT_CHARS_PER_TOKEN): number {
  return Math.max(1, Math.round(content.length / charsPerToken));
}

function estimateContentBlockTokens(content: string | unknown[]): number {
  if (typeof content === "string") return roughTokenCount(content);
  if (!Array.isArray(content)) return 0;

  return content.reduce((total: number, block: any) => {
    switch (block.type) {
      case "text":
        return total + roughTokenCount(block.text);
      case "tool_use":
        return total + TOOL_BLOCK_OVERHEAD_TOKENS +
          roughTokenCount(block.name) +
          roughTokenCount(JSON.stringify(block.input ?? {}), JSON_CHARS_PER_TOKEN);
      case "tool_result": {
        const s = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        return total + TOOL_BLOCK_OVERHEAD_TOKENS + roughTokenCount(s, JSON_CHARS_PER_TOKEN);
      }
      case "image":
      case "document":
        return total + FIXED_BINARY_BLOCK_TOKENS;
      default:
        return total + roughTokenCount(JSON.stringify(block), JSON_CHARS_PER_TOKEN);
    }
  }, 0);
}

export function estimateMessageTokens(message: MessageParam): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentBlockTokens(message.content as any);
}

export function estimateMessagesTokens(messages: readonly MessageParam[]): number {
  const raw = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  return Math.ceil((raw * 4) / 3); // conservative 33% bump
}

// ─── Hybrid Estimation with API Usage Anchor ──────────────

export function tokenCountWithEstimation(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number },
): number {
  const { usage, usageAnchorIndex } = options ?? {};

  if (usage && usageAnchorIndex !== undefined && usageAnchorIndex >= 0) {
    const knownTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      usage.output_tokens;
    const suffix = messages.slice(usageAnchorIndex + 1);
    return knownTokens + estimateMessagesTokens(suffix);
  }

  return estimateMessagesTokens(messages);
}

// ─── Token Budget Snapshot ──────────────────────────────────

export interface TokenBudgetSnapshot {
  estimatedTokens: number;
  contextWindow: number;
  effectiveWindow: number;
  autoCompactThreshold: number;
}

export function buildTokenBudgetSnapshot(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number },
): TokenBudgetSnapshot {
  const estimatedTokens = tokenCountWithEstimation(messages, options);
  const effectiveWindow = MODEL_CONTEXT_WINDOW - 20_000; // reserve for system prompt
  const snapshot = {
    estimatedTokens,
    contextWindow: MODEL_CONTEXT_WINDOW,
    effectiveWindow,
    autoCompactThreshold: effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS,
  };
  return snapshot;
}

