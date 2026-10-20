#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * update-adoption-wall.ts
 *
 * Regenerates the "Teams building on aimock" adoption marquee in docs/index.html
 * from `adopters.json` at the root of the ORPHAN `adoption-data` branch of THIS
 * repository, written weekly by the adoption-scan routine.
 *
 * WHY AN ORPHAN BRANCH IN THIS REPO, AND WHY IT MUST NEVER BE MERGED. The data
 * used to be read out of the private CopilotKit/backoffice repo, which meant a
 * public repo's CI had to carry a GitHub App private key and hold a cross-repo
 * read. `adoption-data` is a branch of this repo, so the workflow's default
 * GITHUB_TOKEN is sufficient and there is no app credential to leak. The branch
 * is ORPHAN: it shares no history with `main`, it holds nothing but
 * `adopters.json`, and MERGING IT INTO main WOULD BE WRONG. If you are here
 * because a branch-tidying pass flagged it as stale, leave it alone.
 *
 * MISSING VERSUS CORRUPT DATA — these are different failures and are treated
 * differently. An absent branch, or an absent `adopters.json`, is the EXPECTED
 * state before the routine's first push: the run says so, leaves docs/ exactly
 * as it found it, renders no wall, and still reports on logo health. A file
 * that IS there but does not parse is a broken producer, not a first run, and
 * that is NEEDS-REVIEW. So is a THIRD case the missing/corrupt pair has no name
 * for: a file that is there, parses, and is weeks old. That is a producer that
 * stopped, and left unchecked it reads as a quiet week forever — the run finds no
 * data change and reports "logos healthy, no changes" over a frozen wall. The
 * file's own `lastScan` is what catches it; see MAX_STATE_AGE_DAYS.
 *
 * Two independent jobs run on EVERY invocation:
 *
 *   1. LOGO HEALTH — the avatar URLs this run will LEAVE on the page are probed
 *      for a 2xx: the live wall, minus the tiles this run is dropping, plus the
 *      tiles it is about to render (see probeTargets). A departing tile's dead
 *      avatar must not block the very change that removes it. When no candidate
 *      list was built — --verify-only, or no state file — nothing is departing,
 *      so the whole live wall is probed. This is deliberately NOT gated on the
 *      adopter data changing:
 *      an org can rotate its avatar or go private long after the wall was last
 *      written, and a broken image in a credibility section is worse than no
 *      section. A 2xx alone does not count, and neither does an image.
 *
 *      TWO SEPARATE FAILURE CLASSES, TWO SEPARATE CHECKS, because one cannot
 *      see the other:
 *        · A NON-NUMERIC path — `u/undefined`, `u/NaN`, an interpolation that
 *          produced an empty string — makes the CDN 302 to github.com and
 *          answer 200 `text/html`, which a browser paints as a broken image.
 *          The content-type check catches exactly and only that class.
 *        · A WRONG-BUT-NUMERIC owner id is invisible to the content-type
 *          check: EVERY numeric id returns a valid `image/*` 200. An
 *          out-of-range id gets a constant 5065-byte placeholder PNG; an
 *          in-range unassigned id gets a generated identicon; and a
 *          one-digit typo lands on a REAL DIFFERENT ACCOUNT whose avatar
 *          would be published on this page as though they were an adopter.
 *          So the id is separately resolved through `api.github.com/user/<id>`
 *          and its `login` must equal the repo's owner. See checkOwnerIdentity.
 *
 *      Silence from either check (timeout / rate-limit / 5xx) is INCONCLUSIVE
 *      and resolves to NEEDS-REVIEW, never SAFE.
 *   2. DATA REFRESH — forks and adopters missing from the latest scan are
 *      dropped and the rest are ranked by stargazers. Every survivor of the
 *      filters in rankSelectable renders, ONE TILE PER ORG (see selectAdopters,
 *      which is what holds `cacheplane` to a single tile): the wall is uncapped
 *      and grows with adoption, so a new adopter from a new org is a pure
 *      insertion and therefore auto-landable.
 *
 * TRUST MODEL — the state file is a candidate LIST, not a source of truth about
 * any repo's properties. It once marked `openclaw/openclaw` (388k stars, the
 * flagship adopter) and `Zoo-Code-Org/Zoo-Code` as forks; the GitHub API says
 * `fork: false` with no parent for both. Believing the file silently deleted the
 * biggest name on a public webpage. So `fork` and `stargazers_count` are read
 * from the API for every candidate, the file's `isFork` is used for NOTHING, and
 * any disagreement between the two is named in the summary — a broken producing
 * routine must be loud, not silently absorbed. Only `missedRuns` (which scan last
 * saw the repo) is still taken from the file: that is a fact about the scan, not
 * about the repo, and the file is its only possible source.
 *
 * Two structural floors exist on top of that, because a resilient reader of bad
 * data is still only as good as the data: the wall may never fall below
 * MIN_WALL_SIZE tiles, and the highest-starred candidate the wall is ALLOWED to
 * render may never be dropped by the exclusion rules. Either one forces
 * NEEDS-REVIEW no matter what the data says, so the flagship adopter can never
 * quietly vanish from main again. "Allowed to render" is doing real work in that
 * sentence: a repo the API itself calls a fork was never eligible for the wall,
 * so pointing the guard at one wedges every future run at NEEDS-REVIEW over a
 * tile that could never have been there. See topCandidate.
 *
 * Logos are hot-linked from the GitHub avatar CDN by NUMERIC OWNER ID
 * (`/u/<id>`), not by login, so an org rename does not break the image. Local
 * avatar caching under docs/ was considered and explicitly rejected: do not
 * "fix" this back to committing binaries.
 *
 * Exit codes (the workflow branches on these, not on prose):
 *   0  CLEAN         — logos healthy, no data change. Nothing to commit.
 *   10 CHANGED_SAFE  — logos healthy, the wall changed, and none of the
 *                      guardrails listed under 20 fired. Safe to push. This is
 *                      NOT "the wall only grew": classify() returns SAFE for any
 *                      change it found no reason to stop, which includes
 *                      reorders, star-driven reshuffles, avatar refreshes and
 *                      EXPLAINED removals. A removal can auto-land. See classify.
 *   20 NEEDS_REVIEW  — human. Any of: a logo is dead or unverifiable; the wall
 *                      shrank past its explained removals; it would render fewer
 *                      than MIN_WALL_SIZE tiles; the highest-starred candidate the
 *                      wall was allowed to render was excluded; a tile on the page
 *                      today is absent from the new list with no explanation; or
 *                      adopter state was present and unusable, or weeks stale.
 *                      See classify.
 *   1  ERROR         — the run itself failed.
 *
 * --dry-run and --verify-only write nothing, so they never return 10: with
 * nothing on disk to commit, "safe to push" would be a claim about a file that
 * was never written. They return 0 or 20.
 *
 * Usage:
 *   npx tsx scripts/update-adoption-wall.ts                     # update in place
 *   npx tsx scripts/update-adoption-wall.ts --verify-only       # logo health only
 *   npx tsx scripts/update-adoption-wall.ts --dry-run           # show changes only
 *   npx tsx scripts/update-adoption-wall.ts --summary out.md    # write markdown summary
 *   npx tsx scripts/update-adoption-wall.ts --state f.json      # local state file
 *   npx tsx scripts/update-adoption-wall.ts --meta-file f.json  # local repo meta (testing)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Types ────────────────────────────────────────────────────────────────────

/** One entry as written by the weekly adoption scan. */
export interface AdopterState {
  repo: string;
  channels?: string[];
  isFork?: boolean;
  missedRuns?: number;
  firstSeen?: string;
}

export interface AdoptersState {
  lastScan?: string;
  adopters?: AdopterState[];
}

/**
 * Per-repo facts resolved from the GitHub API (or injected for testing).
 * Every field here is the API's answer. Nothing in this record is copied from
 * the adopter state file — that is the whole point of the record existing.
 */
export interface RepoMeta {
  stars: number;
  ownerId: number;
  /**
   * The API's `fork` field. Deliberately not optional: a missing fork answer is
   * a bug in the fetch path, and defaulting it to `false` silently would be the
   * same class of mistake as trusting the state file.
   */
  isFork: boolean;
}

/** One repo where the state file's `isFork` and the API's `fork` do not agree. */
export interface ForkDisagreement {
  repo: string;
  stateSaysFork: boolean;
  apiSaysFork: boolean;
}

/** A fully-resolved tile, ready to render. */
export interface WallEntry {
  repo: string;
  name: string;
  url: string;
  logo: string;
  stars: number;
  /** False when no ADOPTER_DISPLAY entry existed and we fell back to the org name. */
  mapped: boolean;
  /** Curated: render the logo on a near-white chip. See AdopterDisplay.chip. */
  chip: boolean;
  /** Curated: render a letter instead of an image. See AdopterDisplay.monogram. */
  monogram: boolean;
}

export interface CheckResult {
  url: string;
  /** Which adopter this URL belongs to, for a legible summary. */
  repo: string;
  ok: boolean;
  /** HTTP status, or null when the request never produced one. */
  status: number | null;
  /**
   * "ok"           — 2xx AND an image/* body.
   * "http"         — the server answered and the answer is not a live image. That
   *                  covers a definite non-2xx AND a 2xx whose content-type is not
   *                  image/*, which is the CDN's answer for an unresolvable owner
   *                  id and the single most important case this probe exists to
   *                  catch. `status` is 200 in that case; `ok` is what decides.
   * "identity"     — the image is alive but belongs to the WRONG GitHub account:
   *                  the avatar's numeric owner id does not resolve to the repo's
   *                  owner, so the tile would show someone else's logo.
   * "inconclusive" — no verdict was reached: timeout, network error, 429, 403 or
   *                  5xx. Never SAFE, never "dead".
   */
  kind: "ok" | "http" | "identity" | "inconclusive";
  detail: string;
}

export type WallStatus = "CLEAN" | "SAFE" | "NEEDS-REVIEW";

/**
 * A tile that left the wall for a reason we chose. Structured rather than
 * pre-formatted so the summary can group 130 star-floor drops into one line
 * while still listing each hand-curated exclusion individually — a transition
 * week produces far too many to read as a flat list.
 */
export interface DropNote {
  repo: string;
  kind: "star-floor" | "exclude-list" | "org-handover";
  detail: string;
  stars: number | null;
}

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * The wall is UNCAPPED: every qualifying adopter renders, and the wall grows as
 * adoption grows. There is deliberately no top-N.
 *
 * This is not cosmetic. Under a fixed cap, a genuinely new adopter pushes the
 * incumbent last-place tile off the wall, which trips the "was on the wall
 * yesterday, absent today" guardrail and forces a PR — so the auto-land path
 * would only ever fire for star reshuffles, and every real adopter would need a
 * human click. Uncapped, a new adopter is a pure INSERTION: nothing is evicted,
 * the disappearance guardrail stays silent, and the run classifies SAFE and
 * lands itself. The guardrail then means what it was always supposed to mean —
 * an adopter genuinely vanished — instead of firing on routine growth.
 *
 * A STAR FLOOR does exist and is a separate decision from the cap: see
 * STAR_FLOOR below, which is 40 and is there so the wall is not padded out with
 * repos nobody has heard of. It is not a cap — it evicts nobody as the wall
 * grows, so it does not break the pure-insertion property above. What must not
 * come back is a TOP-N, or any other threshold that makes one adopter's place
 * on the wall depend on another adopter's numbers: that is a cap in disguise.
 */

/**
 * The wall may never auto-land below this many tiles. This is a floor on the
 * OUTPUT, not a statement about the data: whatever combination of bad input,
 * bad fork classification or API flakiness produced a four-logo wall, a
 * four-logo wall is not something that should reach main without a human.
 */
export const MIN_WALL_SIZE = 8;

export const EXIT_CLEAN = 0;
export const EXIT_CHANGED_SAFE = 10;
export const EXIT_NEEDS_REVIEW = 20;
export const EXIT_ERROR = 1;

/**
 * The orphan branch holding the adopter state, and the file on it. The workflow
 * checks the branch out into ./adoption-data/ and the script reads it from
 * there; `--state <path>` overrides, which is how this runs with no network.
 *
 * ORPHAN. NEVER MERGE `adoption-data` INTO main. See the note at the top.
 */
export const STATE_BRANCH = "adoption-data";
export const STATE_FILE = "adopters.json";

export const START_SENTINEL = "<!-- adoption-wall:start -->";
export const END_SENTINEL = "<!-- adoption-wall:end -->";

/**
 * One adopter's curated identity and rendering treatment.
 *
 * `chip` and `monogram` are HUMAN JUDGEMENT, and deliberately not runtime
 * detection. A heuristic that sampled each avatar's colours at build time would
 * misfire on a logo that is merely dark, would flip the day an org rotates its
 * avatar, and would be unreviewable when it got it wrong. A flag in this table
 * is one line in a diff, with a maintainer's name on it.
 */
export interface AdopterDisplay {
  name: string;
  url: string;
  /**
   * Render the logo on a subtle near-white rounded tile: same 40x40 footprint,
   * mark inset a few px. Set this when the logo is dark-on-transparent, which
   * is INVISIBLE against this page's near-black ground — Karakeep's avatar is a
   * single colour, pure black, so at rest it renders as an empty square, and
   * the greyscale-at-rest treatment only makes it worse. Standard practice on
   * dark enterprise sites. The test to apply is simply: can you see it?
   */
  chip?: boolean;
  /**
   * Render the first letter of `name`, in the page's sans face on a card
   * background, instead of an image. For an adopter with no usable logo at all
   * — a default GitHub identicon, or an avatar that has gone dead. Same 40x40
   * rounded footprint, so the strip never shifts. Nothing needs this today; it
   * exists so that the first adopter who does is a one-word change.
   */
  monogram?: boolean;
}

/**
 * Hand-maintained repo -> display identity. GitHub org logins and repo names
 * are rarely the name a company markets itself under, and the homepage is
 * almost never the repo URL, so this cannot be derived. An adopter with no
 * entry here still renders, using the org login and the repo URL, and is
 * called out in the summary so a human can add a proper pair later.
 */
