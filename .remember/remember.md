# Handoff

## State

aimock rebrand COMPLETE on `feat/aimock` in `/Users/jpr5/proj/cpk/llmock-v1.7.0-sp1`. PR #68 on CopilotKit/llmock. Package renamed to `@copilotkit/aimock`. 1989 tests, 55 files. All docs/source/Docker/Helm/CI/skills/README rebranded. 6 migration pages, aimock-pytest, 2 converters, control API, MCP/A2A/Vector metrics. 8 blog posts on Notion.

**aimock-pytest CI + local dev path** added:

- `AIMOCK_CLI_PATH` env var support in `_node_manager.py` (ensure_installed) and `_server.py` (start) — bypasses npm tarball download, points directly at a local `cli.js`
- `tests/conftest.py` auto-detects `../../dist/cli.js` for local development
- `.github/workflows/test-pytest.yml` — Python 3.10-3.13 x Node 20/22 matrix, builds TS first, sets AIMOCK_CLI_PATH
- `.github/workflows/publish-pytest.yml` — publishes to PyPI on main push when version bumped (needs `PYPI_TOKEN` secret)
- `pyproject.toml` — added `[test]` optional dependency group (pytest, requests)
- `README.md` — added Development section with local test instructions and CI explanation

## Next

1. **Merge PR #68** → triggers npm publish + Docker push
2. **GitHub repo rename**: CopilotKit/llmock → CopilotKit/aimock (Settings → General)
3. **CNAME**: aimock.copilotkit.dev, update docs/CNAME, redirect llmock.copilotkit.dev
4. **Deprecate @copilotkit/llmock**: final version re-exporting @copilotkit/aimock
5. **Clean **pycache**** from aimock-pytest commit
6. **Add `PYPI_TOKEN` secret** to CopilotKit/llmock (or aimock) GitHub repo for publish-pytest workflow

## Context

- Branch `feat/aimock`, worktree `/Users/jpr5/proj/cpk/llmock-v1.7.0-sp1`
- Notion: Content (3353aa38-1852-81fb), Website (3353aa38-1852-811d), Conversion (3353aa38-1852-816d)
- PRs #62 (reasoning) and #63 (requestTransform) awaiting contributor fixes
- `npx aimock` always, `aimock` lowercase, `LLMock` class stays
