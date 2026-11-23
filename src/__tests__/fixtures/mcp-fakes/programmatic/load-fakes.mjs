import { LLMock, MCPMock } from "@copilotkit/aimock";

export async function startMock() {
  const llm = new LLMock({ port: 0 });

  // A fixture file: its LLM fixtures and its mcpFakes load together.
  llm.loadFixtureFile("weather/seattle.json");

  // Fakes from code, on a mount you create.
  const billing = new MCPMock();
  billing.loadFakes({
    scope: { testId: "billing › refund" },
    tools: [{ name: "refund", calls: [{ args: { amount: 10 }, result: "refunded 10" }] }],
  });
  llm.mount("/billing", billing);

  await llm.start();
  return llm;
}
