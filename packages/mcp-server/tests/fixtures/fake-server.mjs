// A deliberately minimal stdio JSON-RPC peer whose framing and timing the tests control.
// FAKE_MODE: chunked | stall-call | stall-init | exit-on-call. FAKE_PID_FILE receives this pid.
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE ?? 'chunked';
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write one byte per pipe write, yielding between them, so the reader sees many partial chunks. */
async function send(message) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
  if (mode !== 'chunked') { process.stdout.write(bytes); return; }
  for (const byte of bytes) { process.stdout.write(Buffer.from([byte])); await delay(1); }
}

let buffer = '';
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      if (mode === 'stall-init') continue;
      await send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-receipts', version: '0.0.0' } } });
    } else if (message.method === 'tools/call') {
      if (mode === 'stall-call') continue; // Accept the request and never answer: the hang the client must break.
      if (mode === 'exit-on-call') process.exit(3);
      const value = { packageDigest: `sha256:${'d'.repeat(64)}`, encoding: 'receipts-json-v1', echoed: message.params.name };
      await send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } });
    }
  }
});
// Stay alive until stopped; a stalled server must not exit on its own.
setInterval(() => undefined, 60_000);
