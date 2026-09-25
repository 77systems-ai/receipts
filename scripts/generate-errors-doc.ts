// Writes docs/ERRORS.md from the error taxonomy in packages/core/src/errors.ts.
// Run with `npm run docs:errors`; a core test fails when the file is out of date.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderErrorTaxonomyMarkdown } from "../packages/core/src/errors.js";

const target = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "ERRORS.md");
writeFileSync(target, renderErrorTaxonomyMarkdown());
process.stdout.write(`Wrote ${target}\n`);
