import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";

// ─── Constants ──────────────────────────────────────────────

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
export const PROJECTS_DIR = path.join(EASY_AGENT_HOME, "projects");
const MAX_SESSIONS = 20;

// ─── Types ──────────────────────────────────────────────────

export type TranscriptEntry =
  | { type: "session_meta"; sessionId: string; cwd: string; startedAt: string; model: string }
  | { type: "message"; timestamp: string; role: "user" | "assistant"; message: MessageParam }
  | { type: "tool_event"; timestamp: string; name: string; phase: "start" | "done"; resultLength?: number; isError?: boolean }
  | { type: "usage"; timestamp: string; turn: Usage; total: Usage }
  | { type: "system"; timestamp: string; level: "info" | "error"; message: string };

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  totalUsage: Usage;
}

export interface SessionPaths {
  rootDir: string;
  projectDir: string;
  transcriptPath: string;
  latestPath: string;
}

// ─── Helpers ────────────────────────────────────────────────

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0 };
}

function isUsage(value: unknown): value is Usage {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Usage).input_tokens === "number" &&
      typeof (value as Usage).output_tokens === "number",
  );
}

function isMessageParam(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      ((value as MessageParam).role === "user" || (value as MessageParam).role === "assistant") &&
      "content" in (value as MessageParam),
  );
}

// ─── Session ID & Paths ─────────────────────────────────────

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function getProjectHash(cwd: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 16);
}

export function getSessionPaths(cwd: string, sessionId: string): SessionPaths {
  const projectHash = getProjectHash(cwd);
  const projectDir = path.join(PROJECTS_DIR, projectHash);
  return {
    rootDir: EASY_AGENT_HOME,
    projectDir,
    transcriptPath: path.join(projectDir, sessionId + ".jsonl"),
    latestPath: path.join(projectDir, "latest"),
  };
}

async function ensureProjectDir(paths: SessionPaths): Promise<void> {
  await fs.mkdir(paths.projectDir, { recursive: true });
}

// ─── Entry Factories ────────────────────────────────────────

export function createSessionMetaEntry(params: {
  sessionId: string;
  cwd: string;
  startedAt: string;
  model: string;
}): TranscriptEntry {
  return { type: "session_meta", ...params };
}

export function createMessageEntry(params: {
  role: "user" | "assistant";
  message: MessageParam;
  timestamp?: string;
}): TranscriptEntry {
  return { type: "message", timestamp: params.timestamp ?? new Date().toISOString(), ...params };
}

export function createToolEventEntry(params: {
  name: string;
  phase: "start" | "done";
  resultLength?: number;
  isError?: boolean;
  timestamp?: string;
}): TranscriptEntry {
  return {
    type: "tool_event",
    timestamp: params.timestamp ?? new Date().toISOString(),
    name: params.name,
    phase: params.phase,
    ...(typeof params.resultLength === "number" ? { resultLength: params.resultLength } : {}),
    ...(typeof params.isError === "boolean" ? { isError: params.isError } : {}),
  };
}

export function createUsageEntry(params: {
  turn: Usage;
  total: Usage;
  timestamp?: string;
}): TranscriptEntry {
  return { type: "usage", timestamp: params.timestamp ?? new Date().toISOString(), ...params };
}

export function createSystemEntry(params: {
  level: "info" | "error";
  message: string;
  timestamp?: string;
}): TranscriptEntry {
  return { type: "system", timestamp: params.timestamp ?? new Date().toISOString(), ...params };
}

// ─── Write Operations ───────────────────────────────────────

export async function initSession(metadata: {
  sessionId: string;
  cwd: string;
  startedAt: string;
  model: string;
}): Promise<SessionPaths> {
  const paths = getSessionPaths(metadata.cwd, metadata.sessionId);
  await ensureProjectDir(paths);

  const entry = createSessionMetaEntry(metadata);
  await fs.writeFile(paths.transcriptPath, JSON.stringify(entry) + "\n", "utf-8");
  await fs.writeFile(paths.latestPath, metadata.sessionId + "\n", "utf-8");

  return paths;
}

export async function appendEntry(cwd: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
  const paths = getSessionPaths(cwd, sessionId);
  await ensureProjectDir(paths);
  await fs.appendFile(paths.transcriptPath, JSON.stringify(entry) + "\n", "utf-8");
  await fs.writeFile(paths.latestPath, sessionId + "\n", "utf-8");
}

// ─── Read Operations ────────────────────────────────────────

