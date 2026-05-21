import { AGUIMock } from "@copilotkit/aimock";

const PORT = 4010;
const UPSTREAM = "http://localhost:4001/agent";
const FIXTURE_PATH = "./fixtures/agui-recorded";

const aimock = new AGUIMock({ port: PORT, logLevel: "info" }).enableRecording({
  upstream: UPSTREAM,
  fixturePath: FIXTURE_PATH,
});

const url = await aimock.start();
console.log(`aimock AG-UI recording proxy listening on ${url}`);
console.log(`  → forwarding to ${UPSTREAM}`);
console.log(`  → writing fixtures to ${FIXTURE_PATH}`);
