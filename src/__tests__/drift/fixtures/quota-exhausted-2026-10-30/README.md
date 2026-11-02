# Quota-exhausted fixtures (Drift Tests run 41012506730)

On the scheduled Drift Tests run 41012506730 (Oct 29, 11:10 PM PDT), the
OpenAI drift account ran out of credit. These files let
`src/__tests__/drift-quota-exhausted.test.ts` reproduce that run without a live
key. Some parts are real and some are reconstructed. This file says which.

## Real (copied from the run)

`run-41012506730.json` comes from the run's `drift-report/drift-report.json`
artifact. The failure messages and the critical diffs are verbatim. This
includes the Realtime 1013 close messages and the provider `error` body
inside them. It contains no secrets.

## Reconstructed (not captured)

`responses-http.sse` and `responses-ws.json` are the streams that the
Responses HTTP and Responses WS legs received. They are reconstructions:

- **Why:** the run's artifacts do not keep the Responses legs' raw bodies.
  `drift-report.json` keeps only failure messages and diffs.
- **Event order:** taken from the run's diffs. The HTTP leg saw an extra
  `error` and `response.failed`. The WS leg saw an extra `error`. The leading
  `response.created` / `response.in_progress` events are assumed from the
  normal Responses stream order.
- **Error object:** copied from the `error` body that OpenAI sent on the
  Realtime leg of the same run, for the same key.
- **Synthetic values:** the response id (`resp_quota0001`), `created_at` (`0`),
  `sequence_number` values and the model id are placeholders. They are not
  provider output.
