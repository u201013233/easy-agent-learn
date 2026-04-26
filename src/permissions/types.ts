export type PermissionMode = "default" | "plan" | "auto";
export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  reason: string;
}

export interface PermissionResult {
  behavior: PermissionBehavior;
  request: PermissionRequest;
}