export function parseJsonLine(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line);

    if (parsed.type === "session_meta" && parsed.sessionId && parsed.cwd && parsed.startedAt && parsed.model) {
      return { type: "session_meta", sessionId: parsed.sessionId, cwd: parsed.cwd, startedAt: parsed.startedAt, model: parsed.model };
    }

    if (parsed.type === "message" && typeof parsed.timestamp === "string" && (parsed.role === "user" || parsed.role === "assistant") && isMessageParam(parsed.message)) {
      return parsed;
    }

    if (parsed.type === "tool_event" && typeof parsed.timestamp === "string" && typeof parsed.name === "string" && (parsed.phase === "start" || parsed.phase === "done")) {
      return parsed;
    }

    if (parsed.type === "usage" && typeof parsed.timestamp === "string" && isUsage(parsed.turn) && isUsage(parsed.total)) {
      return parsed;
    }

    if (parsed.type === "system" && typeof parsed.timestamp === "string" && (parsed.level === "info" || parsed.level === "error") && typeof parsed.message === "string") {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

export async function readTranscript(filePath: string): Promise<TranscriptEntry[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((e): e is TranscriptEntry => e !== null);
}

// ─── Session Restore ────────────────────────────────────────

export async function getLatestSessionId(cwd: string): Promise<string | null> {
  const { latestPath } = getSessionPaths(cwd, "placeholder");
  try {
    const value = (await fs.readFile(latestPath, "utf-8")).trim();
    return value || null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function getLastUpdatedAt(entries: TranscriptEntry[], fallback: string): string {
  const reversed = [...entries].reverse();
  const latest = reversed.find((e) => "timestamp" in e && typeof (e as any).timestamp === "string");
  return (latest as any)?.timestamp ?? fallback;
}

export interface RestoredSession {
  summary: SessionSummary;
  messages: MessageParam[];
}

export async function restoreSession(cwd: string, sessionId?: string | null): Promise<RestoredSession> {
  const resolvedId = sessionId ?? await getLatestSessionId(cwd);
  if (!resolvedId) {
    throw new Error("No saved session found for this project.");
  }

  const { transcriptPath } = getSessionPaths(cwd, resolvedId);
  const entries = await readTranscript(transcriptPath);
  if (entries.length === 0) {
    throw new Error("Session is empty or unreadable.");
  }

  const meta = entries.find((e) => e.type === "session_meta");
  if (!meta || meta.type !== "session_meta") {
    throw new Error("Session is missing metadata.");
  }

  const messages = entries
    .filter((e): e is Extract<TranscriptEntry, { type: "message" }> => e.type === "message")
    .map((e) => e.message);

  // If this session has no messages and no sessionId was specified, find the latest non-empty session
  if (messages.length === 0 && sessionId == null) {
    const sessions = await listProjectSessions(cwd);
    const nonEmpty = sessions.find((s) => s.messageCount > 0);
    if (nonEmpty) {
      return restoreSession(cwd, nonEmpty.sessionId);
    }
  }

  const latestUsage = [...entries].reverse().find(
    (e): e is Extract<TranscriptEntry, { type: "usage" }> => e.type === "usage",
  );

  return {
    summary: {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: getLastUpdatedAt(entries, meta.startedAt),
      model: meta.model,
      messageCount: messages.length,
      totalUsage: latestUsage?.total ?? emptyUsage(),
    },
    messages,
  };
}

// ─── Session Listing ────────────────────────────────────────

export async function listProjectSessions(cwd: string, limit = MAX_SESSIONS): Promise<SessionSummary[]> {
  const { projectDir } = getSessionPaths(cwd, "placeholder");

  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const sessionFiles = dirEntries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projectDir, e.name));

  const sessions = await Promise.all(
    sessionFiles.map(async (filePath): Promise<SessionSummary | null> => {
      const entries = await readTranscript(filePath);
      const meta = entries.find((e) => e.type === "session_meta");
      if (!meta || meta.type !== "session_meta") return null;

      const messageCount = entries.filter((e) => e.type === "message").length;
      const latestUsage = [...entries].reverse().find(
        (e): e is Extract<TranscriptEntry, { type: "usage" }> => e.type === "usage",
      );

      return {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        startedAt: meta.startedAt,
        updatedAt: getLastUpdatedAt(entries, meta.startedAt),
        model: meta.model,
        messageCount,
        totalUsage: latestUsage?.total ?? emptyUsage(),
      };
    }),
  );

  return sessions
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function formatSessionHistory(cwd: string): Promise<string> {
  const sessions = await listProjectSessions(cwd);
  if (sessions.length === 0) {
    return "No saved sessions found for this project.";
  }

  const lines = ["Recent sessions:"];
  for (const s of sessions) {
    const total = s.totalUsage.input_tokens + s.totalUsage.output_tokens;
    lines.push([
      `- ${s.sessionId}`,
      `  Updated: ${s.updatedAt}`,
      `  Started: ${s.startedAt}`,
      `  Messages: ${s.messageCount}`,
      `  Usage: ${s.totalUsage.input_tokens} in / ${s.totalUsage.output_tokens} out / ${total} total`,
      `  Model: ${s.model}`,
    ].join("\n"));
  }

  return lines.join("\n");
}