export const ADOPTER_DISPLAY: Record<string, AdopterDisplay> = {
  "openclaw/openclaw": { name: "OpenClaw", url: "https://openclaw.ai" },
  "botiverse/oar": { name: "botiverse", url: "https://github.com/botiverse/oar" },
  "mattermost/mattermost-plugin-agents": {
    name: "Mattermost",
    url: "https://mattermost.com/copilot",
  },
  "deepnote/vscode-deepnote": { name: "Deepnote", url: "https://www.deepnote.com" },
  "ComposioHQ/composio": { name: "Composio", url: "https://composio.dev" },
  "mastra-ai/mastra": { name: "Mastra", url: "https://mastra.ai" },
  // chip: the Karakeep avatar is a single colour, pure black. On --bg-deep it is
  // an invisible square without one.
  "karakeep-app/karakeep": { name: "Karakeep", url: "https://karakeep.app", chip: true },
  "TanStack/ai": { name: "TanStack", url: "https://tanstack.com/ai/latest" },
  "ag-ui-protocol/ag-ui": { name: "AG-UI", url: "https://ag-ui.com" },
  "Shubhamsaboo/awesome-llm-apps": { name: "The Unwind AI", url: "https://www.theunwindai.com" },
  "testomatio/explorbot": { name: "Testomat.io", url: "https://testomat.io" },
  "cacheplane/dawnai": { name: "Dawn AI", url: "https://dawnai.org" },
  "cacheplane/angular-agent-framework": { name: "Threadplane", url: "https://threadplane.ai" },
  "atomicstrata/llm-wiki-compiler": {
    name: "Atomic Strata",
    url: "https://llmwiki.atomicstrata.ai",
  },
  "openstory-so/openstory": { name: "OpenStory", url: "https://openstory.so" },
  "SkillNerds/xskill": { name: "xskill", url: "https://xskill.wiki" },
  "selfagency/opilot": { name: "Opilot", url: "https://opilot.self.agency" },
  // No homepage exists for either of these: cortexkit declares a Discord invite
  // and ant-chat declares nothing, and cortexkit.dev/.ai/.com do not resolve. A
  // repo URL is honest when there is no site; a bare GitHub login is just an
  // unfilled blank, so both still get a real display name.
  "cortexkit/magic-context": {
    name: "CortexKit",
    url: "https://github.com/cortexkit/magic-context",
  },
  "ysansan98/ant-chat": { name: "Ant Chat", url: "https://github.com/ysansan98/ant-chat" },
  "thushan/olla": { name: "Tensor Foundry", url: "https://tensorfoundry.io/products/olla" },
  "marieai/marie-ai": { name: "Marie AI", url: "https://marieai.co" },
  "Zoo-Code-Org/Zoo-Code": { name: "Zoo Code", url: "https://www.zoocode.dev" },
  "BodhiSearch/BodhiApp": { name: "Bodhi", url: "https://getbodhi.app" },
  "liveloveapp/hashbrown": { name: "Hashbrown", url: "https://www.hashbrown.dev" },
  "octelium/octelium": { name: "Octelium", url: "https://octelium.com" },
  "supabitapp/supaterm": { name: "Supaterm", url: "https://supaterm.com" },
  // The original Supaterm repo, renamed to -legacy when supabitapp started a new
  // `supaterm` repo. Same product (README title "Supaterm"), and it is the one
  // that uses aimock (apps/mac/E2EModelServer), so it gets the same identity.
  "supabitapp/supaterm-legacy": { name: "Supaterm", url: "https://supaterm.com" },
  "tercumantanumut/selene": { name: "Selene", url: "https://selene.engineer" },
  // The repo declares no homepage; the EmberAGI org does (emberai.xyz), and the
  // README links "Ember AI" there, so that is the company behind the repo.
  "EmberAGI/arbitrum-vibekit": { name: "Ember AI", url: "https://www.emberai.xyz" },
  "agentskillexchange/skills": {
    name: "Agent Skill Exchange",
    url: "https://agentskillexchange.com",
  },
  "affromero/flight-finder": { name: "Flight Finder", url: "https://flight-finder.org" },
  "alpic-ai/skybridge": { name: "Skybridge", url: "https://www.skybridge.tech" },
  "ackness/covel": { name: "Covel", url: "https://covel.cc" },
};

/**
 * Minimum stars to appear on the wall.
 *
 * An ABSOLUTE threshold, deliberately: a repo clears it or does not, and no
 * other adopter's star count is involved. That is what keeps a new adopter a
 * pure insertion rather than an eviction. See the note above MIN_WALL_SIZE.
 *
 * WHY 40 AND NOT 50: 50 was the obvious round number and the line the manual
 * analysis used. `deepnote/vscode-deepnote` sits at 45. Deepnote is a funded
 * company, and the repo the scan matched is a single VS Code extension — the
 * star count is measuring the extension, not the company. 40 keeps Deepnote.
 * Do not "tidy" this back up to 50.
 */
export const STAR_FLOOR = 40;

/**
 * Explicit deny-list, applied AFTER the star floor. One entry per line,
 * `"owner/repo": "reason"`, alphabetical (case-insensitively) BY KEY. A human
 * edits this by hand — keep it greppable and keep the reason specific enough to
 * audit and reverse. The order is not decoration: a hand-edited list only stays
 * auditable while an entry is findable, and the natural edit is to file a new
 * entry beside the repo it is a copy of rather than in its sorted place, which is
 * how `rivet-dev/agentos` ended up under `CrimsonSithria`. A test asserts the
 * order, so a misfiled entry fails the suite instead of quietly accumulating.
 *
 * This exists because a star count cannot tell a real product from a popular
 * copy. The dominant junk class is verbatim re-pushes of openclaw: a fresh repo
 * containing another project's source and README, which GitHub records no fork
 * relationship for, so no fork filter can catch it. Every reason below states the
 * evidence it was judged on, not just a verdict.
 *
 * The second junk class is LOCKFILE-ONLY matches. The upstream scan reports a
 * repo as a `package` adopter when aimock appears anywhere in its dependency
 * graph, including as a transitive dependency recorded in a lockfile that no
 * package.json asks for and no source file imports. That is not usage, and the
 * wall is captioned "teams building on aimock". Before adding a repo here on
 * those grounds, clone it and check: `grep -ril aimock` hitting only `*lock*`
 * files, with no `package.json` declaration, is the signature.
 *
 * Bias when adding: a wrongly-excluded real adopter is invisible and never gets
 * noticed, while a wrongly-included one is visible on the homepage and gets
 * fixed. So the uncertain case does NOT get an entry — if unsure, add nothing and
 * leave the repo on the wall.
 *
 * Entries currently below STAR_FLOOR are kept deliberately: they act as a ratchet
 * if the repo ever gains stars. The run summary reports how many entries actually
 * suppressed something, so this never becomes a filter nobody remembers exists.
 */
export const EXCLUDED_ADOPTERS: Record<string, string> = {
  "AdemBenAbdallah/openstory-tanstack-cloudflare-template":
    'Self-described derivative: README opens "A hands-on learning template derived from the MIT-licensed OpenStory project". openstory-so/openstory is the original and is already on the wall.',
  "CrimsonSithria/agentos":
    "Copy of rivet-dev/agentos: same README banner and same homepage (agentos-sdk.dev) as the original, on a personal account with 2 followers. Not a GitHub fork, so the fork filter cannot see it.",
  "podhmo/llm-wiki-compiler":
    'Self-declared copy: README\'s first line is "Personal fork of https://github.com/atomicstrata/llm-wiki-compiler — do not merge". atomicstrata/llm-wiki-compiler is the original and is already on the wall.',
  "rivet-dev/agentos":
    "Not an aimock user: the ONLY two occurrences in the repo are pnpm-lock.yaml entries, and they are TRANSITIVE (@copilotkit/llmock@1.7.1 depends on @copilotkit/aimock@1.7.0). No package.json declares it and no source, test, config or doc references it. A lockfile mention is not usage.",
  "seek4coherence/Zoo-Code":
    'Self-declared copy: repo description is "Fork of Zoo-Code for PR: Remote Access WebUI + Discord Bot". Zoo-Code-Org/Zoo-Code is the original and is already on the wall.',
  "tylaujjapan0/openclaw":
    "Verbatim re-push of openclaw/openclaw: README is openclaw's README including its hot-linked logo. Throwaway account (3 repos, 0 followers). Not a GitHub fork.",
  "unprofessional/openclaw-archive":
    "Verbatim re-push of openclaw/openclaw: README is openclaw's README including its hot-linked logo, and the repo name says archive. Not a GitHub fork.",
  "zapabob/clawdbot":
    "Verbatim re-push of openclaw/openclaw: repo description and README are openclaw's word for word. Not a GitHub fork.",
};

/**
 * Case-insensitive index, for the same reason `excludeReason` and the org
 * dedupe normalise: the producer's casing is not guaranteed to be the repo's
 * canonical casing, and a curated name that silently stops applying renders a
 * raw org login on a public page while `missingFromState` reports nothing.
 */
const DISPLAY_BY_LOWER = new Map(
  Object.entries(ADOPTER_DISPLAY).map(([repo, display]) => [repo.toLowerCase(), display]),
);

/** Case-insensitive index, so casing drift in the state file cannot bypass the list. */
const EXCLUDED_BY_LOWER = new Map(
  Object.entries(EXCLUDED_ADOPTERS).map(([repo, reason]) => [repo.toLowerCase(), reason]),
);

/** The exclusion reason for a repo, or null if it is not excluded. */
export function excludeReason(repo: string): string | null {
  return EXCLUDED_BY_LOWER.get(repo.toLowerCase()) ?? null;
}

/**
 * `import.meta.dirname` only exists from Node 20.11. The fallback must be
 * `import.meta.url`, not `__dirname`: this file is ESM, `__dirname` is not
 * defined there at all, so naming it degrades into a ReferenceError instead of
 * into the older spelling.
 */
const SCRIPT_DIR = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DOCS_PATH = resolve(REPO_ROOT, "docs/index.html");
/**
 * Where the workflow checks the orphan branch out to. `--state <path>` overrides
 * it, which is all a local run needs in order to work with no network at all.
 */
const DEFAULT_STATE_PATH = resolve(REPO_ROOT, STATE_BRANCH, STATE_FILE);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "aimock-adoption-wall-updater",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

/**
 * How stale `lastScan` may be before the state file stops counting as current.
 *
 * The producing routine runs weekly, so 21 days is three scans: past any single
 * delayed or skipped run, and not reachable by a schedule that is merely late.
 * Without this check the file's own freshness field was declared and never read,
 * and a frozen producer reported CLEAN forever — the run sees last month's
 * `adopters.json`, finds no data change, and Slack says "logos healthy, no
 * changes" while the wall is silently frozen. That is precisely the failure the
 * corrupt-state branch exists to prevent, arriving through the one door the
 * taxonomy (missing vs corrupt) had no name for: present, parses, weeks old.
 */
export const MAX_STATE_AGE_DAYS = 21;

/**
 * What the state file's `lastScan` says about its own freshness.
 *
 * An ABSENT `lastScan` is reported and does not gate: the field is optional in
 * AdoptersState, so a producer that has never written it would otherwise wedge
 * every run at NEEDS-REVIEW over a field nobody promised. An UNPARSEABLE one
 * does gate — that is a producer writing garbage, which is the corrupt case.
 */
export function stateFreshness(
  lastScan: string | undefined,
  now: Date = new Date(),
): { kind: "fresh" | "stale" | "unusable" | "absent"; detail: string } {
  if (lastScan === undefined) {
    return {
      kind: "absent",
      detail: `Adopter state carries no \`lastScan\`, so its age cannot be checked.`,
    };
  }
  const scanned = new Date(lastScan);
  if (Number.isNaN(scanned.getTime())) {
    return {
      kind: "unusable",
      detail: `Adopter state has a \`lastScan\` of "${lastScan}", which is not a date.`,
    };
  }
  const days = Math.floor((now.getTime() - scanned.getTime()) / 86_400_000);
  if (days > MAX_STATE_AGE_DAYS) {
    return {
      kind: "stale",
      detail:
        `Adopter state was last scanned ${days} day(s) ago (${lastScan}), past the ` +
        `${MAX_STATE_AGE_DAYS}-day limit: the routine that writes \`${STATE_FILE}\` on the ` +
        `orphan \`${STATE_BRANCH}\` branch has stopped, so the wall is frozen on stale data.`,
    };
  }
  return { kind: "fresh", detail: `Adopter state last scanned ${days} day(s) ago (${lastScan}).` };
}

/** Per-request budget for an avatar probe. Kept short: this is a health ping. */
const CHECK_TIMEOUT_MS = 8000;
/**
 * Retries on a transient (inconclusive: timeout / network / 403 / 429 / 5xx)
 * result before giving up. TWO, not one: with one retry `retryDelayMs`'s
 * exponential never ran, so the exported signature and the note below described a
 * backoff curve that in practice was a single flat second — and one second is
 * thin for the rate-limit the retry exists for. An inconclusive probe forces
 * NEEDS-REVIEW, so a retry that gives up too early costs a human a Monday.
 */
const CHECK_RETRIES = 2;
/**
 * Wait between a transient failure and the retry. An immediate re-request is
 * the one thing that cannot help the case the retry exists for: a 429 is the
 * CDN asking for a pause, and a timeout means the connection had not answered
 * yet — retrying in the same millisecond just spends the second attempt on the
 * same condition.
 */
const CHECK_RETRY_BASE_MS = 1000;
export function retryDelayMs(attempt: number): number {
  return CHECK_RETRY_BASE_MS * 2 ** attempt;
}
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
/** We hit a third-party CDN once per adopter per run; stay modest. */
const CHECK_CONCURRENCY = 4;

// ── HTML helpers ─────────────────────────────────────────────────────────────

/**
 * Everything interpolated into the wall originates in an external JSON file or
 * the GitHub API, so every value is treated as untrusted.
 */
/**
 * One value going into a `|`-delimited markdown table cell. Same reasoning as
 * escapeHtml, different sink: a repo name arrives from the state file and an
 * exclusion reason is hand-written prose, and either one containing a pipe or a
 * newline silently breaks the row it sits in — including inside backticks, which
 * GitHub does NOT treat as escaping a cell separator. The break is silent: the
 * PR body still renders, just with the columns shifted, which is exactly the
 * class of quiet lie the rest of this file is written against.
 */
export function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inverse of escapeHtml, for reading attribute values back off the page. Without
 * this the parsed avatar URL keeps its `&amp;` and the health check probes a URL
 * the browser never requests.
 */
export function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Only http(s) links are ever emitted; anything else degrades to the fallback. */
export function safeUrl(candidate: string, fallback: string): string {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return candidate;
  } catch {
    /* fall through */
  }
  return fallback;
}

export function orgOf(repo: string): string {
  return repo.split("/")[0] ?? repo;
}

