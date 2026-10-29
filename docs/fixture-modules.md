# Fixture modules

A fixture module is a JSON file with a `fixtures` array. It can declare `parameters`, supply `defaults`, and include other module files relative to its own directory.

```json
{
  "parameters": ["answer"],
  "defaults": { "answer": "Hello" },
  "fixtures": [
    { "match": { "userMessage": "hello" }, "response": { "content": { "$param": "answer" } } },
    { "include": "shared.json", "with": { "region": "eu" } }
  ]
}
```

An object containing only `$param` is replaced by the corresponding JSON value. Includes receive their own declared bindings through `with`; they do not inherit the caller's bindings. Expansion preserves fixture order and rejects include cycles, undeclared or missing parameters, and invalid fixtures.

```ts
const mock = new LLMock();
mock.mountFixtureModule("greetings", "./greetings.json", {
  parameters: { answer: "Welcome" },
});
mock.reloadFixtureModules(["./shared.json"]);
console.log(mock.getFixtureModules());
mock.unmountFixtureModule("greetings");
```

`loadFixtureModule(path, options)` appends an unmanaged snapshot. A named mount remembers its position, dependencies, resolved options and revision. Reloading without a path list selects all mounts; supplying changed paths selects affected mounts. Reload compiles every selected mount before publishing any replacement. A failure keeps the previous fixtures and revisions intact. Remounting a name retains its position, including an empty module's position. Normal fixture registrations can be mixed with mounts.

Options default to `maxFixtures: 10000` and `maxDepth: 64`; both accept nonnegative safe integers. Module info returns detached snapshots. Paths are resolved when mounted, and dependency matching accounts for canonical file identities. Modules honor the server's live-fixture and misbehavior settings.
