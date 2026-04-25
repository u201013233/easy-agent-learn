import path from "node:path";
import os from "node:os";

// ─── Home Directory Expansion ────────────────────────────────────

export function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

// ─── Workspace Path Resolution ───────────────────────────────────

export function resolveWorkspacePath(filePath: string, cwd: string): string {
  const expanded = expandHome(filePath);
  const resolved = path.resolve(cwd, expanded);
  const relative = path.relative(cwd, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace: " + filePath);
  }

  return resolved;
}

// ─── Line Number Formatting ──────────────────────────────────────

export function addLineNumbers(text: string, startLine = 1): string {
  const lines = text.split(/\r?\n/);
  const width = String(startLine + lines.length - 1).length;

  return lines
    .map((line, index) => String(startLine + index).padStart(width, " ") + "\t" + line)
    .join("\n");
}