import { spawn, type ChildProcess } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 120_000; // 120s
const MAX_OUTPUT_LENGTH = 30_000;

// ─── Read-only Command Whitelist ─────────────────────────────────

const READONLY_COMMANDS = new Set([
  "ls", "cat", "grep", "rg", "find", "pwd", "head", "tail", "wc",
  "echo", "type", "which", "where", "file", "stat",
  "git", // git subcommands checked separately
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "branch", "tag", "remote", "show", "rev-parse",
]);

export function isReadOnlyCommand(command: string): boolean {
  // Split by && || | ;
  const segments = command
    .split(/(?:&&|\|\||;|\|)/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.every((seg) => {
    const parts = seg.split(/\s+/);
    const cmd = parts[0];

    if (cmd === "git") {
      const sub = parts[1];
      return sub ? READONLY_GIT_SUBCOMMANDS.has(sub) : true;
    }

    return READONLY_COMMANDS.has(cmd);
  });
}

// ─── Dangerous Command Detection ─────────────────────────────────

const DANGEROUS_PREFIXES = [
  "rm ",
  "rm\t",
  "sudo ",
  "sudo\t",
  "git push",
  "git reset --hard",
  "shutdown",
  "reboot",
  "mkfs",
  "dd if=",
  "> /dev/",
  "chmod 777",
];

export function isDangerousCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  return DANGEROUS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// ─── Output Truncation ──────────────────────────────────────────

function truncateOutput(text: string, maxLength = MAX_OUTPUT_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n[output truncated]";
}

// ─── Bash Tool ──────────────────────────────────────────────────

export const bashTool: Tool = {
  name: "Bash",
  description: "Run a shell command in the workspace directory. Has timeout (120s) and output truncation (30000 chars).",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
    },
    required: ["command"],
  },
  isReadOnly() {
    // Dynamic — actual determination depends on the command content
    // The agentic loop can check tool.isReadOnly() before execution for permission prompts
    return false;
  },
  isEnabled() {
    return true;
  },
  async call(input: Record<string, unknown>, context: ToolContext, signal?: AbortSignal): Promise<ToolResult> {
    const command = input.command as string | undefined;

    if (!command) {
      return { content: "Error: command is required", isError: true };
    }

    return new Promise((resolve) => {
      const shell = process.env.SHELL || "/bin/bash";
      process.stderr.write(`[bash] spawning: ${command}\n`);
      let child: ChildProcess;

      try {
        child = spawn(shell, ["-lc", command], {
          cwd: context.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({ content: "Error spawning shell: " + message, isError: true });
        return;
      }

      let stdout = "";
      let stderr = "";
      let killed = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Timeout
      const timer = setTimeout(() => {
        killed = true;
        process.stderr.write(`[bash] timeout (${DEFAULT_TIMEOUT}ms), killing\n`);
        child.kill("SIGKILL");
      }, DEFAULT_TIMEOUT);

      // Abort signal support
      const onAbort = () => {
        if (!killed) {
          killed = true;
          process.stderr.write(`[bash] abort signal received, killing\n`);
          child.kill("SIGTERM");
          // Give a brief grace period, then force kill
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
          }, 3000);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);

        const exitMsg = killed
          ? "Exit code: killed (timeout or interrupted)"
          : "Exit code: " + code;

        process.stderr.write(`[bash] exited code=${code} killed=${killed} stdout=${stdout.length}chars stderr=${stderr.length}chars\n`);

        const output = [
          exitMsg,
          "",
          truncateOutput(stdout, MAX_OUTPUT_LENGTH),
        ].join("\n");

        // Only include stderr if non-empty
        const fullOutput = stderr.trim()
          ? output + "\nSTDERR:\n" + truncateOutput(stderr, MAX_OUTPUT_LENGTH)
          : output;

        resolve({
          content: fullOutput.trim(),
          isError: code !== 0 || killed,
        });
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ content: "Error executing command: " + error.message, isError: true });
      });
    });
  },
};