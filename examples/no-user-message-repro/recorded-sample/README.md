# Captured evidence

Three exhibits showing the bug and its fix:

- `input-messages-dump.json` — the request body POSTed to aimock. The user message's `content` is a structured array conforming to the AG-UI multimodal spec (`@ag-ui/core`'s `InputContentSchema`): a `text` part plus a `document` part with an embedded data source.
- `before-fix.json` — the fixture aimock@1.26.1 wrote to `fixtures/agui-recorded/` in response to that request. Note `match.message: "__NO_USER_MESSAGE__"` — the recorder lost the user's text because `extractLastUserMessage` only handled `typeof content === "string"`.
- `after-fix.json` — the fixture written by the same request after the fix landed. `match.message` is now `"summarize this"` (the text content joined from the parts array).

## How these were produced

`input-messages-dump.json` is a hand-crafted payload matching the canonical AG-UI multimodal schema from `@ag-ui/core@0.0.53` (the `text` and `document` content part shapes). It was POSTed directly to the aimock recording proxy (`http://localhost:4010/`) while the upstream stub on `:4001` was running. The before/after fixtures are the on-disk outputs from running that POST against the published 1.26.1 release and the fixed local build, respectively.

To produce real CopilotKit-captured payloads, run the full Next.js demo (see the parent `README.md`) — the bug behaves identically whether the structured `content` comes from CopilotKit's chat client or this synthetic payload.
