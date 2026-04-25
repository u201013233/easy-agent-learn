export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isReadOnly(): boolean;
  isEnabled(): boolean;
  call(input: Record<string, unknown>, context: ToolContext, signal?: AbortSignal): Promise<ToolResult>;
}