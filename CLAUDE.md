# mock-openai

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

## Commit Messages

- Plain English, no conventional commit prefixes (no feat:, fix:, chore:, etc.)
- No Co-Authored-By lines
