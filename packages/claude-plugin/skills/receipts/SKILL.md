---
name: receipts
description: Verify every outward write through Receipts before claiming completion. Use after sending, posting, publishing, changing a remote record, or encountering an uncertain result.
---

# Receipts

Verify every outward write through Receipts before claiming completion.

1. Identify the registered surface, immutable attempt ID, idempotency key, and SHA-256 digest of the exact approved payload. Never replace the approved digest with the observed digest to force a match.
2. Use `receipts.classify` with normalized observations. Tool success, a status flag, or a plausible URL is not proof. Classification alone does not persist proof.
3. Use `receipts.record` to append the observation and its source evidence. Preserve the exact destination identifier; never invent one.
4. Bind only an existing observed object whose read-back matches the approved payload using `receipts.bind`. Then use `receipts.verify` against the audit store before saying complete.
5. For `delivery_unknown`, stop retrying. Read the destination or obtain a real human-supplied ID and package evidence. For `package_unverified`, verify and bind the existing object. Never create a replacement object to fix missing proof.
6. For `prewrite`, rearm only after a fixed cause, new digest, and new attempt. All three are required.

Quote the actual verdict and destination receipt in the final outcome. If the tools or trusted provider observation are unavailable, say unverified; do not manufacture evidence.

The hook provides automatic feedback. The SDK executor wrapper enforces the write path in code. This skill is the cooperative layer for chat clients: it cannot independently block a tool or authenticate user-supplied evidence.
