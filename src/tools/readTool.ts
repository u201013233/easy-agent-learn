import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveWorkspacePath, addLineNumbers } from "./path.js";

export const readTool: Tool = {
  name: "Read",
  description: "Read a file from the current workspace. Supports partial reads with offset and limit.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to read" },
      offset: { type: "number", description: "1-based line number to start reading from" },
      limit: { type: "number", description: "Number of lines to read" },
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