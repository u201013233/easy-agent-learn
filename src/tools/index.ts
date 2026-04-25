import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolContext, ToolResult } from "./types.js";

// ─── Path Helpers ────────────────────────────────────────────────

export function resolveWorkspacePath(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace: " + filePath);
  }

  return resolved;
}

export function addLineNumbers(text: string, startLine = 1): string {
  const lines = text.split(/\r?\n/);
  const width = String(startLine + lines.length - 1).length;

  return lines
    .map((line, index) => String(startLine + index).padStart(width, " ") + "\t" + line)
    .join("\n");
}

// ─── Read Tool ───────────────────────────────────────────────────

export const readTool: Tool = {
  name: "Read",
  description: "Read a file from the current workspace. Supports partial reads with offset and limit.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
  },
  isReadOnly() {
    return true;
  },
  isEnabled() {
    return true;
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string | undefined;
    const offset = (input.offset as number) || 1;
    const limit = input.limit as number | undefined;

    if (!filePath) {
      return { content: "Error: file_path is required", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(filePath, context.cwd);
      const raw = await fs.readFile(resolvedPath, "utf8");
      const allLines = raw.split(/\r?\n/);

      const startIndex = Math.max(0, offset - 1);
      const endIndex = typeof limit === "number" ? startIndex + limit : allLines.length;
      const selected = allLines.slice(startIndex, endIndex);

      return {
        content: [
          "File: " + resolvedPath,
          "Lines: " + (startIndex + 1) + "-" + (startIndex + selected.length) + " / " + allLines.length,
          addLineNumbers(selected.join("\n"), startIndex + 1),
        ].join("\n"),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: "Error reading file: " + message, isError: true };
    }
  },
};

// ─── Tool Registry ───────────────────────────────────────────────

export const allTools: Tool[] = [readTool];

export function findToolByName(name: string): Tool | undefined {
  return allTools.find((tool) => tool.name === name);
}

export function getToolsApiParams(): Anthropic.Tool[] {
  return allTools
    .filter((tool) => tool.isEnabled())
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
}