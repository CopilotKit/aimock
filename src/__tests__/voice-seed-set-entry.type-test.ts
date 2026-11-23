/**
 * Compile-time half of the voice seed-set premise (the runtime half is in
 * drift-sync-gate-determinism.test.ts). `pnpm typecheck` covers this file
 * through tsconfig.test.json. It is never executed: vitest collects only
 * `*.test.ts`.
 *
 * Checks that `detectOpenAIVoiceModelDrift` takes exactly one API-key string:
 * a listing in the first position is a type error, and so is any second
 * argument (which catches an added optional `listing?` parameter). If the
 * signature changes, an `@ts-expect-error` line below stops being an error and
 * `pnpm typecheck` fails. It does not stop other code from composing the
 * exported predicates into detection on another listing; see the KNOWN LIMIT
 * note in drift-sync-gate-determinism.test.ts.
 */
import { detectOpenAIVoiceModelDrift, type VoiceModelDriftResult } from "./drift/voice-models.js";
import { listGeminiModels, listOpenAIModels } from "./drift/providers.js";

export async function voiceSeedSetEntryTypeTest(apiKey: string): Promise<VoiceModelDriftResult[]> {
  const gemini = await listGeminiModels(apiKey);
  const openai = await listOpenAIModels(apiKey);
  return [
    // @ts-expect-error a Gemini listing cannot be fed to the voice seed set
    await detectOpenAIVoiceModelDrift(gemini),
    // @ts-expect-error nor can an OpenAI listing: the entry fetches its own
    await detectOpenAIVoiceModelDrift(openai),
    // @ts-expect-error no second argument, so no optional listing parameter
    await detectOpenAIVoiceModelDrift(apiKey, openai),
    // The one accepted form: an API key.
    await detectOpenAIVoiceModelDrift(apiKey),
  ];
}
