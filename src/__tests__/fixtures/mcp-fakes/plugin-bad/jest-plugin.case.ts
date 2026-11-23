/**
 * F12 case: the jest plugin's `beforeAll` must fail when the fixture file
 * holds a bad `mcpFakes` block. The jest plugin uses the `beforeAll` globals,
 * which vitest provides under `globals: true`. Run only as a child process by
 * `src/__tests__/mcp-fakes-plugins.test.ts`, which sets the env var below.
 */
import { it } from "vitest";
import { useAimock } from "../../../../jest.js";

const fixtures = process.env.AIMOCK_PLUGIN_BAD_FIXTURE;
if (!fixtures) throw new Error("AIMOCK_PLUGIN_BAD_FIXTURE is not set");

useAimock({ fixtures, patchEnv: false });

it("is never reached when beforeAll fails", () => {});
