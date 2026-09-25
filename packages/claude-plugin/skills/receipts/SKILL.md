---
name: receipts
description: Verify every outward write through Receipts before claiming completion. Use after sending, posting, publishing, changing a remote record, or encountering an uncertain result.
---

# Receipts

Verify every outward write through Receipts before claiming completion.

1. Identify the registered surface, exact destination account, immutable attempt ID, caller-supplied action UUID, explicit approval ID, and SHA-256 digest of the exact approved payload. Reuse the action UUID after uncertain delivery; do not replace the approved digest with an observed digest to force a match. A separately approved action needs a new action UUID and approval.
2. Use `receipts.classify` with normalized observations. Tool success, a status flag, or a plausible URL is not proof. Classification alone does not persist proof.
3. Prefer the configured destination connector when available: Receipts performs its own read and reports `evidenceSource: receipts-read` and `independentlyVerified: true`.
4. Keep cooperative chat integrations working with `receipts.record` followed by `receipts.bind` and `receipts.verify`. Caller-supplied provider/human evidence always remains `host-supplied`, `independentlyVerified: false`. Never relabel it as independent proof. Preserve the exact observed destination identifier; never invent one. Do not put payload content or secrets in evidence descriptions or references.
5. For `delivery_unknown`, stop retrying. Read the destination or obtain a real human-supplied ID and package evidence. For `package_unverified`, verify and bind the existing object. Never create a replacement object to fix missing proof.
6. For `prewrite`, rearm only after a fixed cause, new digest, and new attempt. All three are required.
7. Report the actual verdict, account, action, object ID, proof source, and observation time. A historical receipt proves what was observed then. A recheck appends a separate observation; it never silently refreshes or overwrites the original receipt.

If the tools or provider observation are unavailable, say unverified; do not manufacture evidence. When the user or integration requires independent proof, a host-supplied receipt does not meet that requirement.

The hook provides automatic feedback. The SDK executor wrapper enforces the write path in code. This skill is the cooperative layer for chat clients: it cannot independently block a tool or authenticate caller-supplied evidence.