/**
 * Repo identity for comparison. GitHub treats `owner/name` case-insensitively
 * and the producer's casing is not guaranteed to match the casing already on the
 * page, so anything that decides whether a tile SURVIVED has to normalise —
 * `excludeReason`, `resolveDisplay` and the org dedupe all already do. Comparing
 * exact case there means a repo respelled between two scans stops matching its
 * own successor: the tile reads as a disappearance, its star-floor removal loses
 * its explanation and escalates to a NEEDS-REVIEW alarm, and a slot that never
 * changed hands is reported as an org handover.
 */
export function repoKey(repo: string): string {
  return repo.toLowerCase();
}

/**
 * `meta.get` that tolerates the same casing drift. The map is keyed by the string
 * the state file asked about; the alarm paths look up the string the PAGE was
 * written with, and the two are not guaranteed to agree.
 */
export function metaFor(repo: string, meta: Map<string, RepoMeta>): RepoMeta | undefined {
  const direct = meta.get(repo);
  if (direct) return direct;
  const want = repoKey(repo);
  for (const [key, m] of meta) {
    if (repoKey(key) === want) return m;
  }
  return undefined;
}

export function avatarUrl(ownerId: number): string {
  return `https://avatars.githubusercontent.com/u/${ownerId}?s=128&v=4`;
}

