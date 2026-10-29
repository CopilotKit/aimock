import { LLMock } from "../index.js";

async function publish() {
  const [fixturePath, upstream, prompt] = process.argv.slice(2);
  const mock = new LLMock({ port: 0, record: { fixturePath, providers: { openai: upstream } } });
  await mock.start();
  try {
    const session = mock.beginRecordingSession("shared");
    const response = await fetch(mock.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "shared" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: prompt }] }),
    });
    await response.text();
    if (response.status !== 200) throw new Error(`Proxy returned ${response.status}`);
    const beginCommit = new Promise<void>((resolve) => {
      process.once("message", (message) => {
        if (message === "commit") resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      process.send!("ready", (error: Error | null) => (error ? reject(error) : resolve()));
    });
    await beginCommit;
    const count = await session.commit();
    await new Promise<void>((resolve, reject) => {
      process.send!(count, (error: Error | null) => (error ? reject(error) : resolve()));
    });
  } finally {
    await mock.stop();
  }
}

try {
  await publish();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.disconnect();
}
