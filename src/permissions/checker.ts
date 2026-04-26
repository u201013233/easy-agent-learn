import { isReadOnlyCommand, isDangerousCommand } from "../tools/bashTool.js";
import type { PermissionMode, PermissionBehavior, PermissionResult, PermissionRequest } from "./types.js";

// ─── Summary Helper ─────────────────────────────────────────────

function summarizeArgs(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    return `command=${input.command || "<empty>"}`;
  }
  return Object.entries(input)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

// ─── Session Allow Rule Matching ─────────────────────────────────

function matchesSessionRule(toolName: string, input: Record<string, unknown>, rule: string): boolean {
  // Rule format: "ToolName" or "ToolName(key=value)"
  if (rule === toolName) return true;

  // Bash(command=npm test*) pattern
  const bashPrefix = "Bash(command=";
  if (rule.startsWith(bashPrefix) && toolName === "Bash") {
    const pattern = rule.slice(bashPrefix.length, -1); // strip trailing ")"
    const command = (input.command as string) || "";
    // Simple glob: "npm test*" matches "npm test"
    if (pattern.endsWith("*")) {
      return command.startsWith(pattern.slice(0, -1));
    }
    return command === pattern;
  }

  return false;
}

// ─── Permission Checker ─────────────────────────────────────────

export interface CheckPermissionParams {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  toolIsReadOnly: boolean;
  mode: PermissionMode;
  sessionAllowRules: string[];
}

export function checkPermission(params: CheckPermissionParams): PermissionResult {
  const { toolName, toolUseId, input, toolIsReadOnly, mode, sessionAllowRules } = params;

  const request: PermissionRequest = {
    toolName,
    toolUseId,
    input,
    summary: summarizeArgs(toolName, input),
    riskLevel: "low",
    reason: "",
  };

  // 1. Auto mode → allow everything
  if (mode === "auto") {
    request.reason = "auto mode: all operations allowed";
    return { behavior: "allow", request };
  }

  // 2. Plan mode → deny writes
  if (mode === "plan" && !toolIsReadOnly) {
    request.riskLevel = "medium";
    request.reason = "plan mode: write operations blocked";
    return { behavior: "deny", request };
  }

  // 3. Check session allow rules
  for (const rule of sessionAllowRules) {
    if (matchesSessionRule(toolName, input, rule)) {
      request.reason = `session rule: ${rule}`;
      return { behavior: "allow", request };
    }
  }

  // 4. Bash tool → special handling
  if (toolName === "Bash") {
    const command = (input.command as string) || "";

    if (isDangerousCommand(command)) {
      request.riskLevel = "high";
      request.reason = "dangerous shell command detected";
      return { behavior: "deny", request };
    }

    if (isReadOnlyCommand(command)) {
      request.riskLevel = "low";
      request.reason = "read-only shell command";
      return { behavior: "allow", request };
    }

    request.riskLevel = "medium";
    request.reason = "shell command may change local state";
    return { behavior: "ask", request };
  }

  // 5. Read-only tools → allow
  if (toolIsReadOnly) {
    request.reason = "read-only tool";
    return { behavior: "allow", request };
  }

  // 6. Write/Edit tools → ask
  request.riskLevel = "medium";
  request.reason = "tool writes local state";
  return { behavior: "ask", request };
}
