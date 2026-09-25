# Receipts OpenTelemetry

`@77systems/receipts-otel` provides optional instrumentation around verification operations and the real SDK executor. Core remains dependency-free and its unwrapped `classify` remains pure.

```ts
import {createReceiptsTelemetry} from '@77systems/receipts-otel';
import {JsonlAuditStore} from '@77systems/receipts-core';
import {trace} from '@opentelemetry/api';

const telemetry=createReceiptsTelemetry({
  store:new JsonlAuditStore('/absolute/local/audit.jsonl'),
  tracer:trace.getTracer('your-agent'),
});
const decision=telemetry.classify(write);
const receipt=await telemetry.observeDestination(connector,request);
const client=telemetry.createClient({connector,policy});
await client.execute(approvedExecution);
```

Configure an OpenTelemetry provider/exporter in your application using the [official instrumentation guide](https://opentelemetry.io/docs/languages/js/instrumentation/). This package does not register a provider, install an exporter, or send network requests. Without your provider/exporter, the standard API is a no-op. Export to a local collector or another destination only when you choose to enable it.

Spans: `receipts.classify`, `receipts.observe`, `receipts.bind`, `receipts.receipt.issue`, and `receipts.execute`. `createClient` preserves the SDK's claims, policy enforcement, read-back and completion checks. `reconcile` and `recheck` produce observe spans; returning a complete receipt emits its receipt-issue span. Historical completion is not a freshness claim. Instrumented operations are explicit; importing this package does not monkey-patch core functions or collect every application action.

Allowed attributes are fixed `receipts.verdict` and `receipts.evidence_source` labels, plus valid SHA-256 `receipts.package_digest` and `receipts.observed_package_digest` values when available. SDK denials include DUPLICATE or policy_denied. Errors set error status but never record exception messages, stacks or raw provider codes. No payload, token, account, object, action, approval, URL or freeform text enters these spans. Your own provider/resource/exporter configuration is outside this package's attribute controls.

Instrumentation exceptions never change a verdict or allow another write. Spans are ended even if an attribute setter fails. Tests use a real in-memory OTel exporter to inspect span attributes, denial outcomes and redaction without network access.
