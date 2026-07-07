import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src', 'local', 'viz', 'behaviorReport.template.html');
const OUT = process.argv[2] ?? path.join(__dirname, '..', 'src', 'local', 'viz', 'behaviorReportHtml.ts');

let html = fs.readFileSync(SRC, 'utf8');

// Replace the demo `window.DATA = {...};` literal with a placeholder.
// Tolerant of both pretty-printed and minified single-line demo data.
const dataMatch = html.match(/window\.DATA\s*=\s*\{[\s\S]*?\};/);
if (!dataMatch) throw new Error('DATA anchor not found');
html = html.replace(dataMatch[0], 'window.DATA = __ORANGEPRO_DATA__;');
if (html.includes('window.DATA = {') || /window\.DATA\s*=\s*\{/.test(html)) {
  throw new Error('more than one window.DATA literal found — template unexpected');
}

// Escape for a JS template literal.
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const ts = `// AUTO-GENERATED from private/design/behavior-report-vision.html — do not edit by hand.
// Regenerate: node scripts/gen-behavior-report-renderer.mjs
import type { BehaviorReportData } from "./behaviorReportData.js";

const TEMPLATE = \`${escaped}\`;

/** JSON safe to embed inside an inline <script> (neutralize </script> and JS line separators). */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\\\u003c")
    .replace(/\\u2028/g, "\\\\u2028")
    .replace(/\\u2029/g, "\\\\u2029");
}

/** Render the self-contained behavior report HTML from the report data object. */
export function renderBehaviorReport(data: BehaviorReportData): string {
  return TEMPLATE.replace("__ORANGEPRO_DATA__", () => safeJson(data));
}
`;

fs.writeFileSync(OUT, ts);
console.log('wrote', OUT, '(' + fs.statSync(OUT).size + ' bytes)');