/** Mapped identity if we have one, else org login + repo URL, flagged unmapped. */
export function resolveDisplay(repo: string): {
  name: string;
  url: string;
  mapped: boolean;
  chip: boolean;
  monogram: boolean;
} {
  const repoUrl = `https://github.com/${repo}`;
  const entry = DISPLAY_BY_LOWER.get(repo.toLowerCase());
  if (entry) {
    return {
      name: entry.name,
      url: safeUrl(entry.url, repoUrl),
      mapped: true,
      chip: entry.chip === true,
      monogram: entry.monogram === true,
    };
  }
  return { name: orgOf(repo), url: repoUrl, mapped: false, chip: false, monogram: false };
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * Every adopter the scan still sees, resolved against the API, ranked. This is
 * the population BEFORE the fork rule is applied, so callers can ask what the
 * fork rule cost them. Ties break on repo name, so the order is stable run to run.
 *
 * The exclude list IS honoured here, and the fork flag is not, because the two
 * are opposites: the exclude list is a human decision we should not keep
 * re-litigating, while the fork flag is the untrusted signal this whole file
 * exists to second-guess. Without this, one hand-excluded repo with a big star
 * count would pin topCandidate forever and the wall could never auto-land again.
 */
export function rankCandidates(
  adopters: AdopterState[],
  meta: Map<string, RepoMeta>,
): { repo: string; stars: number; isFork: boolean }[] {
  return adopters
    .filter((a) => !(typeof a.missedRuns === "number" && a.missedRuns > 0))
    .filter((a) => meta.has(a.repo))
    .filter((a) => excludeReason(a.repo) === null)
    .map((a) => ({
      repo: a.repo,
      stars: meta.get(a.repo)!.stars,
      isFork: meta.get(a.repo)!.isFork,
    }))
    .sort((x, y) => y.stars - x.stars || x.repo.localeCompare(y.repo));
}

/**
 * The single biggest name the wall is actually ALLOWED to render this run. If
 * this repo does not survive to the rendered wall, something excluded the
 * flagship adopter and a human needs to look at it.
 *
 * Repos the GITHUB API calls forks are passed over here, and reported in
 * `forksOutranking` rather than dropped silently. This is not the state file's
 * `isFork` — that flag is never consulted anywhere in this file and
 * `rankCandidates` still ranks before the fork rule so the rule's cost stays
 * measurable. It is the API's answer, which `selectAdopters` is REQUIRED to act
 * on: handing classify a candidate the fork rule must drop wedged every run at
 * NEEDS-REVIEW with no way to clear it, which is a guard that has stopped
 * guarding anything. Passing over the fork keeps the guard pointed at the
 * biggest name that could genuinely have vanished.
 *
 * STAR_FLOOR is passed over for exactly the same reason and it is not a lesser
 * case: `rankCandidates` does not apply the floor, so on a run where nothing
 * clears 40 stars the highest-starred candidate is one the wall was never
 * allowed to render, and reporting it as "excluded from the wall" points a human
 * at a silent deletion that never happened. Because `ranked` is sorted by stars
 * descending, the first candidate under the floor means every remaining one is
 * too, so there is no flagship left to guard and the answer is null.
 */
export function topCandidate(
  adopters: AdopterState[],
  meta: Map<string, RepoMeta>,
): { repo: string; stars: number; forksOutranking: string[] } | null {
  const ranked = rankCandidates(adopters, meta);
  const forksOutranking: string[] = [];
  for (const candidate of ranked) {
    if (candidate.isFork) {
      forksOutranking.push(candidate.repo);
      continue;
    }
    if (candidate.stars < STAR_FLOOR) break;
    return { repo: candidate.repo, stars: candidate.stars, forksOutranking };
  }
  return null;
}

/**
 * Where the state file's fork claim and the API's `fork` field disagree. A
 * non-empty result means the routine that writes the state file is misclassifying
 * repos, which is exactly how the flagship adopter went missing. We proceed on
 * the API's answer and say so out loud rather than absorbing the divergence.
 */
export function forkDisagreements(
  adopters: AdopterState[],
  meta: Map<string, RepoMeta>,
): ForkDisagreement[] {
  const out: ForkDisagreement[] = [];
  for (const a of adopters) {
    const m = meta.get(a.repo);
    if (!m) continue;
    // An ABSENT isFork is no claim at all, and a claim is what a disagreement
    // needs. Reading `undefined` as "not a fork" invents a position the producer
    // never took and reports the whole file as disagreeing the day it stops
    // writing the field.
    if (typeof a.isFork !== "boolean") continue;
    const stateSaysFork = a.isFork;
    if (stateSaysFork !== m.isFork) {
      out.push({ repo: a.repo, stateSaysFork, apiSaysFork: m.isFork });
    }
  }
  return out.sort((x, y) => x.repo.localeCompare(y.repo));
}

/**
 * Repos we hand-curated a display identity for that the incoming scan does not
 * mention at all. `cacheplane/dawnai` is a real adopter — it runs aimock in
 * `packages/testing/src/aimock-runner.ts` and in a k8s smoke deployment — and is
 * absent from a 182-entry state file. The wall stays generated (nothing is
 * hardcoded in), but a discovery gap that used to be invisible is now a line
 * item somebody reads.
 */
export function missingFromState(
  adopters: AdopterState[],
  mapping: Record<string, AdopterDisplay> = ADOPTER_DISPLAY,
): string[] {
  const seen = new Set(adopters.map((a) => a.repo.toLowerCase()));
  return Object.keys(mapping)
    .filter((repo) => !seen.has(repo.toLowerCase()))
    .sort((x, y) => x.localeCompare(y));
}

/**
 * Why a repo that is on the wall today is not on the new list — but only for the
 * reasons we chose ON PURPOSE. The star floor and the exclude list are deliberate
 * editorial filters, so a tile leaving through one of them is a decision taking
 * effect, not an adopter vanishing, and it must not raise an alarm.
 *
 * Everything else returns null and stays alarming: a repo the scan stopped
 * seeing, or one the API newly calls a fork, is exactly the silent-deletion case
 * this file exists to catch, and no amount of "the data said so" excuses it.
 */
export function explainDrop(repo: string, meta: Map<string, RepoMeta>): DropNote | null {
  const reason = excludeReason(repo);
  if (reason) {
    return {
      repo,
      kind: "exclude-list",
      detail: reason,
      stars: metaFor(repo, meta)?.stars ?? null,
    };
  }
  const m = metaFor(repo, meta);
  if (m && !m.isFork && m.stars < STAR_FLOOR) {
    return {
      repo,
      kind: "star-floor",
      detail: `below the ${STAR_FLOOR}-star floor (now ${m.stars})`,
      stars: m.stars,
    };
  }
  return null;
}

/**
 * Splits today's tiles that are absent from the new list into the ones we can
 * account for and the ones we cannot.
 *
 * The third accountable reason lives here rather than in `explainDrop` because
 * it is the only one that cannot be decided from the departing repo alone: the
 * wall renders ONE TILE PER ORG, so when an org's second repo overtakes its
 * first, the slot changes hands and the outgoing repo is absent from the new
 * list. The org never left the wall, so this is not a disappearance — but
 * seeing that requires knowing who holds the slot now, which means `next`.
 *
 * A handover requires the outgoing repo to STILL EXIST. Without that test, an
 * adopter's repo being deleted, made private or taken down is laundered into a
 * note the moment any other repo from the same org is on the new list — a note
 * does not gate, so the run reports SAFE and the workflow pushes the shrunken
 * wall to main with nobody told. "The slot changed hands" and "the repo is gone"
 * are opposite facts and only `meta` can tell them apart.
 */
export function partitionDrops(
  current: ParsedTile[],
  next: WallEntry[],
  meta: Map<string, RepoMeta>,
): { explained: DropNote[]; unexplained: string[] } {
  const nextRepos = new Set(next.map((e) => repoKey(e.repo)));
  const successorByOrg = new Map<string, string>();
  for (const e of next) {
    const org = orgOf(e.repo).toLowerCase();
    if (!successorByOrg.has(org)) successorByOrg.set(org, e.repo);
  }
  const explained: DropNote[] = [];
  const unexplained: string[] = [];
  for (const tile of current) {
    if (nextRepos.has(repoKey(tile.repo))) continue;
    const why = explainDrop(tile.repo, meta);
    if (why) {
      explained.push(why);
      continue;
    }
    const m = metaFor(tile.repo, meta);
    const successor = successorByOrg.get(orgOf(tile.repo).toLowerCase());
    if (m && successor) {
      explained.push({
        repo: tile.repo,
        kind: "org-handover",
        detail: `the ${orgOf(tile.repo)} slot is held by \`${successor}\` this run`,
        stars: m.stars,
      });
      continue;
    }
    unexplained.push(tile.repo);
  }
  return { explained, unexplained };
}

/**
 * Everything the wall requires of a candidate EXCEPT the exclude list: the latest
 * scan must still see the repo, the API must have answered for it, and the answer
 * must be a non-fork clearing STAR_FLOOR.
 *
 * It is a named predicate rather than an inline filter chain because two callers
 * need it and they must not drift: `rankSelectable`, which decides the wall, and
 * the run's "what did the exclude list actually do" report, which claims to name
 * the repos that "had cleared the 40-star floor this run". Hand-copied filters
 * mean the next change to eligibility silently makes that report describe a wall
 * nobody rendered.
 */
export function clearsWallFilters(a: AdopterState, meta: Map<string, RepoMeta>): boolean {
  if (typeof a.missedRuns === "number" && a.missedRuns > 0) return false;
  const m = meta.get(a.repo);
  if (!m) return false;
  return !m.isFork && m.stars >= STAR_FLOOR;
}

/**
 * Five filters, in order: the latest scan must still see the repo (missedRuns),
 * the API must have RESOLVED it at all — an unresolved repo has no stars and no
 * owner id, so there is nothing to rank or render — it must not be a fork by the
 * API's answer, it must clear STAR_FLOOR, and it must not be on
 * EXCLUDED_ADOPTERS. Survivors rank by stars, ties broken by repo name so the
 * output is stable run to run.
 *
 * The state file claims 149 of its 182 entries are forks. The API says only 11
 * of those actually are. The rest are CLONES AND RE-PUSHES — someone copied a
 * project's source into a fresh repo rather than pressing Fork, so GitHub records
 * no fork relationship and no fork filter, ours or anyone's, can see them. That
 * is the entire reason EXCLUDED_ADOPTERS has to exist alongside the star floor.
 *
 * Fork status comes from `meta` — the GitHub API — and never from the state
 * file's `isFork`. See the TRUST MODEL note at the top of this file: the file
 * has labelled canonical upstream repos as forks, and acting on that deleted the
 * biggest adopter from the homepage.
 *
 * One tile per ORG is applied on top of this by `selectAdopters`.
 */
function rankSelectable(adopters: AdopterState[], meta: Map<string, RepoMeta>): WallEntry[] {
  return adopters
    .filter((a) => clearsWallFilters(a, meta))
    .filter((a) => excludeReason(a.repo) === null)
    .map((a) => {
      const m = meta.get(a.repo)!;
      const { name, url, mapped, chip, monogram } = resolveDisplay(a.repo);
      return {
        repo: a.repo,
        name,
        url,
        logo: avatarUrl(m.ownerId),
        stars: m.stars,
        mapped,
        chip,
        monogram,
      };
    })
    .sort((x, y) => y.stars - x.stars || x.repo.localeCompare(y.repo));
}

/** One repo an org lost its single slot to, and the repo that took it. */
export interface OrgRunnerUp {
  repo: string;
  org: string;
  stars: number;
  /** The same org's higher-ranked repo, which holds the slot. */
  winner: string;
}

/**
 * One tile per ORG, not per repo: this is a wall of teams, and an org with two
 * adopting repos would otherwise render as two identical logos side by side.
 * The org's highest-ranked repo wins the slot, and everything it beat comes
 * back as a runner-up rather than disappearing without a word — `cacheplane`
 * has two hand-curated adopters (Threadplane and Dawn AI) and exactly one of
 * them can render, which is a decision a human should be able to read.
 */
function dedupeByOrg(ranked: WallEntry[]): { entries: WallEntry[]; runnersUp: OrgRunnerUp[] } {
  const winnerByOrg = new Map<string, WallEntry>();
  const entries: WallEntry[] = [];
  const runnersUp: OrgRunnerUp[] = [];
  for (const entry of ranked) {
    const org = orgOf(entry.repo).toLowerCase();
    const winner = winnerByOrg.get(org);
    if (winner) {
      runnersUp.push({
        repo: entry.repo,
        org: orgOf(entry.repo),
        stars: entry.stars,
        winner: winner.repo,
      });
      continue;
    }
    winnerByOrg.set(org, entry);
    entries.push(entry);
  }
  return { entries, runnersUp };
}

export function selectAdopters(adopters: AdopterState[], meta: Map<string, RepoMeta>): WallEntry[] {
  return dedupeByOrg(rankSelectable(adopters, meta)).entries;
}

/**
 * The adopters that qualified for the wall on every other count and were then
 * removed by the one-tile-per-org rule. Reported so the rule can never silently
 * eat a curated adopter.
 */
export function orgRunnersUp(adopters: AdopterState[], meta: Map<string, RepoMeta>): OrgRunnerUp[] {
  return dedupeByOrg(rankSelectable(adopters, meta)).runnersUp;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Seconds per tile in the marquee loop.
 *
 * The duration SCALES WITH TILE COUNT so that a given tile always takes the same
 * time to cross the viewport. A hardcoded duration would make the strip faster
 * every time an adopter was added, and an adoption wall that grows is the entire
 * point of this script. 2.9s/tile puts the current 22 tiles at 64s, which is
 * slow enough to read a name as it passes.
 */
export const MARQUEE_SECONDS_PER_TILE = 2.9;
/** Floor, so a wall that ever falls to a handful of tiles does not whip past. */
export const MARQUEE_MIN_SECONDS = 20;

/** Whole seconds for one full loop of the marquee at this tile count. */
export function marqueeDuration(tileCount: number): number {
  return Math.max(MARQUEE_MIN_SECONDS, Math.round(tileCount * MARQUEE_SECONDS_PER_TILE));
}

/** The letter a monogram tile shows. Codepoint-aware, so an emoji name works. */
export function monogramLetter(name: string): string {
  return ([...name.trim()][0] ?? "?").toUpperCase();
}

/**
 * One tile. `clone` marks a tile in the duplicate track: it is a rendering
 * artifact of the seamless loop, so it is removed from the accessibility tree
 * (its track carries aria-hidden) and from the tab order, and it is skipped on
 * the way back in by parseWall.
 */
function renderTile(e: WallEntry, clone: boolean): string[] {
  const lines: string[] = [];
  const cloneAttrs = clone ? ' data-clone="true" tabindex="-1"' : "";
  lines.push(
    `<a class="adopter" href="${escapeHtml(e.url)}" data-repo="${escapeHtml(e.repo)}" target="_blank" rel="noopener noreferrer"${cloneAttrs}>`,
  );
  if (e.monogram) {
    // No image to load and none to probe. aria-hidden because the name sits
    // right below: the letter is decoration, and announcing "K" then "Karakeep"
    // is worse than announcing the name once.
    lines.push(
      `<span class="adopter-monogram" aria-hidden="true">${escapeHtml(monogramLetter(e.name))}</span>`,
    );
  } else {
    // alt is intentionally empty: the name sits right beside the image, so the
    // logo is decorative and repeating the name would double-announce it.
    lines.push(
      `<img class="adopter-logo${e.chip ? " adopter-logo--chip" : ""}" src="${escapeHtml(e.logo)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />`,
    );
  }
  lines.push(`<span class="adopter-name">${escapeHtml(e.name)}</span>`);
  lines.push("</a>");
  return lines;
}

/**
 * Emits the generated region body: a single horizontal marquee band. Output is
 * run through prettier afterwards, so indentation here only needs to be legible,
 * not byte-exact.
 *
 * TWO IDENTICAL TRACKS inside one flex row, and the ROW is what animates, from
 * translateX(0) to translateX(-50%) — half the row is exactly one track, so at
 * the end of the loop the second track sits precisely where the first started
 * and the restart is invisible. Animating each track by -100% of itself works
 * out to the same place; animating the row is easier to reason about.
 *
 * NO PAUSE BUTTON. Pausing is the page's job and it is done in CSS, on
 * `:hover` and `:focus-within` over `.adopter-marquee`. A button was drafted
 * here and rejected: the emitted markup is the ONLY thing this function
 * controls, so a control it emits has no styling and no handler unless
 * docs/index.html grows both to match, and an unstyled `<button>` wired to a
 * `toggleAdopterMarquee` that does not exist is a dead control on the public
 * homepage. If a real pause control is ever wanted, the CSS and the handler
 * land on the page FIRST, and only then does this function emit the button.
 *
 * The second track is a VISUAL DUPLICATE ONLY. Everything that makes it a
 * duplicate rather than a second listing lives on the markup, not the CSS, so
 * that it holds with styles off: the track is aria-hidden and every anchor in it
 * is tabindex="-1". A screen-reader or keyboard user meets each company once.
 */
export function renderWall(entries: WallEntry[]): string {
  const lines: string[] = [];
  lines.push("<!-- Generated by scripts/update-adoption-wall.ts — do not edit by hand. -->");
  lines.push(
    `<div class="adopter-marquee fade-in" style="--marquee-duration: ${marqueeDuration(entries.length)}s">`,
  );
  lines.push('<div class="adopter-marquee-viewport">');
  lines.push('<div class="adopter-marquee-row">');
  lines.push('<div class="adopter-track">');
  for (const e of entries) lines.push(...renderTile(e, false));
  lines.push("</div>");
  lines.push('<div class="adopter-track" aria-hidden="true">');
  for (const e of entries) lines.push(...renderTile(e, true));
  lines.push("</div>");
  lines.push("</div>");
  lines.push("</div>");
  lines.push("</div>");
  return lines.join("\n");
}

/** Replaces exactly the bytes between the two sentinels, and nothing else. */
export function replaceRegion(html: string, inner: string): string {
  const start = html.indexOf(START_SENTINEL);
  const end = html.indexOf(END_SENTINEL);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Adoption wall sentinels not found in ${DOCS_PATH}`);
  }
  const before = html.slice(0, start + START_SENTINEL.length);
  const after = html.slice(end);
  return `${before}\n${inner}\n${after}`;
}

export function extractRegion(html: string): string {
  const start = html.indexOf(START_SENTINEL);
  const end = html.indexOf(END_SENTINEL);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Adoption wall sentinels not found");
  }
  return html.slice(start + START_SENTINEL.length, end);
}

export interface ParsedTile {
  repo: string;
  name: string;
  url: string;
  /** Empty string for a monogram tile: there is no image, so nothing to probe. */
  logo: string;
}

/**
 * One whole `<a class="adopter">…</a>`, however prettier chose to wrap it —
 * including `</a\n>`, which is how it closes a tag whose attributes it split.
 */
const TILE_RE = /<a\b[^>]*\bclass="adopter"[\s\S]*?<\/a\s*>/g;

/**
 * Reads back what is currently on the page, one whole anchor at a time. Chunking
 * on the anchor rather than sweeping the region for each attribute separately is
 * what lets a tile be missing an `<img>` (a monogram) without silently shifting
 * every later tile's logo onto the wrong repo.
 *
 * The duplicate track is skipped. It is a rendering artifact of the seamless
 * loop, and counting it would double every tile and probe every avatar twice.
 */
export function parseWall(html: string): ParsedTile[] {
  const region = extractRegion(html);
  const tiles: ParsedTile[] = [];
  let clones = 0;
  for (const [chunk] of region.matchAll(TILE_RE)) {
    if (/\bdata-clone="true"/.test(chunk)) {
      clones++;
      continue;
    }
    const repo = /\bdata-repo="([^"]*)"/.exec(chunk)?.[1];
    const url = /\bhref="([^"]*)"/.exec(chunk)?.[1];
    if (repo === undefined || url === undefined) {
      throw new Error(`Malformed adoption wall tile (no repo or href): ${chunk.slice(0, 160)}`);
    }
    const logo = /<img\b[^>]*?\bsrc="([^"]*)"/.exec(chunk)?.[1] ?? "";
    // `[^>]*` and not `class="adopter-name">`: prettier is free to put the
    // attribute on its own line, and a regex that assumes one line yields "" —
    // a tile with no name, silently, on a public page.
    const name =
      /<span\b[^>]*\bclass="adopter-name"[^>]*>([\s\S]*?)<\/span\s*>/.exec(chunk)?.[1] ?? "";
    tiles.push({
      repo: decodeHtml(repo),
      name: decodeHtml(name).trim(),
      url: decodeHtml(url),
      logo: decodeHtml(logo),
    });
  }
  // A half-written duplicate track would make the loop visibly jump, so the two
  // tracks matching is an invariant worth failing on rather than rendering. A
  // count of zero against a non-empty wall is the MOST broken case, not the
  // exempt one: the duplicate track is missing outright. Zero against zero is an
  // empty region, which is a wall that has not been rendered yet, not a fault.
  if (clones !== tiles.length) {
    throw new Error(
      `Malformed adoption marquee: ${tiles.length} tile(s) but ${clones} duplicate(s); the two tracks must match.`,
    );
  }
  return tiles;
}

// ── Logo health ──────────────────────────────────────────────────────────────

async function probeOnce(url: string, method: "HEAD" | "GET"): Promise<CheckResult> {
  const base = { url, repo: "", ok: false, status: null as number | null };
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      headers: method === "GET" ? { Range: "bytes=0-0" } : {},
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    try {
      if (res.ok || res.status === 206) {
        // A 2xx is NOT sufficient. When the PATH IS NOT NUMERIC — `u/undefined`,
        // `u/NaN`, an interpolation that produced an empty string — the CDN 302s
        // to github.com and returns 200 text/html, which a browser renders as a
        // broken image. That template-bug class is precisely what this check
        // catches, and it is all it catches: a wrong-but-numeric id still returns
        // a perfectly valid image/* 200 and passes here. checkOwnerIdentity is
        // what covers that; do not read this check as proof the id resolves.
        const ctype = res.headers.get("content-type") ?? "";
        if (!ctype.toLowerCase().startsWith("image/")) {
          return {
            ...base,
            status: res.status,
            kind: "http",
            detail: `HTTP ${res.status} but content-type was "${ctype || "(none)"}", not an image`,
          };
        }
        return { ...base, ok: true, status: res.status, kind: "ok", detail: `HTTP ${res.status}` };
      }
      // Not evidence the image is dead: a rate-limit, a server-side wobble, or a
      // 403. 403 is what a CDN answers when it is shedding load or refusing the
      // method, NOT what it answers for an avatar that does not exist — that
      // answer is the 200 text/html above. Calling a 403 dead put "Logo for X
      // returned HTTP 403" into Slack, which is the one line a human reads,
      // naming a live logo as dead; it also broke out of the retry loop below
      // without ever spending the backoff the 403 is asking for.
      const kind =
        res.status === 403 || res.status === 429 || res.status >= 500 ? "inconclusive" : "http";
      return { ...base, status: res.status, kind, detail: `HTTP ${res.status}` };
    } finally {
      // The ranged GET's body is never read. Under undici an unread body holds
      // its socket checked out of the pool until GC, so a run where many avatars
      // refuse HEAD sits on CHECK_CONCURRENCY sockets against one CDN for the
      // rest of the process. Cancelling releases it now.
      await res.body?.cancel().catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, kind: "inconclusive", detail: `request failed: ${msg}` };
  }
}

/**
 * The host `avatarUrl` hot-links from. Owner-identity verification is scoped to
 * it because `api.github.com/user/<id>` is only meaningful for an id minted by
 * GitHub; a URL on any other host is not a GitHub avatar. A test pins
 * `avatarUrl` to this constant so the scoping can never silently disable the
 * check by the host drifting.
 */
export const AVATAR_HOST = "avatars.githubusercontent.com";

/** The numeric owner id in an `avatars.githubusercontent.com/u/<id>` URL, or null. */
export function ownerIdFromAvatarUrl(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== AVATAR_HOST) return null;
  const m = /^\/u\/(\d+)$/.exec(parsed.pathname);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Resolves the rendered owner id back to a GitHub login and requires it to be
 * the repo's owner.
 *
 * WHY THIS EXISTS AND WHY THE CONTENT-TYPE CHECK CANNOT REPLACE IT: every
 * numeric id returns a valid `image/*` 200 from the CDN. A one-digit typo does
 * not 404 — it resolves to somebody else's real account (`128464814` is
 * `govnojuy`, `68255` is `jco`), and the probe would happily publish a stranger's
 * avatar on the homepage under an adopter's name. The id is the ONLY thing in a
 * tile that is not human-readable, so it is the one field a reviewer cannot
 * eyeball; it therefore has to be machine-checked.
 *
 * Case-insensitively, because GitHub logins are case-PRESERVING but
 * case-INSENSITIVE: the API may answer `ComposioHQ` where the repo string says
 * `composiohq`, and treating that as a mismatch would wedge the run.
 *
 * CLASSIFICATION IS THE POINT. A 404 (unassigned id) or a login mismatch is a
 * DEFINITE failure. A rate-limit or a 5xx means we could not ask, and "could not
 * ask" must never read as "verified" — it is inconclusive, which resolves to
 * NEEDS-REVIEW. Getting that backwards would turn a transient API blip into an
 * unreviewed push to a public page.
 *
 * Reuses HEADERS — the same token, User-Agent and rate-limit budget as every
 * other GitHub call in this script — rather than opening a second HTTP path.
 */
export async function checkOwnerIdentity(url: string, repo: string): Promise<CheckResult | null> {
  const id = ownerIdFromAvatarUrl(url);
  if (id === null) return null;
  const expected = orgOf(repo);
  const base = { url, repo, ok: false, status: null as number | null };
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/user/${id}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      kind: "inconclusive",
      detail: `owner id ${id} could not be resolved: ${msg}`,
    };
  }
  if (res.status === 404) {
    return {
      ...base,
      status: 404,
      kind: "identity",
      detail: `owner id ${id} is not a GitHub account (api.github.com/user/${id} -> 404), so the avatar is a generated placeholder, not ${expected}`,
    };
  }
  if (!res.ok) {
    // 403/429 (rate-limited) and 5xx are the documented inconclusive shapes;
    // anything else non-2xx is equally a "could not ask", so it lands here too.
    return {
      ...base,
      status: res.status,
      kind: "inconclusive",
      detail: `owner id ${id} could not be resolved: api.github.com/user/${id} returned HTTP ${res.status}`,
    };
  }
  let login: unknown;
  try {
    login = ((await res.json()) as { login?: unknown }).login;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: res.status,
      kind: "inconclusive",
      detail: `owner id ${id} could not be resolved: unreadable API response (${msg})`,
    };
  }
  if (typeof login !== "string" || login === "") {
    return {
      ...base,
      status: res.status,
      kind: "inconclusive",
      detail: `owner id ${id} could not be resolved: the API returned no login`,
    };
  }
  if (login.toLowerCase() !== expected.toLowerCase()) {
    return {
      ...base,
      status: res.status,
      kind: "identity",
      detail: `owner id ${id} belongs to \`${login}\`, not \`${expected}\` — the wrong account's avatar would be published for ${repo}`,
    };
  }
  return null;
}

