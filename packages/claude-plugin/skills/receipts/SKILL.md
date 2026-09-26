---
name: receipts
description: Guard and verify every outward write through Receipts before claiming completion. Use before sending, posting, publishing, or changing a remote record, and after encountering an uncertain result.
---

# Receipts

Guard every outward write before it happens and verify it before claiming completion.

## Guarded write sequence

1. `receipts.prepare` with the approved action (registered surface, exact destination account, immutable attempt ID, caller-supplied action UUID, explicit approval ID) and exactly one of `payload` (the exact approved content) or `file`. For a file write, author the content into a staging file first and pass `file: { source, destination }`, so the claim covers bytes that cannot drift. `CLAIMED` returns a lease. `DUPLICATE` carries a reason and a hint: reconcile with `receipts.observe` for `completed` or `dispatched`, wait for `active_claim`, and request a separate approval for `approval_reused`. `policy_denied` reserves nothing: stop and report the rule. `receipts.digest`, `receipts.policy`, and `receipts.claim` remain available as separate steps.
2. `receipts.dispatch` with the lease, immediately before the write. `AUTHORIZED` records that the write may happen. `policy_denied` means the shared budget moved: call `receipts.release`, stop, and report the rule.
3. Perform exactly one outward write with your own tool. After a staged prepare, copy the staged file to its destination unchanged; never re-author it. Never dispatch the same lease twice. A crash after dispatch is uncertain until the destination is read back.
4. `receipts.observe` with the real locator or object ID and the same attempt ID. A matching independent read binds the object and completes the lease. `package_unverified` means the bytes written differ from the claimed bytes; follow its hint and do not write again. Without a configured connector, `receipts.record` the observation, `receipts.bind`, then `receipts.complete`.
5. `receipts.sign` only when a shareable proof is requested and a key is configured.

Keep the lease token out of evidence, reports, summaries, and logs. It is your authority for dispatch and release; only its hash is audited.

## Verification rules

1. Reuse the action UUID after uncertain delivery; do not replace the approved digest with an observed digest to force a match. A separately approved action needs a new action UUID and approval.
2. Use `receipts.classify` with normalized observations. Tool success, a status flag, or a plausible URL is not proof. Classification alone does not persist proof.
3. Prefer the configured destination connector when available: Receipts performs its own read and reports `evidenceSource: receipts-read` and `independentlyVerified: true`.
4. Keep cooperative chat integrations working with `receipts.record` followed by `receipts.bind` and `receipts.verify`. Caller-supplied provider/human evidence always remains `host-supplied`, `independentlyVerified: false`. Never relabel it as independent proof. Preserve the exact observed destination identifier; never invent one. Do not put payload content or secrets in evidence descriptions or references.
5. For `delivery_unknown`, stop retrying. Read the destination or obtain a real human-supplied ID and package evidence. For `package_unverified`, verify and bind the existing object. Never create a replacement object to fix missing proof.
6. For `prewrite`, rearm only after a fixed cause, new digest, and new attempt. All three are required.
7. Report the actual verdict, admission decision, account, action, object ID, proof source, and observation time. A historical receipt proves what was observed then. A recheck appends a separate observation; it never silently refreshes or overwrites the original receipt. Use `receipts.recheck` with the original attemptId to append a current read of an already-receipted object: a matching recheck also completes a dispatched lease, an edited object yields `package_unverified`, and the original receipt is never rewritten or refreshed.
8. Use `receipts.sign` or `receipts.badge` only when a shareable proof is requested and the host configured a key. A badge requires independent completion; a proof embeds the full audit snapshot.

If the tools or provider observation are unavailable, say unverified; do not manufacture evidence. When the user or integration requires independent proof, a host-supplied receipt does not meet that requirement.

The hook provides automatic feedback. MCP cannot force an agent to dispatch before writing; the SDK executor wrapper enforces the write path in code. This skill is the cooperative layer for chat clients: it cannot independently block a tool or authenticate caller-supplied evidence.
