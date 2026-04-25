import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveWorkspacePath } from "./path.js";

const execFileAsync = promisify(execFile);

// ─── Grep Tool ──────────────────────────────────────────────────

export const grepTool: Tool = {
  name: "Grep",
  description: "Search file contents using regex. Uses ripgrep (rg) if available, falls back to system grep.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory or file to search in (default: workspace root)" },
      include: { type: "string", description: "File glob to filter, e.g. '*.ts'" },
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
    const include = input.include as string | undefined;

    if (!pattern) {
      return { content: "Error: pattern is required", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(targetPath || ".", context.cwd);
      const args = ["-n", "--no-heading", "--color", "never"];

      if (include) {
        args.push("--glob", include);
      }

      args.push(pattern, resolvedPath);

      const { stdout } = await execFileAsync("rg", args, { maxBuffer: 10 * 1024 * 1024 });
      return { content: stdout.trim() || "No matches found" };
    } catch (error: unknown) {
      // rg returns exit code 1 when no matches found, but still outputs to stdout
      const err = error as { stdout?: string; message?: string };
      if (err.stdout) {
        return { content: err.stdout.trim() || "No matches found" };
      }
      // rg not found, fall back to grep
      try {
        const resolvedPath = resolveWorkspacePath(targetPath || ".", context.cwd);
        const args = ["-rn", pattern, resolvedPath];
        const { stdout } = await execFileAsync("grep", args, { maxBuffer: 10 * 1024 * 1024 });
        return { content: stdout.trim() || "No matches found" };
      } catch (grepErr: unknown) {
        const gErr = grepErr as { stdout?: string };
        if (gErr.stdout) {
          return { content: gErr.stdout.trim() || "No matches found" };
        }
        return { content: "No matches found" };
      }
    }
  },
};