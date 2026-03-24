export interface MCPMockOptions {
  port?: number;
  host?: string;
  serverInfo?: { name: string; version: string };
}

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export type MCPContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; text?: string; blob?: string; mimeType?: string };
    };

export interface MCPResourceContent {
  text?: string;
  blob?: string;
  mimeType?: string;
}

export interface MCPPromptResult {
  messages: Array<{ role: string; content: MCPContent }>;
}

export interface MCPSession {
  id: string;
  initialized: boolean;
  createdAt: number;
}
