# Native citation replay

Use text blocks with `annotations` for OpenAI Responses or `citations` for Anthropic Messages when a fixture needs to preserve provider-native metadata and its ownership by a particular text segment. Each field is an array of JSON objects. Unknown provider fields, array order and repeated entries are retained.

```json
{
  "match": { "userMessage": "source?" },
  "response": {
    "content": "A fact",
    "blocks": [
      {
        "type": "text",
        "text": "A fact",
        "annotations": [
          {
            "type": "url_citation",
            "url": "https://example.test/source",
            "title": "Source",
            "start_index": 0,
            "end_index": 6
          }
        ]
      }
    ]
  }
}
```

This complements the existing portable response-level `citations` option. Native metadata on a text block takes precedence for that provider; the other provider's native field is ignored. A `null` or empty `annotations` / `citations` array is the same as leaving the field out, so the response-level `citations` still apply to that block. Empty cited text blocks are allowed. Responses emits indexed annotation events, and Messages emits citation deltas, with the same metadata in completed JSON responses. A Responses text block with `"continuesMessage": true` is served as the next `output_text` part of the message item opened by the preceding text block; the recorder sets it when an upstream message has several text parts.

Recording JSON or SSE captures the metadata with its owning text block, including indexed annotation events and completed snapshots. A cited recording adds ordered `blocks`, whose text blocks carry the metadata, to what the same turn records without citations; uncited recordings are unchanged. A Responses JSON body is recorded only when it carries citations, with its text, tool calls, reasoning and sanitized usage. Responses namespaces/custom calls still require `responsesTools: "extended"`.