/**
 * HEAD first; some CDNs refuse HEAD, so a 403/405 is re-tried as a one-byte
 * ranged GET before being believed. Retries CHECK_RETRIES times on anything
 * transient, backing off exponentially between attempts — see retryDelayMs.
 * `wait` is injectable so a test can observe the backoff without spending it.
 * Only a verdict — 2xx-with-an-image, or a definite non-image answer — stops the
 * loop early; an inconclusive result spends every attempt it is given.
 */
export async function checkLogo(
  url: string,
  repo: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<CheckResult> {
  let last: CheckResult | null = null;
  for (let attempt = 0; attempt <= CHECK_RETRIES; attempt++) {
    if (attempt > 0) await wait(retryDelayMs(attempt - 1));
    let res = await probeOnce(url, "HEAD");
    if (!res.ok && (res.status === 403 || res.status === 405)) {
      res = await probeOnce(url, "GET");
    }
    // A live image is a necessary condition, not a sufficient one. Only once the
    // CDN says the logo renders is it worth asking WHOSE logo it is.
    if (res.ok) res = (await checkOwnerIdentity(url, repo)) ?? res;
    last = res;
    // "identity" is as definite as "http": re-asking gets the same wrong login.
    if (res.ok || res.kind === "http" || res.kind === "identity") break;
  }
  return { ...(last as CheckResult), repo };
}

/** Bounded-concurrency map so a 16-tile wall does not burst the CDN. */
export async function checkLogos(
  targets: { url: string; repo: string }[],
): Promise<Map<string, CheckResult>> {
  const out = new Map<string, CheckResult>();
  const queue = [...targets];
  // Claimed SYNCHRONOUSLY, before the await. Testing `out` — which is only
  // written once the probe resolves — leaves every worker seeing an empty map,
  // so a URL shared by two tiles is probed twice and whichever probe finishes
  // last decides which repo a dead logo is attributed to.
  const claimed = new Set<string>();
  const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      if (claimed.has(next.url)) continue;
      claimed.add(next.url);
      out.set(next.url, await checkLogo(next.url, next.repo));
    }
  });
  await Promise.all(workers);
  // Rebuilt in the order the targets arrived. `out` is written as each probe
  // RESOLVES, so under bounded concurrency its order is whichever CDN answered
  // first: two byte-identical runs against the same wall emitted the `  ! `
  // lines, the ADOPTION_WALL_REASON lines and the summary's "Why this needs
  // review" list in different orders, and the workflow puts the FIRST one in
  // Slack. rankCandidates, forkDisagreements, missingFromState and floorDrops
  // all sort deliberately; this is the one place that did not.
  const ordered = new Map<string, CheckResult>();
  for (const t of targets) {
    const res = out.get(t.url);
    if (res && !ordered.has(t.url)) ordered.set(t.url, res);
  }
  return ordered;
}

// ── Classification ───────────────────────────────────────────────────────────

export interface ClassifyInput {
  current: ParsedTile[];
  next: WallEntry[] | null;
  changed: boolean;
  checks: CheckResult[];
  /**
   * Highest-starred candidate before the exclusion rules ran, if known. When
   * supplied, it must survive to the wall or the run is NEEDS-REVIEW.
   */
  topCandidate?: { repo: string; stars: number } | null;
  /** Floor on the rendered wall size. Below it, NEEDS-REVIEW regardless. */
  minWallSize?: number;
  /**
   * Repo metadata, used to tell a deliberate removal (star floor / exclude list)
   * from an adopter genuinely disappearing. Omit and every drop is alarming.
   */
  meta?: Map<string, RepoMeta>;
  /**
   * Reasons raised before classification got here — today, adopter state that
   * was present but did not parse. A MISSING state file is not one of these: an
   * absent branch is the expected pre-first-run condition, not an incident.
   */
  extraReasons?: string[];
}

/**
 * A dead or unverifiable logo outranks everything else: it forces NEEDS-REVIEW
 * even when the adopter list is byte-identical, because that is precisely the
 * case nobody would otherwise notice.
 *
 * Two floors sit alongside it and are deliberately independent of each other and
 * of the per-repo departure reasons, because the failure they guard is not "the
 * wall changed" —
 * it is "the wall was quietly gutted by data we had no reason to trust". A wall
 * that loses its biggest name, or that falls under MIN_WALL_SIZE, is never SAFE,
 * even if the numbers technically went up and every logo resolves.
 */
export function classify(input: ClassifyInput): {
  status: WallStatus;
  reasons: string[];
  notes: DropNote[];
} {
  const reasons: string[] = [...(input.extraReasons ?? [])];
  // Things a human should be able to read afterwards but that must NOT gate the
  // run: deliberate removals are decisions taking effect, not incidents.
  const notes: DropNote[] = [];

  for (const c of input.checks) {
    if (c.ok) continue;
    const who = c.repo ? `${orgOf(c.repo)} (${c.repo})` : c.url;
    reasons.push(
      c.kind === "http"
        ? `Logo for ${who} returned ${c.detail} — ${c.url}`
        : c.kind === "identity"
          ? `Logo for ${who} resolves to the WRONG GitHub account: ${c.detail} — ${c.url}`
          : `Logo for ${who} could not be verified (${c.detail}) — ${c.url}`,
    );
  }

  if (input.next) {
    const nextRepos = new Set(input.next.map((e) => repoKey(e.repo)));

    // An UNMAPPED tile renders a raw GitHub org login and a repo URL on the
    // homepage in place of a company name and homepage. The summary has always
    // listed these as a maintenance queue, but a queue nobody is forced to read
    // is not a gate: the weekly routine auto-pushes a SAFE wall straight to the
    // default branch, so a newly-discovered adopter shipped its org login to a
    // public page unattended and left `main` red on the round-trip test that
    // asserts the shipped wall is fully curated. NEEDS-REVIEW routes exactly
    // this case to a review PR instead, which is where a human adds the pair.
    for (const e of input.next.filter((x) => !x.mapped)) {
      reasons.push(
        `${e.repo} has no ADOPTER_DISPLAY entry and would render as the raw org login "${e.name}".`,
      );
    }

    const floor = input.minWallSize ?? MIN_WALL_SIZE;
    if (input.next.length < floor) {
      reasons.push(
        `Wall would render only ${input.next.length} adopter(s), below the minimum of ${floor}.`,
      );
    }

    const top = input.topCandidate;
    if (top && !nextRepos.has(repoKey(top.repo))) {
      reasons.push(
        `Highest-starred candidate ${top.repo} (${top.stars} stars) was excluded from the wall.`,
      );
    }

    const { explained, unexplained } = input.meta
      ? partitionDrops(input.current, input.next, input.meta)
      : {
          explained: [],
          unexplained: input.current
            .filter((t) => !nextRepos.has(repoKey(t.repo)))
            .map((t) => t.repo),
        };

    for (const why of explained) notes.push(why);

    // THERE IS NO SEPARATE SHRINK REASON, and removing one is not a gap. It read
    // `next.length < current.length - explained.length`; substituting
    // `current.length = kept + explained.length + unexplained.length` and
    // `next.length = kept + additions` reduces it to `additions <
    // unexplained.length`, which cannot hold unless `unexplained` is non-empty —
    // and every entry of `unexplained` already pushes its own reason naming the
    // repo. So the aggregate line never changed a verdict; it only added a
    // second, vaguer sentence AHEAD of the specific ones. That is not free: the
    // workflow scrapes the first three `!` lines into Slack, so on a run with
    // three unaccounted departures the count displaced the third repo's name
    // from the only message a human reads. It also counted an org handover — a
    // slot changing hands, not a removal — among the "deliberate removal(s)" it
    // reported. MIN_WALL_SIZE above remains the wall's real size floor.
    for (const repo of unexplained) {
      reasons.push(`${repo} is on the wall today but absent from the new list.`);
    }
  }

  if (reasons.length > 0) return { status: "NEEDS-REVIEW", reasons, notes };
  return { status: input.changed ? "SAFE" : "CLEAN", reasons, notes };
}

/**
 * `dryRun` is not cosmetic: EXIT_CHANGED_SAFE means "the wall changed on disk
 * and it is safe to push", and the workflow branches on it. A dry run writes
 * nothing, so there is nothing to push and reporting 10 would have the workflow
 * commit a file it never wrote. NEEDS-REVIEW still travels — a dry run that
 * found a dead logo found a dead logo.
 */
export function exitCodeFor(status: WallStatus, opts: { dryRun?: boolean } = {}): number {
  if (status === "NEEDS-REVIEW") return EXIT_NEEDS_REVIEW;
  if (status === "SAFE" && !opts.dryRun) return EXIT_CHANGED_SAFE;
  return EXIT_CLEAN;
}

// ── Summary ──────────────────────────────────────────────────────────────────

export function buildSummary(opts: {
  status: WallStatus;
  reasons: string[];
  current: ParsedTile[];
  next: WallEntry[] | null;
  checks: CheckResult[];
  verifyOnly: boolean;
  disagreements?: ForkDisagreement[];
  missingFromState?: string[];
  notes?: DropNote[];
  /** Adopters the one-tile-per-org rule removed, and who took the slot. */
  orgRunnersUp?: OrgRunnerUp[];
  /** Repos the exclude list actually suppressed this run, with their reasons. */
  suppressed?: { repo: string; stars: number; reason: string }[];
  /** Exclude-list entries the incoming scan no longer mentions at all. */
  staleExclusions?: string[];
  /** State entries that are not `owner/name`, so nothing could be asked about them. */
  malformedRepos?: string[];
  /** Why no adopter data was read this run, when that is the case. */
  stateNote?: string | null;
  /**
   * What this run did to the state file on the orphan branch, and why. Rendered
   * because a reviewer reading a NEEDS-REVIEW PR needs to know whether the run
   * also refreshed `lastScan` — a run that did NOT is on a clock, and that fact
   * is invisible anywhere else in this document.
   */
  stateWriteNote?: string | null;
}): string {
  const lines: string[] = [];
  lines.push("## Adoption wall");
  lines.push("");
  lines.push(`**Status:** ${opts.status}`);
  lines.push("");

  if (opts.stateNote) {
    lines.push(opts.stateNote);
    lines.push("");
  }

  if (opts.reasons.length > 0) {
    lines.push("### Why this needs review");
    lines.push("");
    for (const r of opts.reasons) lines.push(`- ${r}`);
    lines.push("");
  }

  const failed = opts.checks.filter((c) => !c.ok);
  lines.push(
    `Logo health: ${opts.checks.length - failed.length}/${opts.checks.length} avatar URLs resolved.`,
  );
  lines.push("");

  if (opts.stateWriteNote) {
    lines.push(opts.stateWriteNote);
    lines.push("");
  }

  const notes = opts.notes ?? [];
  if (notes.length > 0) {
    // Sorted by stars, because the line below says "highest": slicing in page
    // order shows whichever ten happened to come first, under a label claiming
    // they are the biggest, which is the sort of quiet lie this file is about.
    const floorDrops = notes
      .filter((n) => n.kind === "star-floor")
      .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.repo.localeCompare(b.repo));
    const listDrops = notes.filter((n) => n.kind === "exclude-list");
    const handovers = notes.filter((n) => n.kind === "org-handover");
    lines.push(`### Deliberate removals — ${notes.length} tile(s), not alarms`);
    lines.push("");
    lines.push(
      "These tiles left the wall because the star floor or the exclude list removed them, or " +
        "because another repo from the same org took the org's single slot. That is a decision " +
        "taking effect, so it does not gate the run:",
    );
    lines.push("");
    if (floorDrops.length > 0) {
      // Collapsed: a transition week drops well over a hundred of these and a
      // flat list would bury the handful of entries a human should actually read.
      const shown = floorDrops.slice(0, 10);
      lines.push(
        `- **${floorDrops.length}** fell below the ${STAR_FLOOR}-star floor` +
          (floorDrops.length > shown.length ? ` (highest ${shown.length} shown)` : "") +
          ": " +
          shown.map((n) => `\`${n.repo}\` (${n.stars})`).join(", ") +
          (floorDrops.length > shown.length
            ? `, and ${floorDrops.length - shown.length} more`
            : ""),
      );
    }
    for (const n of listDrops) {
      lines.push(`- **exclude list** removed \`${n.repo}\` — ${n.detail}`);
    }
    for (const n of handovers) {
      lines.push(`- **same org** — \`${n.repo}\` left the wall because ${n.detail}`);
    }
    lines.push("");
  }

  // One tile per org means a second adopting repo from an org already on the
  // wall cannot render. Two of these are hand-curated adopters, so the rule
  // saying nothing would drop a name somebody chose, invisibly.
  const runnersUp = opts.orgRunnersUp ?? [];
  if (runnersUp.length > 0) {
    lines.push(`### ${runnersUp.length} adopter(s) held back by one-tile-per-org`);
    lines.push("");
    lines.push(
      "These repos qualified on every other count. The wall renders one tile per ORG — it is a " +
        "wall of teams — so the org's highest-ranked repo took the slot:",
    );
    lines.push("");
    lines.push("| Repo | Stars | Slot held by |");
    lines.push("| --- | --- | --- |");
    for (const r of runnersUp) {
      lines.push(`| \`${escapeCell(r.repo)}\` | ${r.stars} | \`${escapeCell(r.winner)}\` |`);
    }
    lines.push("");
  }

  // Always rendered, even at zero, so the exclude list can never become an
  // invisible filter nobody remembers is there.
  const suppressed = opts.suppressed ?? [];
  lines.push(
    `Exclude list: ${Object.keys(EXCLUDED_ADOPTERS).length} entr(y/ies), suppressed ` +
      `**${suppressed.length}** repo(s) that had cleared the ${STAR_FLOOR}-star floor this run.`,
  );
  lines.push("");
  if (suppressed.length > 0) {
    lines.push("| Repo | Stars | Why it is excluded |");
    lines.push("| --- | --- | --- |");
    for (const e of suppressed) {
      lines.push(`| \`${escapeCell(e.repo)}\` | ${e.stars} | ${escapeCell(e.reason)} |`);
    }
    lines.push("");
  }
  const stale = opts.staleExclusions ?? [];
  if (stale.length > 0) {
    lines.push(
      `${stale.length} exclude-list entr(y/ies) no longer appear in the scan at all and could be retired: ` +
        stale.map((r) => `\`${r}\``).join(", "),
    );
    lines.push("");
  }

  // Rendered as its own section rather than folded into the drop notes: this is
  // not the wall's decision taking effect, it is the producer writing something
  // this script cannot use, and the fix is upstream.
  const malformed = opts.malformedRepos ?? [];
  if (malformed.length > 0) {
    lines.push(`### ${malformed.length} state entr(y/ies) are not \`owner/name\``);
    lines.push("");
    lines.push(
      "The GitHub API is asked about repos by owner and name, so these entries could not be " +
        "resolved and were not ranked or rendered. They are a bug in the routine that writes " +
        `\`${STATE_FILE}\`, not in this script:`,
    );
    lines.push("");
    for (const repo of malformed) lines.push(`- \`${escapeCell(repo)}\``);
    lines.push("");
  }

  const disagreements = opts.disagreements ?? [];
  if (disagreements.length > 0) {
    lines.push("### Fork classification disagrees with the GitHub API");
    lines.push("");
    lines.push(
      "The adopter scan's `isFork` does not match the API's `fork` field for these repos. " +
        "**The API's answer was used.** A non-empty table here means the routine that writes " +
        "`adopters.json` on the `adoption-data` branch is misclassifying repos and needs " +
        "fixing at the source:",
    );
    lines.push("");
    lines.push("| Repo | State file says | GitHub API says |");
    lines.push("| --- | --- | --- |");
    for (const d of disagreements) {
      lines.push(
        `| \`${escapeCell(d.repo)}\` | ${d.stateSaysFork ? "fork" : "not a fork"} | ${d.apiSaysFork ? "fork" : "**not a fork**"} |`,
      );
    }
    lines.push("");
  }

  const missing = opts.missingFromState ?? [];
  if (missing.length > 0) {
    lines.push("### Known adopters the scan did not report");
    lines.push("");
    lines.push(
      "These repos have a curated entry in `ADOPTER_DISPLAY` but do not appear in the incoming " +
        "state file at all, so they cannot be ranked or rendered. That is a gap in discovery, " +
        "not in this script — the wall stays generated and nothing is hardcoded in:",
    );
    lines.push("");
    for (const repo of missing) lines.push(`- \`${repo}\``);
    lines.push("");
  }

  // No candidate wall means nothing was rendered, so everything below (the
  // unmapped queue, the wall table) would be describing a wall that does not
  // exist. That covers --verify-only and a missing/unreadable state file alike.
  if (opts.next === null) {
    lines.push(
      opts.verifyOnly
        ? "_Verify-only run; `docs/` was not modified._"
        : "_No adopter data was read; `docs/` was not modified._",
    );
    lines.push("");
    return lines.join("\n") + "\n";
  }

  // Promoted above the wall table on purpose. With an uncapped wall this list is
  // the maintenance queue, not a footnote: every entry is a tile currently on a
  // public page showing a raw GitHub org login instead of the company's name.
  const unmapped = opts.next.filter((e) => !e.mapped);
  if (unmapped.length > 0) {
    lines.push(`### ⚠ ${unmapped.length} tile(s) need a display name and homepage`);
    lines.push("");
    lines.push(
      "These adopters have no entry in `ADOPTER_DISPLAY`, so they are rendering with their " +
        "raw GitHub org login and a repo URL instead of a company name and homepage. Add a " +
        "pair for each in `scripts/update-adoption-wall.ts`:",
    );
    lines.push("");
    lines.push("| Repo | Rendering as | Stars |");
    lines.push("| --- | --- | --- |");
    for (const e of unmapped) {
      lines.push(`| \`${escapeCell(e.repo)}\` | ${escapeCell(e.name)} | ${e.stars} |`);
    }
    lines.push("");
  }

  lines.push(`### Wall contents (${opts.next.length} tiles)`);
  lines.push("");
  lines.push("| # | Adopter | Repo | Stars | Mapped |");
  lines.push("| --- | --- | --- | --- | --- |");
  opts.next.forEach((e, i) => {
    lines.push(
      `| ${i + 1} | ${escapeCell(e.name)} | ${escapeCell(e.repo)} | ${e.stars} | ${e.mapped ? "yes" : "**no**"} |`,
    );
  });
  lines.push("");

  return lines.join("\n") + "\n";
}

