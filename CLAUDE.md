# aimock

## Before Every Commit

Run these checks on all changed files before committing:

```bash
pnpm run format:check    # prettier
pnpm run lint            # eslint
pnpm run test            # vitest
```

If prettier or eslint fail, fix with:

```bash
npx prettier --write <files>
npx eslint --fix <files>
```

A pre-commit hook (husky + lint-staged) runs prettier and eslint automatically
on staged files, but always verify manually before pushing — CI checks the
entire repo, not just staged files.

## Project Structure

- `src/` — TypeScript source (server, router, helpers, responses, types)
- `src/__tests__/` — Vitest test suite
- `docs/` — GitHub Pages website (static HTML)
- `fixtures/` — Example fixture JSON files shipped with the package

## Testing

- Tests live in `src/__tests__/` and use Vitest
- When adding features or fixing bugs, add or update tests
- Run `pnpm test` before pushing

## Drift Remediation

There is no LLM/agent in the remediation loop. Automated remediation is
deterministic and scoped to model-family churn only; general drift is caught by
the daily drift test and fixed by a human. Lives in `scripts/`:

- `scripts/drift-report-collector.ts` — runs drift tests, produces `drift-report.json`
- `scripts/drift-sync.ts` — zero-LLM model-family sync (mechanical registry edit or needs-human note file) + reusable git/PR plumbing
- `scripts/drift-sync-check.ts` — the deterministic gate (changed-file allowlist, checksum-pin re-assert, clean re-collect) replacing remediation-diff review

See `DRIFT.md` for full documentation and `.github/workflows/fix-drift.yml` for the CI workflow.

## Forbidden Paths

- **NEVER commit internal planning documents** (specs, plans, design docs) to this repo. No `docs/superpowers/`, no `docs/plans/`, no `docs/specs/`. These are gitignored. Store them in Notion or `~/.claude/` instead.

## Commit Messages

- This repo enforces conventional commit prefixes via commitlint: `fix:`, `feat:`, `docs:`, `test:`, `chore:`, `refactor:`, etc.
- No Co-Authored-By lines
