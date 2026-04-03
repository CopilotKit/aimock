export interface A2AMockOptions {
  port?: number;
  host?: string;
}

export interface A2AAgentDefinition {
  name: string;
  description?: string;
  version?: string;
  skills?: Array<{ id: string; name: string; description?: string; tags?: string[] }>;
  capabilities?: { streaming?: boolean };
}

export type A2APart =
  | { text: string }
  | { data: unknown; mediaType?: string }
  | { url: string; mediaType?: string };

export interface A2AArtifact {
  artifactId?: string;
  name?: string;
  description?: string;
  parts: A2APart[];
}

export interface A2ATaskResponse {
  artifacts?: A2AArtifact[];
}

export type A2AStreamEvent =
  | { type: "status"; state: A2ATaskState }
  | { type: "artifact"; parts: A2APart[]; append?: boolean; lastChunk?: boolean; name?: string };

export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: A2ATaskState; timestamp: string };
  artifacts: A2AArtifact[];
  history: A2AMessage[];
}

export type A2ARole = "ROLE_USER" | "ROLE_AGENT";

export interface A2AMessage {
  messageId: string;
  role: A2ARole;
  parts: A2APart[];
}

export type A2ATaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED";
