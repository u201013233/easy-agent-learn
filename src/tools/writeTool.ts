import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveWorkspacePath } from "./path.js";

export const writeTool: Tool = {
  name: "Write",
  description: "Create or overwrite a file. Parent directories are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to create or overwrite" },
      content: { type: "string", description: "Full content to write to the file" },
    },
    required: ["file_path", "content"],
  },
  isReadOnly() {
    return false;
  },
  isEnabled() {
    return true;
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string | undefined;
    const content = input.content as string | undefined;

    if (!filePath) {
      return { content: "Error: file_path is required", isError: true };
    }
    if (content === undefined) {
      return { content: "Error: content is required", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(filePath, context.cwd);

      // Check if file already exists
      let isUpdate = false;
      try {
        await fs.access(resolvedPath);
        isUpdate = true;
      } catch {
        // File doesn't exist yet
      }

      // Auto-create parent directories
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, "utf8");

      const action = isUpdate ? "Updated" : "Created";
      return { content: `${action} file: ${resolvedPath}` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: "Error writing file: " + message, isError: true };
    }
  },
};
