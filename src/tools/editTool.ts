import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveWorkspacePath } from "./path.js";

// ─── Helpers ────────────────────────────────────────────────────

function countOccurrences(text: string, pattern: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(pattern, index);
    if (index === -1) return count;
    count += 1;
    index += pattern.length;
  }
}

function normalizeQuotes(str: string): string {
  return str
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

// ─── Edit Tool ──────────────────────────────────────────────────

export const editTool: Tool = {
  name: "Edit",
  description: "Make a precise string replacement in a file. The old_string must match exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to edit" },
      old_string: { type: "string", description: "Exact text to find and replace (must be unique in the file)" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  isReadOnly() {
    return false;
  },
  isEnabled() {
    return true;
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string | undefined;
    const oldString = input.old_string as string | undefined;
    const newString = input.new_string as string | undefined;

    if (!filePath) {
      return { content: "Error: file_path is required", isError: true };
    }
    if (!oldString) {
      return { content: "Error: old_string is required", isError: true };
    }
    if (newString === undefined) {
      return { content: "Error: new_string is required", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(filePath, context.cwd);
      const original = await fs.readFile(resolvedPath, "utf8");

      // Normalize quotes to handle smart quotes from the model
      const normalizedOld = normalizeQuotes(oldString);
      const matches = countOccurrences(original, normalizedOld);

      if (matches === 0) {
        return {
          content: `Error: old_string not found in ${resolvedPath}. Make sure the text matches exactly.`,
          isError: true,
        };
      }

      if (matches > 1) {
        return {
          content: `Error: old_string found ${matches} times in ${resolvedPath}. It must be unique. Include more surrounding context to make it unique.`,
          isError: true,
        };
      }

      const updated = original.replace(normalizedOld, newString);
      await fs.writeFile(resolvedPath, updated, "utf8");

      return { content: `Edited ${resolvedPath}` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: "Error editing file: " + message, isError: true };
    }
  },
};