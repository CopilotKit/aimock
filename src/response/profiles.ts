/** Static wire facts only. Status selection and transport behavior belong to callers. */
export const errorProfiles = {
  openai: { fixtureType: "server_error", validationType: "invalid_request_error" },
  messages: { fixtureType: "api_error", validationType: "invalid_request_error" },
  bedrock: {
    fixtureType: "api_error",
    validationType: "invalid_request_error",
    toolArgumentType: "InternalServerException",
  },
  "bedrock-converse": {
    fixtureType: "api_error",
    validationType: "invalid_request_error",
    toolArgumentType: "InternalServerException",
  },
  ollama: { fixtureType: "server_error", validationType: "invalid_request_error" },
  cohere: { fixtureType: "server_error", validationType: "invalid_request_error" },
  interactions: { fixtureType: "server_error", validationType: "invalid_request_error" },
  gemini: { fixtureType: "server_error", validationType: "invalid_request_error" },
} as const;

export type ErrorWire = keyof typeof errorProfiles;
