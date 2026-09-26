/** Every tool the Receipts MCP server registers, in registration order. */
export const RECEIPTS_TOOL_NAMES = [
  'receipts.classify','receipts.record','receipts.bind','receipts.verify','receipts.observe','receipts.recheck',
  'receipts.digest','receipts.policy','receipts.claim','receipts.prepare','receipts.dispatch','receipts.release','receipts.complete','receipts.sign','receipts.badge',
] as const;
export type ReceiptsToolName = (typeof RECEIPTS_TOOL_NAMES)[number];
