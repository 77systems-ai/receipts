# Quickstart: your first verified receipt in 5 minutes

No tokens, no accounts, no npm publish. The file connector proves the whole loop on your own disk: an agent says DONE, Receipts checks the destination.

## 0. Build (one time, ~2 minutes)

```sh
git clone https://github.com/77systems-ai/receipts.git
cd receipts
npm ci
npm run build
```

Needs Node.js 20 or later.

## 1. Stage a file (30 seconds)

```sh
mkdir -p demo/staging demo/out
echo "It is done, and here is the proof." > demo/staging/note.txt
```

## 2. Run the loop (1 minute)

Save this as `quickstart.mjs` in the repo root and run `node quickstart.mjs`:

```js
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { connectReceipts } from './packages/mcp-server/dist/client.js';

const demo = `${process.cwd()}/demo`;
const source = `${demo}/staging/note.txt`;
const destination = `${demo}/out/note.txt`;

const receipts = await connectReceipts({
  env: { RECEIPTS_FILE_ROOTS: demo, RECEIPTS_AUDIT_PATH: `${demo}/audit.jsonl` },
});
try {
  const action = {
    surface: 'file-write',
    attemptId: randomUUID(),
    actionId: randomUUID(),
    destinationAccount: 'local:file', // the file connector's default account
    approvalId: 'quickstart-approval-1',
  };

  const prepared = await receipts.prepare({ action, file: { source, destination } });
  if (prepared.verdict !== 'CLAIMED') throw new Error(String(prepared.hint));

  await receipts.dispatch(prepared.claim);
  await copyFile(source, destination); // the one outward write

  const receipt = await receipts.observe({
    ...action, packageDigest: prepared.packageDigest, locator: { path: destination },
  });
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    independent: receipt.independentlyVerified,
    admission: receipt.admission?.verdict,
  }, null, 2));
} finally {
  await receipts.close();
}
```

Expected output:

```json
{
  "verdict": "complete",
  "independent": true,
  "admission": "COMPLETED"
}
```

`verdict: complete` means the destination was read back and the bytes match the approved package. `independent: true` means the read came from Receipts' own connector, not from the caller claiming success. `admission: COMPLETED` closes the loop on the reservation.

## What just happened

Five calls, four of them Receipts:

1. `receipts.prepare` — digests the exact approved bytes, checks policy, and claims the write in one call. With `file`, the server reads the staged file itself, so the content cannot be re-authored between approval and write.
2. `receipts.dispatch` — durably records that the write may now happen. After this, the outcome is uncertain until the destination is read.
3. The write itself — here, a byte-for-byte copy. Receipts never performs your write; it guards it.
4. `receipts.observe` — the server's own file connector reads the destination back and binds what it finds to the approved digest.
5. `connectReceipts` never hangs: every handshake and call races a 60-second deadline and fails loudly instead of going silent.

Try breaking it: edit `demo/out/note.txt` after the copy and re-run the observe step — you'll get `package_unverified` with a hint telling you what to do, and no signature.

## Next steps

- `receipts.sign` — add an Ed25519 key at startup for shareable signed proofs (`docs/ARCHITECTURE.md`).
- Swap the file connector for GitHub or Gmail with real credentials — same five calls, same guarantees.
- The full tool reference is in `packages/mcp-server/README.md`; error meanings and fixes in `docs/ERRORS.md`.
