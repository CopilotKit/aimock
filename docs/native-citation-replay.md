# Native citation replay

Use text blocks with `annotations` for OpenAI Responses or `citations` for Anthropic Messages when a fixture needs to preserve provider-native metadata and its ownership by a particular text segment. Each field is an array of JSON objects. Unknown provider fields, array order and repeated entries are retained.

```json
{
  "match": { "userMessage": "source?" },
  "response": {
    "content": "A fact",
    "toolCalls": [],
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

This complements the existing portable response-level `citations` option. Native metadata on a text block takes precedence for that provider; the other provider's native field is ignored. Empty cited text blocks are allowed. Responses emits indexed annotation events, and Messages emits citation deltas, with the same metadata in completed JSON responses.

Recording JSON or SSE captures the metadata with its owning text block, including indexed annotation events and completed snapshots. Uncited recordings retain their existing representation. Reasoning and usage remain available, and Responses namespaces/custom calls still require `responsesTools: "extended"`.
