import { CopilotRuntime, copilotRuntimeNextJSAppRouterEndpoint } from "@copilotkit/runtime";
import { HttpAgent } from "@ag-ui/client";
import type { NextRequest } from "next/server";

const runtime = new CopilotRuntime({
  agents: {
    default: new HttpAgent({ url: "http://localhost:4010" }),
  },
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
};
