import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ─── AGENT.md Loader ───────────────────────────────────────────

async function readAgentMdFile(filePath: string): Promise<string> {
  try {
    let content = await fs.readFile(filePath, "utf8");

    // Strip HTML comments
    content = content.replace(/<!--[\s\S]*?-->/g, "");

    const trimmed = content.trim();
    if (!trimmed) return "";

    return `# Source: ${filePath}\n${trimmed}`;
  } catch {
    return "";
  }
}

export async function loadAgentMd(cwd: string): Promise<string> {
  const sections: string[] = [];

  // 1. User-level global preferences
  const globalPath = path.join(os.homedir(), ".agent", "AGENT.md");
  const globalContent = await readAgentMdFile(globalPath);
  if (globalContent) sections.push(globalContent);

  // 2. Project-level
  const projectPath = path.join(cwd, "AGENT.md");
  const projectContent = await readAgentMdFile(projectPath);
  if (projectContent) sections.push(projectContent);

  return sections.join("\n\n");
}
