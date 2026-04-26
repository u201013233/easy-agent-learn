import type { MessageParam, Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages.js";
import { query } from "./agenticLoop.js";
import type { LoopEvent, Usage } from "../types/message.js";
import { buildSystemPrompt } from "../context/systemPrompt.js";
import { getToolsApiParams } from "../tools/index.js";
import type { PermissionMode, PermissionRequest, PermissionBehavior } from "../permissions/types.js";
import {
  createSessionId,
  initSession,
  appendEntry,
  createMessageEntry,
  createToolEventEntry,
  createUsageEntry,
  createSystemEntry,
  formatSessionHistory,
} from "../session/index.js";

// ─── Types ──────────────────────────────────────────────────

export interface QueryEngineState {
  messages: MessageParam[];
  totalUsage: Usage;
  activeModel: string;
  isProcessing: boolean;
}

export interface MessagesUpdatedEvent {
  type: "messages_updated";
  messages: MessageParam[];
}

export interface UsageUpdatedEvent {
  type: "usage_updated";
  totalUsage: Usage;
  turnUsage: Usage;
}

export interface CommandEvent {
  type: "command";
  kind: "info" | "error";
  message: string;
}

export interface ModelChangedEvent {
  type: "model_changed";
  model: string;
}

export interface SessionResumedEvent {
  type: "session_resumed";
  sessionId: string;
  messageCount: number;
}

export type QueryEngineEvent =
  | LoopEvent
  | MessagesUpdatedEvent
  | UsageUpdatedEvent
  | CommandEvent
  | ModelChangedEvent
  | SessionResumedEvent;

export interface SubmitResult {
  handled: boolean;
  terminationReason?: string;
}

export interface QueryEngineOptions {
  model: string;
  toolContext: { cwd: string };
  permissionMode?: PermissionMode;
  sessionId?: string;
  initialMessages?: MessageParam[];
  initialUsage?: Usage;
}

// ─── QueryEngine ──────────────────────────────────────────────

export class QueryEngine {
  private messages: MessageParam[];
  private totalUsage: Usage;
  private readonly sessionId: string;
  private readonly defaultModel: string;
  private sessionModelOverride: string | null = null;
  private readonly toolContext: { cwd: string };
  private permissionMode: PermissionMode;
  private sessionAllowRules: string[] = [];
  private abortController: AbortController | null = null;
  private onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionBehavior>;
  private readonly isResumed: boolean;

  constructor(options: QueryEngineOptions) {
    this.defaultModel = options.model;
    this.toolContext = options.toolContext;
    this.permissionMode = options.permissionMode ?? "default";
    this.sessionId = options.sessionId ?? createSessionId();
    this.messages = [...(options.initialMessages ?? [])];
    this.totalUsage = options.initialUsage
      ? { ...options.initialUsage }
      : { input_tokens: 0, output_tokens: 0 };
    this.isResumed = (options.initialMessages?.length ?? 0) > 0;

    // Initialize session storage
    if (!this.isResumed) {
      void initSession({
        sessionId: this.sessionId,
        cwd: this.toolContext.cwd,
        startedAt: new Date().toISOString(),
        model: this.getActiveModel(),
      });
    }
  }

  // ─── Public API ──────────────────────────────────────────────

  getSessionId(): string {
    return this.sessionId;
  }

  getIsResumed(): boolean {
    return this.isResumed;
  }

  getActiveModel(): string {
    return this.sessionModelOverride ?? this.defaultModel;
  }

  getState(): QueryEngineState {
    return {
      messages: [...this.messages],
      totalUsage: { ...this.totalUsage },
      activeModel: this.getActiveModel(),
      isProcessing: this.abortController !== null,
    };
  }

  setOnPermissionRequest(handler: (request: PermissionRequest) => Promise<PermissionBehavior>): void {
    this.onPermissionRequest = handler;
  }

  addSessionAllowRule(rule: string): void {
    this.sessionAllowRules = [...this.sessionAllowRules, rule];
  }

  static COMMANDS = ["/help", "/clear", "/cost", "/model", "/history"] as const;

  interrupt(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    this.abortController = null;
    return true;
  }

  // ─── Submit Message ───────────────────────────────────────────

  async *submitMessage(input: string): AsyncGenerator<QueryEngineEvent, SubmitResult> {
    const text = input.trim();
    if (!text) return { handled: false };

    // Slash commands
    if (text.startsWith("/")) {
      return yield* this.handleCommand(text);
    }

    // 1. Append user message
    const userMsg: MessageParam = { role: "user", content: text };
    this.messages = [...this.messages, userMsg];
    yield { type: "messages_updated", messages: [...this.messages] };

    // Persist user message
    void appendEntry(this.toolContext.cwd, this.sessionId, createMessageEntry({ role: "user", message: userMsg }));

    // 2. Create abort controller for this turn
    this.abortController = new AbortController();

    // 3. Build system prompt (dynamic, each turn)
    const systemPrompt = await buildSystemPrompt({ cwd: this.toolContext.cwd });

    // 4. Get tools
    const tools: AnthropicTool[] = getToolsApiParams();

    // 5. Start single-turn Agentic Loop
    const loop = query({
      messages: [...this.messages],
      model: this.getActiveModel(),
      system: systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      signal: this.abortController.signal,
      toolContext: this.toolContext,
      permissionMode: this.permissionMode,
      sessionAllowRules: this.sessionAllowRules,
      onPermissionRequest: this.onPermissionRequest,
    });

    // 6. Consume loop events, sync session state
    while (true) {
      const { value, done } = await loop.next();
      if (done) {
        const result = value;
        this.messages = [...result.messages];
        this.totalUsage.input_tokens += result.usage.input_tokens;
        this.totalUsage.output_tokens += result.usage.output_tokens;

        yield { type: "usage_updated", totalUsage: { ...this.totalUsage }, turnUsage: { ...result.usage } };

        // Persist usage
        void appendEntry(this.toolContext.cwd, this.sessionId, createUsageEntry({
          turn: result.usage,
          total: { ...this.totalUsage },
        }));

        return { handled: true, terminationReason: result.terminationReason };
      }

      // Forward all loop events to UI
      yield value as QueryEngineEvent;

      // Sync message state from assistant/tool_result events
      if (value.type === "assistant_message" || value.type === "tool_result_message") {
        this.messages = [...this.messages, value.message];
        yield { type: "messages_updated", messages: [...this.messages] };

        // Persist assistant message
        if (value.type === "assistant_message") {
          void appendEntry(this.toolContext.cwd, this.sessionId, createMessageEntry({ role: "assistant", message: value.message }));
        }
      }

      // Persist tool events
      if (value.type === "tool_use_done") {
        void appendEntry(this.toolContext.cwd, this.sessionId, createToolEventEntry({
          name: value.name,
          phase: "done",
          resultLength: value.resultLength,
          isError: value.isError,
        }));
      }
    }
  }

  // ─── Slash Commands ────────────────────────────────────────────

  private async *handleCommand(command: string): AsyncGenerator<QueryEngineEvent, SubmitResult> {
    // /help
    if (command === "/help") {
      const helpText = [
        "Commands:",
        ...QueryEngine.COMMANDS.map((cmd) => {
          switch (cmd) {
            case "/help": return "  /help          Show this help message";
            case "/clear": return "  /clear         Clear conversation history";
            case "/cost": return "  /cost          Show total token usage";
            case "/model": return "  /model [name]   Show or switch model";
            case "/history": return "  /history       Show project session history";
            default: return `  ${cmd}`;
          }
        }),
      ].join("\n");
      yield { type: "command", kind: "info", message: helpText };
      return { handled: true };
    }

    // /clear
    if (command === "/clear") {
      this.messages = [];
      yield { type: "messages_updated", messages: [] };
      yield { type: "command", kind: "info", message: "Conversation cleared." };
      void appendEntry(this.toolContext.cwd, this.sessionId, createSystemEntry({ level: "info", message: "Conversation cleared." }));
      return { handled: true };
    }

    // /cost
    if (command === "/cost") {
      yield {
        type: "command",
        kind: "info",
        message: `Session usage: ${this.totalUsage.input_tokens.toLocaleString()} input / ${this.totalUsage.output_tokens.toLocaleString()} output tokens`,
      };
      return { handled: true };
    }

    // /model
    if (command === "/model") {
      yield {
        type: "model_changed",
        model: this.getActiveModel(),
      };
      yield {
        type: "command",
        kind: "info",
        message: `Active model: ${this.getActiveModel()}`,
      };
      return { handled: true };
    }

    if (command.startsWith("/model ")) {
      const modelArg = command.slice("/model ".length).trim();
      if (modelArg === "default") {
        this.sessionModelOverride = null;
      } else {
        this.sessionModelOverride = modelArg;
      }
      yield { type: "model_changed", model: this.getActiveModel() };
      yield {
        type: "command",
        kind: "info",
        message: `Active model: ${this.getActiveModel()}`,
      };
      return { handled: true };
    }

    // /history
    if (command === "/history") {
      try {
        const historyText = await formatSessionHistory(this.toolContext.cwd);
        yield { type: "command", kind: "info", message: historyText };
      } catch {
        yield { type: "command", kind: "info", message: `${this.messages.length} messages in current session.` };
      }
      return { handled: true };
    }

    // /exit / /quit
    if (command === "/exit" || command === "/quit") {
      yield { type: "command", kind: "info", message: "Use Ctrl+D or close the terminal to exit." };
      return { handled: true };
    }

    // Unknown command
    yield { type: "command", kind: "error", message: `Unknown command: ${command}` };
    return { handled: true };
  }
}