// ── Data loading ─────────────────────────────────────────────────────────────

/**
 * The value of `flag`, or null when the flag was not passed AT ALL.
 *
 * "Passed with no value" is NOT null, it is a malformed command line, and it
 * throws. Taking the next token unconditionally made a typo look like a
 * successful run: `--summary --dry-run` wrote the PR summary to a file literally
 * named `--dry-run`, and `--state --verify-only` resolved a nonsense path that
 * loadAdopterState reported as `missing`, so the run exited 0 saying "no adopter
 * state yet, docs/ left alone" — a green run that checked nothing. A trailing
 * `--summary` with nothing after it silently wrote no summary at all, and the
 * workflow's `gh pr create --body-file` then failed pointing nowhere near the
 * cause. A leading `-` is the test because every value this script takes is a
 * path, and no flag of ours is a legitimate one.
 */
export function flagValue(argv: readonly string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (value === undefined) throw new Error(`${flag} needs a value; nothing followed it.`);
  if (value.startsWith("-")) {
    throw new Error(`${flag} needs a value; the next argument was the flag "${value}".`);
  }
  return value;
}

function argValue(flag: string): string | null {
  return flagValue(process.argv, flag);
}

/**
 * Three outcomes, kept apart on purpose:
 *
 *   ok      — usable state.
 *   missing — the file is not there. Before the weekly routine's first push to
 *             `adoption-data`, or on a clone where the branch was never fetched,
 *             this is simply true and it is not an incident. The caller renders
 *             nothing and leaves docs/ alone.
 *   corrupt — the file IS there and cannot be used. That is a broken producer,
 *             and it must be loud, because the alternative is a wall silently
 *             frozen at whatever it happened to say the week the writer broke.
 */
export type StateLoad =
  | { kind: "ok"; state: AdoptersState }
  | { kind: "missing"; detail: string }
  | { kind: "corrupt"; detail: string };

/** Shape-checks the JSON far enough to know an unusable file when it sees one. */
export function parseAdopterState(raw: string, source: string): StateLoad {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "corrupt", detail: `${source} is not valid JSON: ${msg}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "corrupt", detail: `${source} parsed, but is not a JSON object.` };
  }
  const adopters = (parsed as { adopters?: unknown }).adopters;
  if (adopters !== undefined && !Array.isArray(adopters)) {
    return { kind: "corrupt", detail: `${source} has an "adopters" field that is not an array.` };
  }
  // The ELEMENTS, not just the array. `{"adopters":[1]}` used to pass as ok and
  // then throw somewhere downstream, which exits 1 — a run that failed — where
  // this is exactly a broken producer and the workflow's answer to that is exit
  // 20 and a human. Every field the rest of this file reads is checked here.
  for (const [i, entry] of (adopters ?? []).entries()) {
    const where = `${source} adopters[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { kind: "corrupt", detail: `${where} is not an object.` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.repo !== "string" || e.repo === "") {
      return { kind: "corrupt", detail: `${where} has no "repo" string.` };
    }
    if (e.missedRuns !== undefined && typeof e.missedRuns !== "number") {
      return { kind: "corrupt", detail: `${where} (${e.repo}) has a non-numeric "missedRuns".` };
    }
    if (e.isFork !== undefined && typeof e.isFork !== "boolean") {
      return { kind: "corrupt", detail: `${where} (${e.repo}) has a non-boolean "isFork".` };
    }
    if (e.channels !== undefined && !Array.isArray(e.channels)) {
      return { kind: "corrupt", detail: `${where} (${e.repo}) has a non-array "channels".` };
    }
  }
  return { kind: "ok", state: parsed as AdoptersState };
}

/**
 * An unreadable-for-any-other-reason file (a permission error, a directory where
 * a file should be) is NOT swallowed as "missing": only a genuine absence is,
 * because only a genuine absence is the expected pre-first-run state.
 */
export function loadAdopterState(path: string): StateLoad {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "missing", detail: `${path} does not exist` };
    }
    throw err;
  }
  return parseAdopterState(raw, path);
}

// ── State write-back ─────────────────────────────────────────────────────────
//
// THIS SCRIPT IS THE PRODUCER OF `adopters.json`, not only its reader. It used
// to be only the reader, and there was no writer anywhere: `lastScan` was
// stamped once by hand when the orphan branch was seeded and then never moved
// again, so MAX_STATE_AGE_DAYS was a fuse rather than a guard — every run stayed
// green until the seed aged out, and every run after that reported NEEDS-REVIEW
// forever over a wall nothing had actually changed. The functions below are the
// missing producer.
//
// THE ONE PROPERTY THAT MATTERS: a fresh `lastScan` is a CLAIM that this run
// resolved the whole adopter list. If a run that could not resolve it stamps one
// anyway, the staleness guard becomes decorative — it would then be measuring
// how recently the job RAN, which it can already tell, instead of how recently
// the data was actually confirmed. So the stamp is gated on scanIsConclusive and
// on nothing else, and every "we could not tell" answer anywhere in the run
// withholds it.

/**
 * The scan's universe: everything the incoming state file lists, PLUS every
 * repo with a curated `ADOPTER_DISPLAY` entry that the file does not mention.
 *
 * The orphan branch was seeded by PARSING THE LIVE WALL, which can only ever
 * contain repos that were already rendering. `cacheplane/dawnai` is a real,
 * curated adopter sitting below the wall's cut, so the parse could not see it
 * and the seeded file did not list it — and because the file is also the
 * candidate list, a repo missing from it can never climb back onto the wall. The
 * gap was reported by missingFromState every week and nothing could close it.
 *
 * Seeding the curated names into the scan closes it: they are resolved from the
 * API like every other candidate, ranked on their real numbers, and written back
 * with whatever the scan actually found. `missedRuns: 0` here is an INPUT, not
 * an assertion — it only means "ask about this one"; buildNextState overwrites
 * it with the scan's answer before anything is persisted, and if the scan was
 * not conclusive nothing is persisted at all.
 */
export function withKnownAdopters(
  adopters: readonly AdopterState[],
  now: string,
  mapping: Record<string, AdopterDisplay> = ADOPTER_DISPLAY,
): AdopterState[] {
  const seen = new Set(adopters.map((a) => a.repo.toLowerCase()));
  const added = Object.keys(mapping)
    .filter((repo) => !seen.has(repo.toLowerCase()))
    .sort((x, y) => x.localeCompare(y))
    .map((repo) => ({ repo, channels: ["adopter-display"], missedRuns: 0, firstSeen: now }));
  return [...adopters, ...added];
}

/**
 * Whether this run is allowed to claim it scanned the adopter list.
 *
 * Two ways to fail, both meaning "no verdict was reached", never "the answer was
 * no":
 *
 *   · a repo the API was asked about came back unusable (see MetaResolution); or
 *   · a logo probe was INCONCLUSIVE — a timeout, a 429, a 5xx. That check runs
 *     against the same GitHub estate over the same network in the same seconds,
 *     so it is the run's own report that its answers this minute cannot be
 *     trusted. A dead logo (`http`) or a wrong-account logo (`identity`) is the
 *     opposite: a definite finding, and a run that established one scanned fine.
 *
 * A rate-limited or throttled METADATA pass does not reach here at all — both
 * fetch paths throw on 403/429/5xx, main() exits EXIT_ERROR, and nothing is
 * written. That is the loudest form of the same rule.
 */
export function scanIsConclusive(opts: {
  indeterminate: readonly string[];
  checks: readonly CheckResult[];
}): { ok: true } | { ok: false; detail: string } {
  if (opts.indeterminate.length > 0) {
    const shown = [...opts.indeterminate].sort((x, y) => x.localeCompare(y)).slice(0, 5);
    return {
      ok: false,
      detail:
        `${opts.indeterminate.length} repo(s) returned no usable metadata, so this run did not ` +
        `resolve the whole adopter list: ${shown.join(", ")}` +
        (opts.indeterminate.length > shown.length
          ? `, and ${opts.indeterminate.length - shown.length} more`
          : ""),
    };
  }
  const unverified = opts.checks.filter((c) => c.kind === "inconclusive");
  if (unverified.length > 0) {
    return {
      ok: false,
      detail:
        `${unverified.length} avatar probe(s) reached no verdict (timeout, 429 or 5xx), so this ` +
        `run cannot vouch for what it saw: ${unverified[0].repo || unverified[0].url}`,
    };
  }
  return { ok: true };
}

/**
 * The state file this run should leave behind, given what it resolved.
 *
 * `lastScan` is the caller's `scannedAt` — the caller only gets here after
 * scanIsConclusive said yes, so the field means what it has always claimed to
 * mean.
 *
 * `missedRuns` keeps the semantics the reader already relies on (`> 0` means the
 * latest scan did not see the repo, and the repo is not a wall candidate):
 *
 *   resolved by this scan   -> 0, unconditionally. A repo that comes back is
 *                              back; carrying an old count forward would keep it
 *                              off the wall after it returned.
 *   definitively absent     -> previous + 1. One scan's silence is not a
 *                              removal, and the counter is what makes that
 *                              distinction possible.
 *   NEITHER                 -> carried through UNCHANGED. Two populations land
 *                              here and both must be left alone: entries already
 *                              at missedRuns > 0, which are filtered out before
 *                              the API is asked and so were never looked at this
 *                              run; and entries whose `repo` is not `owner/name`
 *                              and cannot be asked about at all. Incrementing a
 *                              repo nobody looked at manufactures evidence.
 *
 * NOTHING IS EVER DELETED. An adopter that drops out of the scan keeps its row,
 * its `firstSeen` and its rising counter, so a repo that reappears is recognised
 * as the same repo rather than as a brand-new discovery — and the record that it
 * was ever an adopter survives the week it went quiet.
 *
 * `isFork`, `channels` and `firstSeen` are carried through VERBATIM. `isFork`
 * especially: the TRUST MODEL note at the top of this file says the reader uses
 * the file's fork claim for nothing and reports every disagreement with the API,
 * and overwriting the claim with the API's answer would make that report
 * self-cancelling — the producer would erase the evidence the reader exists to
 * surface.
 *
 * Entries are sorted by repo so the orphan branch's diff each week is the delta
 * and not a reshuffle.
 */
export function buildNextState(opts: {
  adopters: readonly AdopterState[];
  resolved: ReadonlySet<string>;
  absent: ReadonlySet<string>;
  scannedAt: string;
}): AdoptersState {
  const adopters = [...opts.adopters]
    .sort(
      (x, y) =>
        x.repo.toLowerCase().localeCompare(y.repo.toLowerCase()) || x.repo.localeCompare(y.repo),
    )
    .map((a) => {
      const next: AdopterState = { ...a };
      if (opts.resolved.has(a.repo)) next.missedRuns = 0;
      else if (opts.absent.has(a.repo)) next.missedRuns = (a.missedRuns ?? 0) + 1;
      return next;
    });
  return { lastScan: opts.scannedAt, adopters };
}

