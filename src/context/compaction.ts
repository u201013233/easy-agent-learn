import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";
import { buildTokenBudgetSnapshot } from "./tokens.js";

// ─── MicroCompact ───────────────────────────────────────────

const MICROCOMPACT_MIN_MESSAGES = 10;
const MICROCOMPACT_KEEP_RECENT_TOOL_MESSAGES = 8;
const COMPACTABLE_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const CLEARED_PLACEHOLDER = "[Old tool result content cleared]";

/**
 * Count how many tool messages (tool_use or tool_result) are in a message.
 */
function countToolBlocks(message: MessageParam): number {
  const content = message.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((b: any) => b.type === "tool_use" || b.type === "tool_result").length;
}

/**
 * Count total tool blocks in messages[start..end].
 */
function countToolBlocksInRange(messages: MessageParam[], start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) {
    count += countToolBlocks(messages[i]);
  }
  return count;
}

/**
 * Find the message index where the last N tool messages begin.
 * Returns the index of the first message that should be preserved.
 */
function findToolMessageBoundary(messages: MessageParam[], keepRecent: number): number {
  const totalToolBlocks = countToolBlocksInRange(messages, 0, messages.length);

  if (totalToolBlocks <= keepRecent) return 0;

  const target = totalToolBlocks - keepRecent;
  let accumulated = 0;

  for (let i = 0; i < messages.length; i++) {
    accumulated += countToolBlocks(messages[i]);
    if (accumulated >= target) return i;
  }

  return messages.length;
}

function microCompactMessage(message: MessageParam): { message: MessageParam; cleared: boolean } {
  if (!Array.isArray(message.content)) return { message, cleared: false };

  let cleared = false;
  const content = message.content.map((block: any) => {
    if (block.type !== "tool_result" || typeof block.content !== "string") return block;

    const toolName = block.content.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) return block;

    cleared = true;
    return { ...block, content: CLEARED_PLACEHOLDER };
  });

  return { message: { ...message, content }, cleared };
}

export function microCompactMessages(messages: MessageParam[]): { messages: MessageParam[]; didClear: boolean } {
  if (messages.length < MICROCOMPACT_MIN_MESSAGES) return { messages, didClear: false };

  const boundary = findToolMessageBoundary(messages, MICROCOMPACT_KEEP_RECENT_TOOL_MESSAGES);

  let didClear = false;
  const result = messages.map((msg, i) => {
    if (i >= boundary) return msg;
    const { message, cleared } = microCompactMessage(msg);
    if (cleared) didClear = true;
    return message;
  });

  return { messages: result, didClear };
}

// ─── Tail Preservation ───────────────────────────────────────

/**
 * Find a safe start index for the preserved tail.
 * Must not split a tool_use / tool_result pair.
 */
function findSafeTailStart(messages: MessageParam[], desiredCount: number): number {
  let start = Math.max(0, messages.length - desiredCount);

  while (start > 0) {
    const tail = messages.slice(start);
    const useIds = new Set<string>();
    const resultIds = new Set<string>();

    for (const msg of tail) {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content as any[]) {
        if (b.type === "tool_use") useIds.add(b.id);
        if (b.type === "tool_result") resultIds.add(b.tool_use_id);
      }
    }

    const hasDangling = [...resultIds].some((id) => !useIds.has(id));
    if (!hasDangling) return start;
    start--;
  }

  return 0;
}

// ─── Full Compaction ─────────────────────────────────────────

const COMPACT_SYSTEM_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Your task is to create a detailed summary of the conversation so far.
Capture: user requests, technical decisions, file names, code snippets,
errors encountered, pending tasks, and what was being worked on most recently.
Wrap your analysis in <analysis> tags, then provide the final <summary>.`;

type CallModelFn = (system: string, messages: MessageParam[]) => Promise<string>;

export interface CompactOptions {
  usage?: Usage;
  usageAnchorIndex?: number;
  focus?: string;
  force?: boolean;
}

export interface CompactResult {
  messages: MessageParam[];
  summary?: string;
  didCompact: boolean;
  didMicroCompact: boolean;
}

const PRESERVE_TAIL_TOOL_MESSAGES = 8;

export async function compactMessages(
  messages: MessageParam[],
  callModel: CallModelFn,
  options?: CompactOptions,
): Promise<CompactResult> {
  // Step 1: micro-compact first (free)
  const { messages: microCompacted, didClear } = microCompactMessages(messages);

  // Step 2: check budget
  const budget = buildTokenBudgetSnapshot(microCompacted, options);
  if (!options?.force && budget.estimatedTokens < budget.autoCompactThreshold) {
    return { messages: microCompacted, didCompact: false, didMicroCompact: didClear };
  }

  // Step 3: generate summary via model
  const focusSuffix = options?.focus ? `\n\nFocus specifically on: ${options.focus}` : "";
  const summaryPrompt = COMPACT_SYSTEM_PROMPT + focusSuffix;

  const summary = await callModel(summaryPrompt, [
    { role: "user", content: `Conversation to summarize:\n${JSON.stringify(microCompacted, null, 2)}` },
  ]);

  // Step 4: preserve tail (last 8 tool messages, not general messages)
  const tailStart = findToolMessageBoundary(microCompacted, PRESERVE_TAIL_TOOL_MESSAGES);
  const tail = microCompacted.slice(tailStart);

  // Step 5: assemble compacted message list
  const compacted: MessageParam[] = [
    {
      role: "user",
      content: [
        "This session is being continued from a previous conversation that ran out of context.",
        `The summary below covers the earlier portion of the conversation.\n\n${summary}`,
        tail.length > 0 ? "\nRecent messages are preserved verbatim." : "",
      ].filter(Boolean).join(" "),
    },
    {
      role: "assistant",
      content: `[CompactBoundary] type=auto messages=${microCompacted.length}`,
    },
    ...tail,
  ];

  return { messages: compacted, summary, didCompact: true, didMicroCompact: didClear };
}
