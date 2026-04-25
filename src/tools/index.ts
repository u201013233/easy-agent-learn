import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "./types.js";
import { readTool } from "./readTool.js";
import { writeTool } from "./writeTool.js";
import { editTool } from "./editTool.js";
import { grepTool } from "./grepTool.js";
import { globTool } from "./globTool.js";
import { bashTool } from "./bashTool.js";

// ─── Tool Registry ───────────────────────────────────────────────

export const allTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  bashTool,
];

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