import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Git Info Collection ────────────────────────────────────────

export async function getGitBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getGitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd });
    return stdout.trim() || "clean";
  } catch {
    return "";
  }
}

export async function getGitLastCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--oneline"], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

// ─── Build Git Section ──────────────────────────────────────────

export async function buildGitSection(cwd: string): Promise<string> {
  const [branch, status, lastCommit] = await Promise.all([
    getGitBranch(cwd),
    getGitStatus(cwd),
    getGitLastCommit(cwd),
  ]);

  if (!branch) {
    return "- Git: not a git repository";
  }

  const lines = [`- Git branch: ${branch}`];

  if (lastCommit) {
    lines.push(`- Git last commit: ${lastCommit}`);
  }

  lines.push(`- Git status:\n${status}`);

  return lines.join("\n");
}
