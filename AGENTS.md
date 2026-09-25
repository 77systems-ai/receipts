# Receipts engineering rules

Read README.md and docs/ARCHITECTURE.md before changing the proof model.

- The public v0.2 is a Node 20+ TypeScript ESM npm monorepo: no UI, billing, accounts, hosted infrastructure, or authentication product.
- Core has zero runtime dependencies. Classification performs no I/O. Unknown surfaces are rejected with not_a_destination_write, never guessed; there are exactly four verdicts.
- Status flags never prove completion. Destination identifiers must be observed, validated per surface, and bound to the approved content digest.
- Audits are append-only and hash chained. Preserve source provenance and executor attribution, but hash freeform evidence; never store payloads, tokens, or raw provider errors. Never invent a destination ID or claim that a hash chain authenticates the source of evidence.
- All permissions default false. Uncertain writes and unbound objects never permit automatic retries or second writes. Rearm only a known prewrite after a fixed cause, new digest, and new attempt.
- SDK wrappers own the uncertainty flag and persist claims before invoking writes. Hooks inject feedback; do not describe them as a security boundary over arbitrary tools.
- Keep all source-business configuration, private data, credentials, and production receipts out of this public repository.
- Run npm test, npm run typecheck, and npm run demo before release. Exercise both MCP transports and REST.
- Do not claim npm publication, registry listing, marketplace approval, or patent filing without destination evidence.

- Caller evidence is always host-supplied and independentlyVerified false. Only locally configured connector reads can mint receipts-read proof. Never deserialize connector code from wire requests.
- Duplicate prevention keys on exact account plus approved action UUID, not content hash. Preserve original action IDs on uncertain outcomes. New actions require distinct approvals.
- Historical receipts and observedAt are immutable. Rechecks append current observations, including edited-content mismatches.
- Every connector must run the public conformance suite and provider-specific identity checks. Live examples require explicit test configuration and must never repeat uncertain writes.
