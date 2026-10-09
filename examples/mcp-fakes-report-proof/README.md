# MCP fakes report proof (HC1)

This project proves that the Vitest and Jest plugins catch MCP fake problems
that a test body does not see.

- `swallowed.test.ts` and `jest/swallowed.test.cjs` build the MCP URL by hand,
  call `get_weather` with arguments that match no fake, and catch the error.
- `unused.test.ts` talks to its fake's mount but never calls the fake entry
  `never-called`.
- `fakes-for.test.ts` and `jest/fakes-for.test.cjs` call `fakesFor()` with no
  test id and print the inferred default id.

Run it against one `@copilotkit/aimock` tarball:

```bash
./run.sh path/to/copilotkit-aimock-<version>.tgz
```

`run.sh` copies the project to a temporary directory, installs the tarball,
and runs `vitest run` and `jest` (each also once with `AIMOCK_FAKES_REPORT=off`).

With a release that has no fakes report, the swallowed and unused tests pass,
and the `fakesFor` tests fail with `TypeError: mock(...).fakesFor is not a function`.
With the fakes report:

- the swallowed tests fail in `afterEach` with `AimockFakesReportError`, naming
  `failure MCP_FAKE_MISMATCH: tools/call get_weather on /mcp`;
- the unused test fails, naming `never-called`;
- with `AIMOCK_FAKES_REPORT=off`, the swallowed and unused tests pass;
- `fakes-for.test.ts` prints `DEFAULT_ID=fakes-for.test.ts › weather › seattle`;
- the Jest test prints `DEFAULT_ID=jest/fakes-for.test.cjs › weather seattle`.
