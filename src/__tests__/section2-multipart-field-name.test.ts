import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const boundary = "section2-c18";
const fields = { model: "gpt-4o-transcribe", response_format: "json", stream: "false" };
function multipart(filename: string, payload: string, reversed: boolean) {
  const attrs = reversed
    ? `filename="${filename}"; name="file"`
    : `name="file"; filename="${filename}"`;
  return (
    `--${boundary}\r\nContent-Disposition: form-data; ${attrs}\r\n\r\n${payload}\r\n` +
    Object.entries(fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join("") +
    `--${boundary}--\r\n`
  );
}
async function transcribe(
  id: string,
  filename: string,
  payload: string,
  reversed: boolean,
  fallback: boolean,
) {
  mock = new LLMock({ port: 0, strict: true });
  mock.addFixture({
    match: { model: fields.model, endpoint: "transcription" },
    response: { transcription: { text: "intended transcription" } },
  });
  await mock.start();
  const body = multipart(filename, payload, reversed);
  const contentType = fallback
    ? "multipart/form-data"
    : `multipart/form-data; boundary=${boundary}`;
  const response = await fetch(`${mock.url}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  const result = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
  console.log(JSON.stringify({ id, request: { contentType, body }, response: result }));
  expect(result.status).toBe(200);
  expect(result.contentType).toBe("application/json");
  expect(JSON.parse(result.body)).toEqual({ text: "intended transcription" });
}

for (const fallback of [false, true]) {
  for (const reversed of [false, true]) {
    for (const [filename, payload] of [
      ["model", "wrong-model"],
      ["response_format", "verbose_json"],
      ["stream", "true"],
    ]) {
      const id = `C18-${fallback ? "fallback" : "boundary"}-${reversed ? "reversed" : "ordinary"}-${filename}`;
      test(id, () => transcribe(id, filename, payload, reversed, fallback));
    }
    const id = `control-${fallback ? "fallback" : "boundary"}-${reversed ? "reversed" : "ordinary"}`;
    test(id, () => transcribe(id, "audio.wav", "audio-bytes", reversed, fallback));
  }
}
