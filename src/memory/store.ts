import fs from "node:fs/promises";
import path from "node:path";
import { getProjectHash, PROJECTS_DIR } from "../session/store.js";

// ─── Constants ──────────────────────────────────────────────

const MEMORY_DIR_NAME = "memory";
const MEMORY_ENTRYPOINT = "MEMORY.md";
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;
const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

// ─── Types ──────────────────────────────────────────────────

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface MemoryFile {
  filePath: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

// ─── Path Helpers ───────────────────────────────────────────

export function getMemoryDir(cwd: string): string {
  const projectHash = getProjectHash(cwd);
  return path.join(PROJECTS_DIR, projectHash, MEMORY_DIR_NAME);
}

export function getEntrypointPath(cwd: string): string {
  return path.join(getMemoryDir(cwd), MEMORY_ENTRYPOINT);
}

export async function ensureMemoryDir(cwd: string): Promise<string> {
  const dir = getMemoryDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ─── Validation ─────────────────────────────────────────────

export function shouldStoreAsMemory(candidate: unknown): candidate is Memory {
  if (!candidate || typeof candidate !== "object") return false;
  const c = candidate as Record<string, unknown>;
  if (!VALID_TYPES.has(c.type as string)) return false;
  if (!c.name || typeof c.name !== "string") return false;
  if (!c.description || typeof c.description !== "string") return false;
  if (!c.body || typeof c.body !== "string") return false;
  if (c.description.length > 200) return false;
  return true;
}

// ─── Slugify ────────────────────────────────────────────────

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "memory_note";
}

// ─── Frontmatter ────────────────────────────────────────────

export function buildMemoryFileContent(memory: Memory): string {
  return [
    "---",
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    `type: ${memory.type}`,
    "---",
    "",
    memory.body.trim(),
    "",
  ].join("\n");
}

export function parseFrontmatter(raw: string): { name: string; description: string; type: string; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const header = match[1];
  const body = match[2].trim();
  const fields: Record<string, string> = {};

  for (const line of header.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }

  if (!fields.name || !fields.description || !fields.type) return null;
  return { name: fields.name, description: fields.description, type: fields.type as MemoryType, body };
}

// ─── File Operations ────────────────────────────────────────

export async function writeMemoryFile(cwd: string, memory: Memory): Promise<string> {
  if (!shouldStoreAsMemory(memory)) {
    throw new Error("Invalid memory payload.");
  }

  const memoryDir = await ensureMemoryDir(cwd);
  const fileName = slugify(memory.name) + ".md";
  const filePath = path.join(memoryDir, fileName);
  const content = buildMemoryFileContent(memory);

  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function readMemoryFile(filePath: string): Promise<MemoryFile | null> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  return { filePath, name: parsed.name, description: parsed.description, type: parsed.type as MemoryType, body: parsed.body };
}

export async function listMemoryFiles(cwd: string): Promise<string[]> {
  const memoryDir = await ensureMemoryDir(cwd);
  const entries = await fs.readdir(memoryDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== MEMORY_ENTRYPOINT)
    .map((e) => path.join(memoryDir, e.name));
}

// ─── Memory Index ───────────────────────────────────────────

export function buildMemoryIndex(memories: MemoryFile[]): string {
  const lines = ["# Project Memory", ""];

  for (const m of memories) {
    const fileName = path.basename(m.filePath);
    lines.push(`- [${m.name}](${fileName}) — ${m.description}`);
  }

  let text = lines.join("\n").trim() + "\n";

  // Limit by lines
  const lineLimited = text.split(/\r?\n/).slice(0, MAX_ENTRYPOINT_LINES).join("\n");

  // Limit by bytes
  text = Buffer.byteLength(lineLimited, "utf-8") > MAX_ENTRYPOINT_BYTES
    ? lineLimited.slice(0, MAX_ENTRYPOINT_BYTES)
    : lineLimited;

  return text.trimEnd() + "\n";
}

export async function rebuildMemoryIndex(cwd: string): Promise<string> {
  await ensureMemoryDir(cwd);
  const files = await listMemoryFiles(cwd);
  const loaded = await Promise.all(files.map(readMemoryFile));
  const memories = loaded.filter((m): m is MemoryFile => m !== null);
  const index = buildMemoryIndex(memories);

  const entrypointPath = getEntrypointPath(cwd);
  await fs.writeFile(entrypointPath, index, "utf-8");
  return index;
}

// Write memory file first, then rebuild index
export async function saveMemory(cwd: string, memory: Memory): Promise<string> {
  const filePath = await writeMemoryFile(cwd, memory);
  await rebuildMemoryIndex(cwd);
  return filePath;
}

// ─── Read / Search ──────────────────────────────────────────

export async function readMemoryEntrypoint(cwd: string): Promise<string | null> {
  const entrypointPath = getEntrypointPath(cwd);
  try {
    return await fs.readFile(entrypointPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function findRelevantMemories(cwd: string, query: string): Promise<string[]> {
  const files = await listMemoryFiles(cwd);
  const loaded = (await Promise.all(files.map(readMemoryFile))).filter((m): m is MemoryFile => m !== null);
  const queryTerms = query.toLowerCase().split(/\W+/).filter(Boolean);

  return loaded
    .map((memory) => {
      const haystack = [memory.name, memory.description, memory.body].join("\n").toLowerCase();
      const score = queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => [
      `# ${entry.memory.name}`,
      `Type: ${entry.memory.type}`,
      `Description: ${entry.memory.description}`,
      entry.memory.body,
    ].join("\n\n"));
}
