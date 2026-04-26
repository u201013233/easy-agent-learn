import type { Tool } from "./types.js";
import { saveMemory } from "../memory/index.js";
import type { MemoryType } from "../memory/index.js";

export const memoryWriteTool: Tool = {
  name: "MemoryWrite",
  description:
    "Save important long-term project knowledge to persistent memory. " +
    "Use this when you learn something about the user, project, or workflow that would be valuable in future conversations. " +
    "Only store information that cannot be easily re-derived from the codebase. " +
    "Types: 'user' (user preferences/background), 'feedback' (corrections or confirmations), 'project' (project facts), 'reference' (external system pointers).",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short descriptive title for this memory",
      },
      description: {
        type: "string",
        description: "One-line summary for the memory index (max 200 chars)",
      },
      type: {
        type: "string",
        enum: ["user", "feedback", "project", "reference"],
        description: "Memory category",
      },
      body: {
        type: "string",
        description: "Full content of the memory. Include Why and How to apply when relevant.",
      },
    },
    required: ["name", "description", "type", "body"],
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
  async call(input, context): Promise<{ content: string; isError?: boolean }> {
    const { name, description, type, body } = input as {
      name: string;
      description: string;
      type: MemoryType;
      body: string;
    };

    if (!name || !description || !type || !body) {
      return { content: "Error: name, description, type, and body are all required.", isError: true };
    }

    try {
      const filePath = await saveMemory(context.cwd, { name, description, type, body });
      return { content: `Memory saved: ${filePath}` };
    } catch (err: unknown) {
      return { content: `Error saving memory: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