/** Exactly the on-disk form the seeded branch already uses: 2-space JSON, trailing newline. */
export function serializeState(state: AdoptersState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/**
 * One REST call per repo. Correct, but 182 calls for a 182-entry state file, so
 * it is the fallback rather than the default.
 */
export async function fetchRepoMetaRest(
  repos: string[],
  meta: Map<string, RepoMeta>,
  indeterminate?: Set<string>,
): Promise<void> {
  for (const repo of repos) {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: HEADERS });
    // 404 (gone or private) and 451 (taken down) are per-repo facts and yield no
    // meta, which excludes the repo downstream. ANYTHING ELSE — 403, 429, 5xx —
    // means we could not ask, and unauthenticated that is the whole list at
    // once: ~170 repos reading as a mass disappearance and gutting the wall.
    // The GraphQL path throws here for exactly this reason; so does this one.
    if (res.status === 404 || res.status === 451) {
      // A DEFINITIVE answer: the repo is gone, private or taken down. It yields
      // no meta, and it is not added to `indeterminate` — the scan learned
      // something here, and buildNextState is entitled to count it as a miss.
      console.warn(`  ⚠ Skipping ${repo}: ${res.status} ${res.statusText}`);
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `GitHub REST returned ${res.status} ${res.statusText} for ${repo}` +
          (res.status === 403 || res.status === 429
            ? " — rate-limited, most likely unauthenticated. This is not a missing repo."
            : ""),
      );
    }
    const json = (await res.json()) as {
      stargazers_count?: number;
      fork?: boolean;
      owner?: { id?: number };
    };
    if (
      typeof json.stargazers_count !== "number" ||
      typeof json.owner?.id !== "number" ||
      typeof json.fork !== "boolean"
    ) {
      // NOT a definitive answer: the API replied, but not with the three facts
      // this script needs. "We could not tell" must never be recorded as "the
      // scan did not see it" — see buildNextState and scanIsConclusive.
      console.warn(`  ⚠ Skipping ${repo}: incomplete repo metadata`);
      indeterminate?.add(repo);
      continue;
    }
    meta.set(repo, { stars: json.stargazers_count, ownerId: json.owner.id, isFork: json.fork });
  }
}

/**
 * Resolves every candidate in batches of GRAPHQL_BATCH aliased sub-queries.
 *
 * We cannot rank a shortlist before we know the stars, and we cannot prune the
 * list with the state file's `isFork` because that flag is the very thing under
 * suspicion — pruning on it is what deleted openclaw. So every candidate has to
 * be resolved, and the lever available is the cost of resolving one, not how many
 * we resolve. Aliased GraphQL turns 182 repos into 2 requests.
 *
 * A repo that has been deleted or made private comes back as a null node plus a
 * NOT_FOUND entry in `errors`; that is expected and simply yields no meta, which
 * excludes the repo downstream. A transport-level failure throws, so we never
 * mistake "could not ask" for "not an adopter".
 */
const GRAPHQL_BATCH = 100;

/**
 * `nameWithOwner` is deliberately NOT requested. It is the repo's CURRENT name,
 * which for a renamed repo is not the name we asked about, and the only thing
 * this file could do with a name it did not ask for is key on it — which is the
 * bug. Identity comes from the alias we sent.
 */
interface GraphQLRepoNode {
  isFork?: boolean;
  stargazerCount?: number;
  owner?: { databaseId?: number };
}

export function buildRepoMetaQuery(repos: string[]): string {
  const fields =
    "isFork stargazerCount owner { __typename ... on User { databaseId } ... on Organization { databaseId } }";
  const parts = repos.map((repo, i) => {
    const [owner, name] = repo.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`;
  });
  return `query {\n  ${parts.join("\n  ")}\n}`;
}

export async function fetchRepoMetaGraphQL(
  repos: string[],
  meta: Map<string, RepoMeta>,
  indeterminate?: Set<string>,
): Promise<number> {
  let requests = 0;
  for (let i = 0; i < repos.length; i += GRAPHQL_BATCH) {
    const batch = repos.slice(i, i + GRAPHQL_BATCH);
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ query: buildRepoMetaQuery(batch) }),
    });
    requests++;
    if (!res.ok) {
      throw new Error(`GitHub GraphQL returned ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      data?: Record<string, GraphQLRepoNode | null>;
      errors?: { type?: string; message?: string }[];
    };
    if (!json.data) {
      throw new Error(
        `GitHub GraphQL returned no data: ${(json.errors ?? []).map((e) => e.message).join("; ")}`,
      );
    }
    // NOT_FOUND is per-repo and benign; anything else means the query itself is
    // wrong or we are being throttled, and quietly dropping repos on that basis
    // would reintroduce exactly the silent-deletion bug this file guards against.
    const fatal = (json.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
    if (fatal.length > 0) {
      throw new Error(`GitHub GraphQL error: ${fatal.map((e) => e.message).join("; ")}`);
    }
    // Keyed by the string we ASKED about, never by the answer. `repository(owner:,
    // name:)` resolves through renames and replies with the repo's CURRENT
    // nameWithOwner, so keying on the answer means every lookup by the state
    // file's spelling misses: the adopter is dropped by rankSelectable, is
    // invisible to topCandidate and explainDrop, and wedges the run at
    // NEEDS-REVIEW with "absent from the new list" every week until a human
    // renames it by hand — and an EXCLUDED_ADOPTERS entry, which is written
    // against a name, stops applying. fetchRepoMetaRest already keys this way;
    // the two paths must not disagree about what a repo is called.
    for (const [alias, node] of Object.entries(json.data)) {
      if (!node) continue;
      const requested = batch[Number(alias.slice(1))];
      if (
        requested === undefined ||
        typeof node.stargazerCount !== "number" ||
        typeof node.isFork !== "boolean" ||
        typeof node.owner?.databaseId !== "number"
      ) {
        // The node came back but is missing a field this script needs. That is
        // "we could not tell", NOT "the repo is gone" — a null node (NOT_FOUND)
        // is the definitive case and is skipped above without landing here.
        console.warn(`  ⚠ Skipping ${requested ?? alias}: incomplete repo metadata`);
        if (requested !== undefined) indeterminate?.add(requested);
        continue;
      }
      meta.set(requested, {
        stars: node.stargazerCount,
        ownerId: node.owner.databaseId,
        isFork: node.isFork,
      });
    }
  }
  return requests;
}

/**
 * What one resolution pass learned, split into the two answers that are NOT
 * interchangeable.
 *
 * `meta` is what resolved. `indeterminate` is every repo the API was asked
 * about and gave no usable answer for — the reply arrived but was missing a
 * field. It is deliberately NOT the same set as "asked about and not in
 * `meta`": a GraphQL NOT_FOUND, a REST 404 and a REST 451 are DEFINITIVE
 * answers ("this repo is gone or private") and belong to neither set, because
 * the scan genuinely learned something about those repos.
 *
 * The distinction exists for exactly one consumer: the state write-back. A repo
 * we could not resolve must never be recorded as a repo the scan did not see —
 * that is how a flaky API turns into a fabricated `missedRuns` and, one run
 * later, into an adopter silently dropped off a public page.
 */
interface MetaResolution {
  meta: Map<string, RepoMeta>;
  indeterminate: Set<string>;
}

async function fetchRepoMeta(repos: string[]): Promise<MetaResolution> {
  const meta = new Map<string, RepoMeta>();
  const indeterminate = new Set<string>();

  const local = argValue("--meta-file");
  if (local) {
    const path = resolve(local);
    for (const [repo, m] of parseMetaFile(readFileSync(path, "utf-8"), path)) meta.set(repo, m);
    console.log(`  Loaded ${meta.size} repo meta record(s) from ${local}`);
  }

  const missing = repos.filter((r) => !meta.has(r) && r.split("/").length === 2);
  if (missing.length === 0) return { meta, indeterminate };

  if (GITHUB_TOKEN) {
    const requests = await fetchRepoMetaGraphQL(missing, meta, indeterminate);
    console.log(resolutionLine(missing, meta, requests));
  } else {
    console.log(`  No GITHUB_TOKEN; falling back to ${missing.length} REST request(s).`);
    await fetchRepoMetaRest(missing, meta, indeterminate);
    console.log(resolutionLine(missing, meta, missing.length));
  }
  return { meta, indeterminate };
}

/** Formats through the repo's own prettier config so `format:check` stays green. */
async function formatHtml(source: string, filepath: string): Promise<string> {
  const prettier = await import("prettier");
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...config, filepath });
}

/**
 * `--meta-file` is a TESTING injection point that feeds the same record the API
 * path produces, so it gets the same scrutiny: an unchecked cast lets a file
 * with no `isFork` read as "not a fork" for every repo in it, which is the
 * silent-deletion bug this file exists to prevent, arriving through the door
 * marked "for testing".
 */
export function parseMetaFile(raw: string, source: string): Map<string, RepoMeta> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${source} is not valid JSON: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} parsed, but is not a JSON object of repo -> meta.`);
  }
  const out = new Map<string, RepoMeta>();
  for (const [repo, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${source}: ${repo} is not an object.`);
    }
    const m = value as Record<string, unknown>;
    if (typeof m.stars !== "number") throw new Error(`${source}: ${repo} has no numeric "stars".`);
    if (typeof m.ownerId !== "number") {
      throw new Error(`${source}: ${repo} has no numeric "ownerId".`);
    }
    if (typeof m.isFork !== "boolean") {
      throw new Error(
        `${source}: ${repo} has no boolean "isFork". A missing fork answer must never ` +
          "default to false — see the TRUST MODEL note at the top of this file.",
      );
    }
    out.set(repo, { stars: m.stars, ownerId: m.ownerId, isFork: m.isFork });
  }
  return out;
}

/**
 * What the API run actually RESOLVED, against what it was asked for. Reporting
 * the count asked for reads as success on a run where half the repos came back
 * empty, and contradicts the same run's disappearance report a few lines later.
 */
export function resolutionLine(
  requested: string[],
  meta: Map<string, RepoMeta>,
  requests: number,
): string {
  const resolved = requested.filter((r) => meta.has(r)).length;
  const line = `  Resolved ${resolved} of ${requested.length} repo(s) from the GitHub API in ${requests} request(s).`;
  if (resolved === requested.length) return line;
  return `${line}\n  ${requested.length - resolved} repo(s) returned nothing and will not be ranked.`;
}

/**
 * Which avatars this run should probe: the live wall, MINUS the tiles this run
 * is deliberately dropping, PLUS the tiles it is about to render.
 *
 * A departing tile's logo cannot be a reason to hold the change back — that is
 * a dead avatar on a repo that will not be on the page once the change lands,
 * blocking the very change that removes it. With no candidate list (verify-only,
 * or no state file) nothing is departing, so the whole live wall is probed.
 *
 * What departs is a URL, not a repo, so that is what is compared. A repo can
 * survive to the new wall carrying a DIFFERENT avatar URL — its owner's
 * `databaseId` changes when an org is deleted and recreated or a user account is
 * converted to an org, and `avatarUrl`'s query string is ours to edit — and the
 * URL the page currently holds is then exactly as dead as a departing tile's,
 * while this run is already replacing it. Matching on repo left that stale URL in
 * the queue and let it force NEEDS-REVIEW on the run that fixes it.
 */
