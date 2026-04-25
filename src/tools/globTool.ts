import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveWorkspacePath } from "./path.js";

const execFileAsync = promisify(execFile);

// ─── Glob Tool ──────────────────────────────────────────────────

export const globTool: Tool = {
  name: "Glob",
  description: "Find files matching a glob pattern. Uses ripgrep (rg) for fast file listing.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts', 'src/**/*.tsx'" },
      path: { type: "string", description: "Directory to search in (default: workspace root)" },
    },
    required: ["pattern"],
  },
  isReadOnly() {
    return true;
  },
  isEnabled() {
    return true;
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern as string | undefined;
    const targetPath = input.path as string | undefined;

    if (!pattern) {
      return { content: "Error: pattern is required", isError: true };
    }

    try {
      const cwd = resolveWorkspacePath(targetPath || ".", context.cwd);
      const { stdout } = await execFileAsync("rg", ["--files", "-g", pattern], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { content: stdout.trim() || "No files matched" };
    } catch (error: unknown) {
      const err = error as { stdout?: string };
      if (err.stdout) {
        return { content: err.stdout.trim() || "No files matched" };
      }
      return { content: "No files matched" };
    }
  },
};