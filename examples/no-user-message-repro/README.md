# aimock AG-UI repro: `__NO_USER_MESSAGE__` on file attachments

A minimal Next.js + CopilotKit project that reproduces a bug that existed in `@copilotkit/aimock@1.26.1` and earlier: when a CopilotKit chat user message included a file attachment alongside text, the AG-UI client sent `content` as a structured array (`[{ type: "text", text: "..." }, { type: "document", source: ... }]`) instead of a plain string. `aimock`'s `extractLastUserMessage` only handled `typeof content === "string"`, returned `""`, and the recorder wrote `match.message: "__NO_USER_MESSAGE__"` to disk. The resulting fixture was unmatchable on replay.

The bug was fixed by widening `AGUIMessage.content` and teaching `extractLastUserMessage` to walk structured content arrays. `recorded-sample/before-fix.json` (sentinel) and `recorded-sample/after-fix.json` (real user text) are pre-captured exhibits of the same request before and after the fix.

## Architecture

```
Browser (:3000)              CopilotKit chat UI, file attachments enabled
   │
   ▼
Next.js /api/copilotkit       CopilotRuntime + HttpAgent
   │
   ▼
aimock (:4010)                AGUIMock recording proxy
   │
   ▼
upstream-agent (:4001)        Tiny SSE stub that returns a canned assistant reply
```

## Run against the fixed local aimock

This example consumes the local aimock checkout via a `link:` dependency in `package.json` (`"@copilotkit/aimock": "link:../.."`), so by default it runs the _fixed_ code.

From the **repo root** (`@copilotkit/aimock`):

```sh
pnpm install
pnpm build
```

From **this directory**:

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts three processes via `concurrently`:

- `upstream` on `:4001` — the noop SSE stub
- `aimock` on `:4010` — the recording proxy
- `next` on `:3000` — the Next.js dev server

Open <http://localhost:3000>, attach any small file (e.g. a `.txt`), send `summarize this`, and inspect `fixtures/agui-recorded/agui-*.json` — `match.message` will be `"summarize this"`.

## Run against the buggy published aimock (1.26.1)

To reproduce the original failure mode, swap the local link for the published 1.26.1 release. From this directory:

1. Edit `package.json` and change:
   ```json
   "@copilotkit/aimock": "link:../.."
   ```
   to:
   ```json
   "@copilotkit/aimock": "1.26.1"
   ```
2. Reinstall and run:
   ```sh
   pnpm install
   pnpm dev
   ```
3. Repeat the chat reproduction above. The recorded fixture's `match.message` will be `"__NO_USER_MESSAGE__"` — the bug.

Revert the dep back to `"link:../.."` and `pnpm install` again to switch back to the fixed local code.

## Headless repro (no browser)

Skip Next.js by starting just `upstream` and `aimock`, then POSTing the bundled synthetic payload directly:

```sh
pnpm upstream &
pnpm aimock &
curl -X POST http://localhost:4010/ \
  -H 'Content-Type: application/json' \
  --data-binary @structured-input.json
cat fixtures/agui-recorded/agui-*.json
```

`structured-input.json` is a hand-crafted `RunAgentInput` whose user message uses the canonical AG-UI multimodal schema (`text` + `document` parts). Against fixed aimock, `match.message` is `"summarize this"`; against 1.26.1, it is `"__NO_USER_MESSAGE__"`.

## Compare to a text-only message

Sending a plain text message (no attachment) from the chat always produced the correct `match.message` — even on 1.26.1. The bug only manifested when `content` was structured (which in practice meant: when the user attached a file).

## Notes

- This example is not part of the aimock test suite — it's a manual reproduction kept around as a self-contained demonstration of the bug and its fix.
- `concurrently` shuts down all three processes when you Ctrl-C the parent.
- Recorded fixtures land under `fixtures/agui-recorded/` and are gitignored.
