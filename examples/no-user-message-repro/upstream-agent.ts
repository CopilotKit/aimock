import * as http from "node:http";

const PORT = 4001;

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const threadId = "t-stub";
    const runId = "r-stub";
    const messageId = "m-stub";

    const events = [
      { type: "RUN_STARTED", threadId, runId },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "Got it — recorded by aimock." },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId, runId },
    ];

    for (const ev of events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    res.end();
  });
});

server.listen(PORT, () => {
  console.log(`upstream agent listening on http://localhost:${PORT}/agent`);
});
