import type { ChatCompletionRequest, FixtureMatch } from "./types.js";

const embeddingRequests = new WeakMap<
  ChatCompletionRequest,
  NonNullable<FixtureMatch["embeddingRequest"]>
>();

/** Keep exact embedding wire inputs off the canonical request seen by predicates and journals. */
export function setEmbeddingRequest(
  request: ChatCompletionRequest,
  embeddingRequest: NonNullable<FixtureMatch["embeddingRequest"]>,
): void {
  embeddingRequests.set(request, embeddingRequest);
}

/** Read the original embedding wire identity for matching and recording, independent of transforms. */
export function getEmbeddingRequest(
  request: ChatCompletionRequest,
): NonNullable<FixtureMatch["embeddingRequest"]> | undefined {
  return embeddingRequests.get(request);
}
