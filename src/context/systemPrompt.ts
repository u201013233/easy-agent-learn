import os from "node:os";
import { buildGitSection } from "./git.js";
import { loadAgentMd } from "./agentMd.js";
import { readMemoryEntrypoint, getMemoryDir } from "../memory/index.js";

// ─── Build System Prompt ───────────────────────────────────────

export interface BuildSystemPromptParams {
  cwd: string;
  additionalInstructions?: string;
}

export async function buildSystemPrompt(
  params: BuildSystemPromptParams,
): Promise<string> {
  const { cwd, additionalInstructions } = params;

  // ── Static Section ──
  const staticSection = [
    "<SYSTEM_STATIC_CONTEXT>",
    "You are Easy Agent, a terminal-native agentic coding assistant.",
    "",
    "## Behavior",
    "- Respond in the same language as the user's input.",
    "- Be concise, practical, and action-oriented.",
    "- Give conclusions first, details second.",
    "",
    "## Tool Usage",
    "- Prefer specialized tools over Bash: use Grep to search content, Glob to find files, Edit to modify code.",
    "- Use Bash only when no dedicated tool fits.",
    "- Understand the code before changing it. Read files first, then make targeted edits.",
    "- After making changes, verify with tests or builds when possible.",
    "</SYSTEM_STATIC_CONTEXT>",
  ].join("\n");

  // ── Dynamic Section ──
  const dynamicParts: string[] = [];

  // Environment
  dynamicParts.push([
    "<SYSTEM_DYNAMIC_CONTEXT>",
    `- Current working directory: ${cwd}`,
    `- Current date: ${new Date().toISOString().split("T")[0]}`,
    `- OS: ${os.platform()} ${os.release()} (${os.arch()})`,
  ].join("\n"));

  // Git
  const gitSection = await buildGitSection(cwd);
  dynamicParts.push(gitSection);

  // Additional instructions
  if (additionalInstructions?.trim()) {
    dynamicParts.push(`- Session instructions:\n${additionalInstructions.trim()}`);
  }

  // AGENT.md
  const agentMdContent = await loadAgentMd(cwd);
  if (agentMdContent) {
    dynamicParts.push(agentMdContent);
  }

  // Project Memory index
  const memoryContent = await readMemoryEntrypoint(cwd);
  if (memoryContent) {
    const memoryDir = getMemoryDir(cwd);
    dynamicParts.push(`<PROJECT_MEMORY>
Memory directory: ${memoryDir}
You can use the Read tool to read any memory file listed below for full details.

${memoryContent}</PROJECT_MEMORY>`);
  }

  dynamicParts.push("</SYSTEM_DYNAMIC_CONTEXT>");

  return staticSection + "\n\n" + dynamicParts.join("\n\n");
}