export function probeTargets(
  current: ParsedTile[],
  next: WallEntry[] | null,
): { url: string; repo: string }[] {
  const survivingLogos =
    next === null ? null : new Set(next.filter((e) => !e.monogram).map((e) => e.logo));
  const targets = current
    .filter((t) => t.logo !== "")
    .filter((t) => survivingLogos === null || survivingLogos.has(t.logo))
    .map((t) => ({ url: t.logo, repo: t.repo }));
  for (const e of next ?? []) {
    if (e.monogram) continue;
    // Same filter the `current` side applies above. A non-monogram entry with
    // an empty logo is a data defect, not a tile to probe: enqueuing "" makes
    // the probe fetch a relative URL and report the run NEEDS-REVIEW over a
    // request that was never about an avatar.
    if (e.logo === "") continue;
    targets.push({ url: e.logo, repo: e.repo });
  }
  return targets;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const verifyOnly = process.argv.includes("--verify-only");
  const summaryPath = argValue("--summary");
  const statePath = resolve(argValue("--state") ?? DEFAULT_STATE_PATH);
  // Taken ONCE, at the top, and used for both `lastScan` and any `firstSeen`
  // this run mints, so every timestamp the run writes names the same run.
  const scannedAt = new Date().toISOString();

  console.log("=== Adoption Wall Updater ===\n");
  if (dryRun) console.log("  [DRY RUN] No files will be modified.\n");
  if (verifyOnly) console.log("  [VERIFY ONLY] Logo health check; docs/ untouched.\n");

  const html = readFileSync(DOCS_PATH, "utf-8");
  const current = parseWall(html);
  console.log(`Currently rendered: ${current.length} adopter(s).`);

  let next: WallEntry[] | null = null;
  let changed = false;
  let updatedHtml = html;
  let disagreements: ForkDisagreement[] = [];
  let missing: string[] = [];
  let top: { repo: string; stars: number; forksOutranking: string[] } | null = null;
  let repoMeta: Map<string, RepoMeta> | undefined;
  let suppressed: { repo: string; stars: number; reason: string }[] = [];
  let runnersUp: OrgRunnerUp[] = [];
  let staleExclusions: string[] = [];
  let malformed: string[] = [];
  let stateNote: string | null = null;
  const extraReasons: string[] = [];
  /**
   * What the scan resolved, kept for the write-back below. Null until a state
   * file has actually been read and scanned, which is what makes "there is
   * nothing honest to write" and "the scan said nothing changed" different
   * things rather than the same silence.
   */
  let scan: {
    list: AdopterState[];
    resolved: Set<string>;
    absent: Set<string>;
    indeterminate: Set<string>;
  } | null = null;

  // Job 2: refresh the list, if there is anything to refresh it from.
  const load = verifyOnly ? null : loadAdopterState(statePath);
  if (load?.kind === "missing") {
    // Expected before the weekly routine's first push. Say why, change nothing,
    // and let the logo probe below still have its say.
    stateNote =
      `No adopter state was read: \`${statePath}\` does not exist. The orphan ` +
      `\`${STATE_BRANCH}\` branch, or its \`${STATE_FILE}\`, is not there yet. That is the ` +
      "expected state before the weekly routine's first push, so it is not a failure: " +
      "`docs/` is left exactly as it was and no wall is rendered. Logo health still ran.";
    console.log(`\nNo adopter state at ${statePath}.`);
    console.log(
      `  The orphan '${STATE_BRANCH}' branch (or its ${STATE_FILE}) is not there yet. That is`,
    );
    console.log("  expected before the weekly routine's first push, so nothing is written:");
    console.log("  docs/ is left exactly as it was. Logo health still runs below.");
  } else if (load?.kind === "corrupt") {
    // The opposite case: the file IS there and cannot be used. A broken producer
    // must not leave the wall quietly frozen on last week's answer.
    stateNote = "Adopter state was present but unusable, so `docs/` was left unchanged.";
    extraReasons.push(
      `Adopter state on the orphan \`${STATE_BRANCH}\` branch could not be read: ${load.detail}. ` +
        "`docs/` was left unchanged.",
    );
    console.error(`\n! ${load.detail}`);
    console.error("  docs/ left unchanged; this is a broken producer, not a first run.");
  }

  if (load?.kind === "ok") {
    const state = load.state;
    const incoming = state.adopters ?? [];
    // The curated names the incoming file does not mention are scanned too, so a
    // real adopter that never made it into the file can climb onto the wall
    // instead of being reported as missing forever. See withKnownAdopters.
    const adopters = withKnownAdopters(incoming, scannedAt);
    if (adopters.length > incoming.length) {
      console.log(
        `\n  ${adopters.length - incoming.length} curated adopter(s) absent from the state file ` +
          "were added to this scan; they are resolved and ranked like any other candidate.",
      );
    }

    // Before anything is ranked: is this file still being written? A frozen
    // producer looks exactly like a quiet week from every other angle.
    const freshness = stateFreshness(state.lastScan);
    if (freshness.kind === "stale" || freshness.kind === "unusable") {
      extraReasons.push(freshness.detail);
      console.error(`\n! ${freshness.detail}`);
    } else if (freshness.kind === "absent") {
      console.warn(`\n⚠ ${freshness.detail}`);
    } else {
      console.log(`  ${freshness.detail}`);
    }

    // Note what is NOT filtered here: the state file's `isFork`. Fork status is
    // resolved from the API below and the file's claim is never consulted.
    const candidates = adopters.filter(
      (a) => !(typeof a.missedRuns === "number" && a.missedRuns > 0),
    );
    console.log(
      `Adopter state: ${adopters.length} entries, ${candidates.length} still seen by the latest scan.`,
    );

    // fetchRepoMeta cannot ask the API about a repo that is not `owner/name`, so
    // it drops these — and it used to drop them in silence, which is the worst of
    // the three options. The entry passes parseAdopterState (any non-empty string
    // is a valid `repo`), is never resolved, is filtered out before `requested`
    // is formed, and so gets no ⚠, no summary row, and no explainDrop note: a
    // producer that starts writing repo URLs degrades the wall while a tile that
    // WAS on the page resurfaces as a bare "absent from the new list" alarm whose
    // stated cause is false. It is named here instead.
    malformed = candidates.map((a) => a.repo).filter((r) => r.split("/").length !== 2);
    if (malformed.length > 0) {
      console.warn(
        `\n⚠ ${malformed.length} state entr(y/ies) are not "owner/name" and cannot be resolved or ranked:`,
      );
      for (const repo of malformed) console.warn(`    ${repo}`);
    }

    const asked = candidates.map((a) => a.repo).filter((r) => r.split("/").length === 2);
    const { meta, indeterminate } = await fetchRepoMeta(candidates.map((a) => a.repo));
    // Three populations, and the middle one is the whole point: resolved,
    // DEFINITIVELY absent (404 / 451 / NOT_FOUND), and "we could not tell".
    // Only the first two are facts the write-back may act on.
    scan = {
      list: adopters,
      resolved: new Set(asked.filter((r) => meta.has(r))),
      absent: new Set(asked.filter((r) => !meta.has(r) && !indeterminate.has(r))),
      indeterminate,
    };

    disagreements = forkDisagreements(adopters, meta);
    if (disagreements.length > 0) {
      console.warn(
        `\n⚠ ${disagreements.length} repo(s) where the state file's isFork disagrees with the GitHub API (API wins):`,
      );
      for (const d of disagreements) {
        console.warn(
          `    ${d.repo}: state says ${d.stateSaysFork ? "fork" : "not a fork"}, API says ${d.apiSaysFork ? "fork" : "not a fork"}`,
        );
      }
    }

    // The INCOMING file, deliberately: this line reports what the producer that
    // wrote the file failed to discover. Running it over the seeded list would
    // answer "none" every time and report the gap out of existence.
    missing = missingFromState(incoming);
    if (missing.length > 0) {
      console.warn(`\n⚠ ${missing.length} known adopter(s) absent from the incoming state file:`);
      for (const repo of missing) console.warn(`    ${repo}`);
    }

    // What the exclude list actually did this run: only entries that removed a
    // repo which had already cleared the star floor changed the wall. The
    // eligibility test is `clearsWallFilters` — the SAME predicate rankSelectable
    // uses — because this report claims to name repos the wall would otherwise
    // have rendered, and a hand-copied second copy of the filter chain can drift
    // out of agreement with the wall it is describing.
    //
    // Deduplicated by repo: parseAdopterState accepts a state file that lists the
    // same repo twice, and counting one suppression as two overstates what the
    // exclude list did in the one line that reports it.
    const suppressedByRepo = new Map<string, { repo: string; stars: number; reason: string }>();
    for (const a of adopters) {
      if (!clearsWallFilters(a, meta)) continue;
      const reason = excludeReason(a.repo);
      if (reason === null) continue;
      const key = repoKey(a.repo);
      if (suppressedByRepo.has(key)) continue;
      suppressedByRepo.set(key, { repo: a.repo, stars: meta.get(a.repo)!.stars, reason });
    }
    suppressed = [...suppressedByRepo.values()].sort(
      (x, y) => y.stars - x.stars || x.repo.localeCompare(y.repo),
    );

    const seenRepos = new Set(adopters.map((a) => a.repo.toLowerCase()));
    staleExclusions = Object.keys(EXCLUDED_ADOPTERS).filter((r) => !seenRepos.has(r.toLowerCase()));

    console.log(
      `\nExclude list: ${Object.keys(EXCLUDED_ADOPTERS).length} entries, suppressed ${suppressed.length} repo(s) above the ${STAR_FLOOR}-star floor.`,
    );
    for (const e of suppressed) console.log(`    ${e.repo} (${e.stars} stars): ${e.reason}`);

    repoMeta = meta;
    runnersUp = orgRunnersUp(adopters, meta);
    for (const r of runnersUp) {
      console.warn(
        `\n⚠ ${r.repo} (${r.stars} stars) is held back by one-tile-per-org: the ${r.org} slot is held by ${r.winner}.`,
      );
    }
    top = topCandidate(adopters, meta);
    for (const repo of top?.forksOutranking ?? []) {
      console.log(
        `  (${repo} outranks every candidate but the GitHub API calls it a fork, so it is passed over.)`,
      );
    }
    next = selectAdopters(adopters, meta);
    console.log(`\nSelected ${next.length} adopter(s):`);
    for (const e of next) {
      console.log(
        `  ${String(e.stars).padStart(7)}  ${e.repo}  ->  ${e.name}${e.mapped ? "" : "  [unmapped]"}`,
      );
    }

    // BOTH SIDES FORMATTED. Comparing prettier's output against the raw file
    // makes any unrelated reformatting — a prettier version bump, a hand-edit
    // elsewhere in the page — look like an adopter data change, which classifies
    // SAFE and auto-pushes to main on the strength of nothing at all.
    updatedHtml = await formatHtml(replaceRegion(html, renderWall(next)), DOCS_PATH);
    changed = updatedHtml !== (await formatHtml(html, DOCS_PATH));
  }

  // ── Job 1: logo health. The live wall MINUS what this run is dropping, plus
  // what it is about to render — see probeTargets.
  const targets = probeTargets(current, next);
  console.log(`\nProbing ${new Set(targets.map((t) => t.url)).size} avatar URL(s)...`);
  const checkMap = await checkLogos(targets);
  const checks = [...checkMap.values()];
  for (const c of checks) {
    if (!c.ok) console.warn(`  ⚠ ${c.repo}: ${c.detail} (${c.kind}) — ${c.url}`);
  }

  const { status, reasons, notes } = classify({
    current,
    next,
    changed,
    checks,
    topCandidate: top,
    meta: repoMeta,
    extraReasons,
  });

  console.log(`\nData changed: ${changed}`);
  const floorDrops = notes
    .filter((n) => n.kind === "star-floor")
    .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.repo.localeCompare(b.repo));
  if (floorDrops.length > 0) {
    console.log(
      `  · ${floorDrops.length} tile(s) fell below the ${STAR_FLOOR}-star floor (deliberate, not an alarm)`,
    );
    for (const n of floorDrops.slice(0, 10)) console.log(`      ${n.repo} (${n.stars})`);
    if (floorDrops.length > 10) console.log(`      ...and ${floorDrops.length - 10} more`);
  }
  for (const n of notes.filter((x) => x.kind === "exclude-list")) {
    console.log(`  · exclude list removed ${n.repo} — ${n.detail}`);
  }
  for (const n of notes.filter((x) => x.kind === "org-handover")) {
    console.log(`  · ${n.repo} left the wall because ${n.detail}`);
  }
  // `  ! ` is a CONTRACT, not formatting: the workflow scrapes this prefix to
  // put the run's real reason into Slack instead of a hardcoded guess. The
  // ADOPTION_WALL_REASON line below carries the same text in a form that does
  // not depend on leading whitespace surviving a log pipeline; both are emitted,
  // one per reason, so either reader works.
  for (const r of reasons) console.log(`  ! ${r}`);
  for (const r of reasons) console.log(`ADOPTION_WALL_REASON=${r.replace(/\s+/g, " ").trim()}`);
  // Machine-readable marker; the workflow branches on the exit code, but this
  // keeps the run log greppable for a human.
  console.log(`\nADOPTION_WALL_STATUS=${status}`);

  // ── State write-back ──────────────────────────────────────────────────────
  //
  // ON ALL THREE VERDICTS, gated on the SCAN and never on the status. `lastScan`
  // records that the adopter list was resolved, which is a different question
  // from whether a human needs to look at the result: a dead avatar, an adopter
  // that genuinely vanished, or a wall below its floor are all things this run
  // FOUND OUT, and a run that found something out scanned fine. Withholding the
  // stamp on NEEDS-REVIEW would be actively harmful — the first dead logo would
  // freeze `lastScan`, and three weeks later every run would carry a SECOND,
  // invented staleness reason on top of the real one, displacing it from the
  // three reasons that reach Slack. The failures that must not stamp are the
  // ones where the run did not learn the answer, and those are exactly what
  // scanIsConclusive tests.
  //
  // A corrupt or missing state file never reaches here: `scan` is still null,
  // so there is no scanned list to write and last week's file is left alone.
  let stateWritten = false;
  let stateWriteNote: string | null = null;
  if (scan !== null) {
    const verdict = scanIsConclusive({ indeterminate: [...scan.indeterminate], checks });
    if (!verdict.ok) {
      stateWriteNote =
        `Adopter state was NOT refreshed and \`lastScan\` did not advance: ${verdict.detail}. ` +
        "A run that could not resolve the list must not stamp it fresh, or the staleness guard " +
        "stops measuring anything.";
      console.warn(`\n⚠ ${stateWriteNote}`);
    } else if (dryRun || verifyOnly) {
      stateWriteNote = `[DRY RUN] Adopter state would have been refreshed at \`${statePath}\`.`;
      console.log(`\n[DRY RUN] Would refresh adopter state at ${statePath}.`);
    } else {
      const nextState = buildNextState({
        adopters: scan.list,
        resolved: scan.resolved,
        absent: scan.absent,
        scannedAt,
      });
      writeFileSync(statePath, serializeState(nextState), "utf-8");
      stateWritten = true;
      const missed = (nextState.adopters ?? []).filter(
        (a) => typeof a.missedRuns === "number" && a.missedRuns > 0,
      ).length;
      stateWriteNote =
        `Adopter state refreshed: \`lastScan\` is now ${scannedAt}, ` +
        `${nextState.adopters?.length ?? 0} entr(y/ies), ${scan.resolved.size} seen by this scan, ` +
        `${missed} carrying a missed run.`;
      console.log(
        `\nRefreshed adopter state at ${statePath}: lastScan=${scannedAt}, ` +
          `${nextState.adopters?.length ?? 0} entr(y/ies), ${scan.resolved.size} resolved, ` +
          `${scan.absent.size} not found by this scan.`,
      );
    }
  }
  // Machine-readable, like ADOPTION_WALL_STATUS: the workflow greps this to
  // decide whether to commit the refreshed file back to the orphan branch. It
  // must NOT be a `  ! ` reason — those are classify()'s output and are what
  // Slack names as the cause of a verdict, and this is neither.
  console.log(`ADOPTION_STATE_WRITTEN=${stateWritten}`);

  if (summaryPath) {
    const md = buildSummary({
      status,
      reasons,
      current,
      next,
      checks,
      verifyOnly,
      disagreements,
      missingFromState: missing,
      notes,
      orgRunnersUp: runnersUp,
      suppressed,
      staleExclusions,
      malformedRepos: malformed,
      stateNote,
      stateWriteNote,
    });
    writeFileSync(resolve(summaryPath), md, "utf-8");
    console.log(`Summary written to ${summaryPath}`);
  }

  if (!verifyOnly && !dryRun && changed) {
    writeFileSync(DOCS_PATH, updatedHtml, "utf-8");
    console.log("Updated docs/index.html.");
  } else if (dryRun && changed) {
    console.log("[DRY RUN] Would update docs/index.html.");
  }

  if (dryRun && status === "SAFE") {
    console.log(
      "[DRY RUN] The change is safe, but nothing was written, so this exits " +
        `${EXIT_CLEAN} rather than ${EXIT_CHANGED_SAFE}: there is nothing to push.`,
    );
  }
  return exitCodeFor(status, { dryRun: dryRun || verifyOnly });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(EXIT_ERROR);
    });
}
