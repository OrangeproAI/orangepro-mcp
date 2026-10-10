import type { ReportModel } from "./reportModel.js";
import { BRAND_SVG, EVIDENCE_COLOR, FEEDBACK_SCRIPT, RUN_COMMAND, baseCss, esc, feedbackPromptHtml, fmt } from "./reportTheme.js";
import { sinceHtml } from "./summaryReport.js";
import { EVIDENCE_LABEL, VERB_LABEL, VERB_MEANING, VERB_ORDER, type Evidence } from "./worklist.js";
import { TESTS_CSV_COLUMNS, TESTS_CSV_IMPORT } from "./testsExport.js";

/**
 * The detailed report (R14 §6): three views on one page.
 *  - Worklist: every ranked function with its verb, filters, and a side panel with
 *    the evidence, why it ranks, the two test slots and the next step.
 *  - Map: areas of the code by evidence.
 *  - Run details: inputs, counts, proofs, tests, fingerprints, settings.
 * The data is embedded once; the page makes no network requests. "Export tests (CSV)"
 * downloads the same file the run wrote next to it.
 */

const EVIDENCE_ORDER: readonly Evidence[] = ["proven", "runtime", "linked", "unconfirmed", "none"];

export interface DetailedReportInput {
  model: ReportModel;
  /** The tests.csv text the run wrote; embedded so the export works when the page is moved. */
  csv: string;
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function mapSection(model: ReportModel): string {
  const c = model.counts;
  const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");
  const withEv = (a: ReportModel["areas"][number]): number => a.evidence.proven + a.evidence.runtime + a.evidence.linked;
  const maxTotal = Math.max(1, ...model.areas.map((a) => a.total));
  const big = model.areas.filter((a) => a.total >= Math.max(20, maxTotal * 0.1));
  const least = [...big].sort((a, b) => withEv(a) / a.total - withEv(b) / b.total || b.total - a.total).slice(0, 2);
  const delAreas = [...model.areas].filter((a) => a.deletePaths > 0).sort((a, b) => b.deletePaths - a.deletePaths || a.name.localeCompare(b.name)).slice(0, 2);
  const sentences = [`${fmt(c.withEvidence)} of ${fmt(c.mapped)} ${model.noun.plural} (${pct(c.withEvidence, c.mapped)}) have test evidence.`];
  if (least.length) sentences.push(`Least reached among the large areas: ${least.map((a) => `${a.name} (${fmt(withEv(a))} of ${fmt(a.total)})`).join(" and ")}.`);
  if (delAreas.length) sentences.push(`Most code paths that delete data: ${delAreas.map((a) => `${a.name} (${fmt(a.deletePaths)})`).join(" and ")}.`);
  const legend = EVIDENCE_ORDER.map((e) => `<span class="lg"><span class="dot e-${e}"></span>${esc(EVIDENCE_LABEL[e])}</span>`).join("");
  const rows = model.areas
    .map((a) => {
      const segs = EVIDENCE_ORDER.filter((e) => a.evidence[e] > 0)
        .map((e) => `<span style="width:${((a.evidence[e] / a.total) * 100).toFixed(2)}%;background:${EVIDENCE_COLOR[e].fill}"></span>`)
        .join("");
      const width = Math.max(12, Math.round(Math.sqrt(a.total / maxTotal) * 100));
      const aria = `${a.name}: ${withEv(a)} of ${a.total} have evidence`;
      return `<div class="mrow"><span class="m-name"><button type="button" class="areabtn mono" data-area="${esc(a.name)}" title="Show this area in the worklist">${esc(a.name)}</button></span><span class="m-num">${fmt(a.total)}</span><span class="m-bar"><span class="ebar" style="width:${width}%" role="img" aria-label="${esc(aria)}">${segs}</span></span><span class="m-pct">${pct(withEv(a), a.total)}</span><span class="m-del">${a.deletePaths > 0 ? fmt(a.deletePaths) : "&middot;"}</span></div>`;
    })
    .join("\n");
  return `<section id="map" class="view wrap" aria-labelledby="map-h">
  <div class="vhead">
    <div><h1 id="map-h">Where tests reach</h1><p class="lead">${esc(sentences.join(" "))}</p></div>
    <div class="legend">${legend}</div>
  </div>
  <div class="tbl">
    <div class="mrow mhead" aria-hidden="true"><span>Area</span><span class="m-num">${esc(model.noun.title.split(" ")[0])}</span><span>Evidence</span><span class="m-pct">With evidence</span><span class="m-del">Delete paths</span></div>
${rows}
    <p class="tfoot">The ${model.areas.length} largest areas by count. With evidence = proven, run under tests, or linked. Select an area to see its worklist.</p>
  </div>
</section>`;
}

/** The tests spreadsheet: what's in it, the download, and how its columns import into each tool. */
function testsCard(model: ReportModel): string {
  const rows = model.run.tests.map((r) => `<dt>${esc(r.k)}</dt><dd>${esc(r.v)}</dd>`).join("");
  const guides = TESTS_CSV_IMPORT.map(
    (g) => `<div class="guide"><h4>${esc(g.tool)}</h4><p class="tiny muted">${esc(g.setup)}</p><table class="maptbl"><thead><tr><th>Column in tests.csv</th><th>${esc(g.tool)} field</th></tr></thead><tbody>${g.fields
      .map(([col, field]) => `<tr><td class="mono">${esc(col)}</td><td>${esc(field)}</td></tr>`)
      .join("")}</tbody></table><p class="tiny muted">${esc(g.notes)}</p></div>`
  ).join("");
  return `<section class="rcard wide" id="import" aria-labelledby="import-h">
      <div class="rowx"><h3 id="import-h">Tests spreadsheet</h3><a class="btn primary" href="${esc(model.links.csv)}" download="tests.csv" data-csv>Export tests (CSV)</a></div>
      <dl>${rows}</dl>
      <p class="small">One row per test, the ${fmt(model.slotRows * 2)} slots for the ${fmt(model.slotRows)} highest-priority ${esc(model.noun.plural)}, including the ones not drafted yet. UTF-8, opens in Excel and Google Sheets. ${fmt(TESTS_CSV_COLUMNS.length)} columns: the first ${fmt(TESTS_CSV_COLUMNS.indexOf("References") + 1)} are for import, the rest keep the priority, the evidence and the proof command with each test.</p>
      <div class="guides">${guides}</div>
      <p class="tiny muted">The mapping follows each tool's CSV importer. Check the importer's preview before you confirm.</p>
    </section>`;
}

function runSection(model: ReportModel): string {
  const card = (title: string, rows: Array<{ k: string; v: string }>, extra = ""): string =>
    `<section class="rcard"><h3>${esc(title)}</h3><dl>${rows.map((r) => `<dt>${esc(r.k)}</dt><dd>${esc(r.v)}</dd>`).join("")}</dl>${extra}</section>`;
  const proofs = model.proofs.length
    ? `<section class="rcard wide"><h3>Proven</h3><ul class="plist">${model.proofs
        .map((p) => `<li><span class="chip v-done"><span class="dot"></span>Done</span> <span class="mono b">${esc(p.title)}</span> <span class="mono faint tiny">${esc(p.file)}</span><br><span class="small">${p.test ? `<span class="mono">${esc(p.test)}</span> passed on the original code and failed at its own assertion when the function was broken.` : "A test passed on the original code and failed at its own assertion when the function was broken."}</span></li>`)
        .join("")}</ul></section>`
    : "";
  const ai = model.aiFlows;
  const aiFlows = ai
    ? `<section class="rcard wide"><details class="code"><summary>AI-suggested flows (${fmt(ai.flows.length)}): paths to verify, not evidence</summary><p class="small muted">A model proposed ${fmt(ai.proposed)} and ${fmt(ai.accepted)} passed the check against known code. They never count as test evidence.</p><ul class="plist">${ai.flows
        .map((f) => `<li><span class="b">${esc(f.title)}</span> <span class="tiny faint">confidence ${esc(f.confidence)}</span><br><span class="mono tiny">${f.steps.map((st) => esc(st)).join(" &rarr; ")}</span></li>`)
        .join("")}</ul></details></section>`
    : "";
  return `<section id="run" class="view wrap" aria-labelledby="run-h">
  <div class="vhead"><div><h1 id="run-h">Run details</h1><p class="lead">Everything needed to reproduce or question this report.</p></div></div>
  <div class="cards">
    ${card("Inputs", model.run.inputs)}
    ${card("What was counted", model.run.counted)}
    ${card("Proofs", model.run.proofs)}
    ${testsCard(model)}
    ${card("Fingerprints", model.run.fingerprints)}
    ${card("Settings", model.run.settings)}
    ${proofs}
    ${aiFlows}
    <section class="rcard"><h3>What this can&rsquo;t see</h3><ul class="limits"><li>Tests that only check mocks do not count.</li><li>Calls over HTTP or RPC from end-to-end tests are not linked to the handlers they reach.</li><li>Calls through test-suite methods and helper constructors are not always traced, so tested code can show as Unconfirmed.</li></ul><p class="small muted">So the evidence counts are a floor. A missing test is a gap to check, not a bug.</p></section>
    <section class="rcard"><h3>Run it yourself</h3><code class="cmd">${esc(RUN_COMMAND)}</code><p class="small muted">The same commit, git history, settings and OrangePro version give the same ranking. To force a full run when nothing changed, add <code>--fresh</code>.</p></section>
  </div>
  ${feedbackPromptHtml(model.feedback)}
</section>`;
}

export function renderDetailedReport(input: DetailedReportInput): string {
  const { model } = input;
  const commit = model.repo.commit ?? "";
  const short = commit.slice(0, 7);
  const fb = model.feedback;
  const repoLabel = model.repo.web ? `<a href="${esc(model.repo.web.base)}" target="_blank" rel="noopener noreferrer">${esc(model.repo.name)}</a>` : esc(model.repo.name);
  const labels = { verb: VERB_LABEL, meaning: VERB_MEANING, order: VERB_ORDER, evidence: EVIDENCE_LABEL };
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>OrangePro detailed report · ${esc(model.repo.name)}${short ? ` ${esc(short)}` : ""}</title>
<style>${baseCss()}${DETAILED_CSS}</style>
</head>
<body>
<header class="top"><div class="wrap topin">
  <div class="brand">${BRAND_SVG}<b>OrangePro</b><span class="muted">${repoLabel}</span>${short ? `<span class="mono commit">${esc(short)}</span>` : ""}</div>
  <nav class="tabs" aria-label="Report sections"><a href="#worklist" data-tab="worklist" aria-current="page">Worklist</a><a href="#map" data-tab="map">Map</a><a href="#run" data-tab="run">Run details</a></nav>
  <div class="tright"><label for="q" class="sr">Search functions and files</label><input id="q" type="search" placeholder="Search functions or files" autocomplete="off"><a class="btn" href="${esc(model.links.csv)}" download="tests.csv" data-csv>Export tests (CSV)</a><a href="${esc(model.links.summary)}" class="b">One-page summary</a></div>
</div></header>
<div class="wrap sincewrap">${sinceHtml(model)}</div>
<noscript><div class="wrap"><p class="since">The worklist needs JavaScript. The map and run details below work without it, and the tests are in <a href="${esc(model.links.csv)}">${esc(model.links.csv)}</a>.</p></div></noscript>
<section id="worklist" class="view wrap" aria-label="Worklist">
  <div class="layout">
    <aside class="filters" aria-label="Filters"><details class="fdet" open><summary>Filters and export</summary><div id="filters"></div></details></aside>
    <div class="list" id="list"></div>
    <aside class="panel" id="panel" aria-label="Selected function" tabindex="-1"></aside>
  </div>
</section>
${mapSection(model)}
${runSection(model)}
<footer class="wrap foot">Generated by OrangePro ${esc(model.tool)} from ${esc(model.repo.name)}${short ? ` at ${esc(short)}` : ""}${fb ? ` · <a href="${esc(fb.general)}" target="_blank" rel="noopener">Give feedback</a>` : ""} · <a href="https://orangepro.ai" target="_blank" rel="noopener noreferrer">orangepro.ai</a></footer>
<script type="application/json" id="report-data">${json(model)}</script>
<script type="application/json" id="report-labels">${json(labels)}</script>
<script type="application/json" id="tests-csv">${json(input.csv)}</script>
<script>${FEEDBACK_SCRIPT}</script>
<script>${DETAILED_JS}</script>
</body></html>
`;
}

const DETAILED_CSS = String.raw`
.wrap{max-width:1400px;margin:0 auto;padding-left:24px;padding-right:24px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.b{font-weight:600}
.topin{display:flex;flex-wrap:wrap;align-items:center;gap:6px 20px;padding-top:6px;padding-bottom:6px}
.commit{font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;color:var(--muted)}
.tabs{display:flex;gap:2px;flex-wrap:wrap}
.tabs a{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;text-decoration:none;color:var(--muted)}
.tabs a[aria-current="page"]{color:var(--ink);font-weight:600;box-shadow:inset 0 -2px 0 var(--ink)}
.tright{margin-left:auto;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}
#q{min-height:40px;width:260px;max-width:100%;padding:0 12px;border:1px solid #CFCBC2;border-radius:8px;font:inherit;background:#fff}
.sincewrap{padding-top:16px}
.sincewrap .since{margin:0}
.view{padding-top:20px;padding-bottom:40px}
.vhead{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:16px}
.vhead h1{margin:0;font-size:26px}
.lead{margin:4px 0 0;color:var(--ink2);max-width:780px}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr) 380px;gap:20px;align-items:start}
.fdet>summary{display:none}
#filters{display:flex;flex-direction:column;gap:22px}
#filters h2{margin:0 0 2px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.fbtn,.lbtn{display:flex;width:100%;align-items:center;gap:10px;min-height:44px;padding:0 12px;border:1px solid #CFCBC2;border-radius:8px;background:#fff;cursor:pointer;font:inherit;font-size:14px;text-align:left;color:var(--ink);margin-top:6px}
.fbtn[aria-pressed="false"]{background:var(--soft);border-color:var(--line);color:var(--faint)}
.fbtn[aria-pressed="false"] .dot{background:#D8D5CD!important}
.fbtn .fl{flex:1;font-weight:600}
.fc{font-size:12px;color:var(--muted)}
.lbtn{min-height:38px;border-color:var(--line)}
.lbtn span:first-child{flex:1}
.lbtn[aria-pressed="true"]{border-color:var(--ink);font-weight:600}
.fm{margin:4px 0 0;font-size:12px;color:var(--faint)}
select{min-height:40px;padding:0 10px;border:1px solid #CFCBC2;border-radius:8px;font:inherit;background:#fff;max-width:100%;width:100%}
.export{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px}
.export p{margin:0}
.list{min-width:0;display:flex;flex-direction:column;gap:12px}
.lhead{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px}
.lhead h1{margin:0;font-size:26px}
.lhead p{margin:2px 0 0;color:var(--muted)}
.sortw{display:flex;align-items:center;gap:8px}
.sortw label{font-size:13px;color:var(--muted);white-space:nowrap}
.sortw select{width:auto}
.note{margin:0;font-size:12.5px;color:var(--faint)}
.tbl{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.grid{display:grid;grid-template-columns:36px minmax(0,1.5fr) minmax(0,1.3fr) 76px 64px;gap:0 12px;align-items:center}
.thead{padding:10px 12px;font-size:12px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--line)}
.rows{list-style:none;margin:0;padding:0}
.row{width:100%;border:0;border-bottom:1px solid var(--line2);background:#fff;padding:9px 12px;text-align:left;cursor:pointer;font:inherit;color:inherit;min-height:56px}
.row:hover{background:#FBFAF7}
.row.sel{background:var(--sel);box-shadow:inset 3px 0 0 var(--accent)}
.c-rank{font-size:12.5px;color:var(--muted)}
.c-fn{min-width:0}
.nm{display:block;font-size:13px;font-weight:600}
.fl{display:block;font-size:11.5px;color:var(--faint)}
.c-do{display:flex;flex-direction:column;gap:3px;align-items:flex-start;min-width:0}
.rs{font-size:12.5px;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.c-tests{font-size:12.5px;color:var(--ink2)}
.c-pri{font-size:12.5px}
.pbar{display:block;height:4px;background:var(--soft);border-radius:2px;overflow:hidden;margin-top:4px}
.pbar span{display:block;height:100%;background:var(--ink)}
.lfoot{padding:10px 12px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.empty{padding:24px;text-align:center;color:var(--muted);margin:0}
.panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:18px;position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto}
.panel:focus{outline:none}
.panel h2{margin:0;font-size:16px;line-height:1.35}
.panel h3{margin:0;font-size:13px;color:var(--muted);font-weight:600}
.panel section{display:flex;flex-direction:column;gap:8px}
.panel p{margin:0}
.kick{font-size:12px;color:var(--muted)}
.ident{display:flex;flex-direction:column;gap:4px}
.ident a,.ident span.mono{font-size:12px;color:var(--muted)}
.verbline{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.verbline .chip{font-size:13px;padding:3px 11px}
.box{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.box .tiny{color:var(--muted)}
.box .mono{font-size:12.5px}
.facts{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:14px}
.slot{border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
.slothead{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.slottitle{font-weight:600;font-size:14px}
.s-ready{background:#E3F1E8;color:#17613A}.s-plan{background:#E4ECFB;color:#2B57B5}.s-not_drafted{background:var(--soft);color:var(--muted)}
.plan{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 10px;font-size:13px}
.plan dt{color:var(--muted);font-weight:600}
.plan dd{margin:0}
.plan ol{margin:0;padding-left:18px}
details.code summary{cursor:pointer;font-size:13px;font-weight:600;min-height:28px}
details.code pre{margin-top:6px;max-height:320px;overflow:auto}
.btns{display:flex;flex-wrap:wrap;gap:8px}
.btns .btn{min-height:40px;font-size:13.5px}
.steps{margin:0;padding-left:18px;font-size:14px;display:flex;flex-direction:column;gap:4px}
.tblwrap{overflow-x:auto}
.mrow{display:grid;grid-template-columns:minmax(0,230px) 90px minmax(0,1fr) 110px 110px;gap:0 14px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line2)}
.mhead{font-size:12px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--line)}
.m-num,.m-pct,.m-del{text-align:right}
.m-pct{font-weight:600}
.areabtn{border:0;background:none;padding:6px 0;font-size:13px;font-weight:600;cursor:pointer;text-align:left;text-decoration:underline;text-decoration-color:#CFCBC2;text-underline-offset:3px;color:var(--ink)}
.areabtn:hover{color:var(--accent-ink)}
.ebar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--soft);min-width:40px}
.ebar span{display:block;height:100%;min-width:3px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:12.5px}
.lg .dot{width:10px;height:10px}
.tfoot{margin:0;padding:10px 16px;font-size:12.5px;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:14px;margin-bottom:20px}
.rcard{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.rcard.wide{grid-column:1/-1}
.rcard h3{margin:0;font-size:14px}
.rcard dl{margin:0;display:grid;grid-template-columns:minmax(100px,auto) minmax(0,1fr);gap:6px 14px;font-size:13px}
.rcard dt{color:var(--muted)}
.rcard dd{margin:0;white-space:pre-line}
.rcard p{margin:0}
.rcard .btn{align-self:flex-start}
.rowx{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px}
.guides{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:12px}
.guide{border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.guide h4{margin:0;font-size:13.5px}
.maptbl{width:100%;border-collapse:collapse;font-size:12.5px}
.maptbl th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;padding:4px 6px;border-bottom:1px solid var(--line)}
.maptbl td{padding:4px 6px;border-bottom:1px solid var(--line2);vertical-align:top}
.maptbl td.mono{font-size:12px}
.plist{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;font-size:13.5px}
.limits{margin:0;padding-left:18px;font-size:14px;color:var(--ink2);display:flex;flex-direction:column;gap:4px}
.foot{padding-top:8px;padding-bottom:40px;font-size:12.5px;color:var(--faint)}
.foot a{color:var(--muted)}
@media (max-width:1180px){
  .layout{grid-template-columns:220px minmax(0,1fr)}
  .panel{grid-column:1/-1;position:static;max-height:none}
}
@media (max-width:760px){
  .wrap{padding-left:16px;padding-right:16px}
  .layout{grid-template-columns:minmax(0,1fr)}
  .fdet>summary{display:flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid #CFCBC2;border-radius:8px;background:#fff;font-weight:600;cursor:pointer}
  .fdet[open]>summary{margin-bottom:14px}
  .tright{margin-left:0;width:100%}
  #q{flex:1;width:auto}
  .grid{grid-template-columns:36px minmax(0,1fr);grid-template-areas:"r f" "r d" "r t";gap:4px 10px;align-items:start}
  .thead{display:none}
  .c-rank{grid-area:r}.c-fn{grid-area:f}.c-do{grid-area:d}.c-tests{grid-area:t}.c-pri{display:none}
  .mrow{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"n p" "b b" "c d";gap:4px 10px}
  .mhead{display:none}
  .m-name{grid-area:n}.m-pct{grid-area:p}.m-bar{grid-area:b}.m-num{grid-area:c;text-align:left;font-size:12.5px;color:var(--muted)}.m-del{grid-area:d;font-size:12.5px;color:var(--muted)}
  .m-num::after{content:" counted"}.m-del::before{content:"Delete paths: "}
  .vhead h1,.lhead h1{font-size:22px}
}
`;

const DETAILED_JS = String.raw`
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  var M = JSON.parse($("report-data").textContent);
  var L = JSON.parse($("report-labels").textContent);
  var CSV = JSON.parse($("tests-csv").textContent);
  var EVI_TEXT = {
    proven: "A test passed on the original code and failed at its own assertion when this function was broken.",
    runtime: "Your coverage run executed this function. No test is proven to fail when it breaks yet.",
    linked: "A test calls this function directly. It is not yet proven to fail when the function breaks.",
    unconfirmed: "A test file or a test name points here, but OrangePro could not trace a call from a test to this function. Calls through test-suite methods and helper constructors are not always traced.",
    none: "No test file, test name or traced call points to this function."
  };
  var SLOT = { ready: "Ready", plan: "Plan only", not_drafted: "Not drafted" };
  var LENSES = [["all", "Everything"], ["deletes", "Deletes data"], ["changes", "Changes often (100+ lines)"], ["callers", "Many callers (10+)"], ["schedule", "Runs on a schedule"], ["tests", "Tests drafted"]];
  var NOUN = M.noun.plural, ONE = M.noun.singular;

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function brk(s) { return esc(s).replace(/([./])/g, "$1<wbr>"); }
  function fmt(n) { return Number(n).toLocaleString("en-US"); }
  function areaOf(f) { var p = String(f).split("/"); if (p.length <= 2) return p.length === 2 ? p[0] : "."; return p.slice(0, 2).join("/"); }
  function codeUrl(file, line) {
    if (!M.repo.web || !M.repo.commit || !file) return null;
    var enc = file.split("/").map(encodeURIComponent).join("/");
    var a = line ? "#L" + line : "";
    return M.repo.web.host === "gitlab" ? M.repo.web.base + "/-/blob/" + M.repo.commit + "/" + enc + a : M.repo.web.base + "/blob/" + M.repo.commit + "/" + enc + a;
  }
  function pathLink(file, line, label) {
    var url = codeUrl(file, line);
    var text = brk(label || (file + (line ? ":" + line : "")));
    return url ? '<a class="mono" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>" : '<span class="mono">' + text + "</span>";
  }
  function chip(verb) { return '<span class="chip v-' + verb + '"><span class="dot"></span>' + esc(L.verb[verb]) + "</span>"; }

  var rows = M.worklist.slice();
  M.proofs.forEach(function (p) {
    rows.push({ id: p.id, rank: null, title: p.title, file: p.file, line: p.line, area: areaOf(p.file), score: null, evidence: "proven", verb: "done",
      reason: (p.test ? p.test + " fails when it breaks." : "A test fails when it breaks."), provenTest: p.test, provenTestPath: p.testPath,
      facts: [], churn: 0, callers: 0, scheduled: false, prove: "" });
  });
  var byId = {};
  rows.forEach(function (r) { byId[r.id] = r; });
  function drafted(r) { return !!(r.slots && r.slots.some(function (s) { return s.state !== "not_drafted"; })); }
  function lensMatch(r, k) {
    switch (k) {
      case "deletes": return !!r.deletes;
      case "changes": return r.churn >= 100;
      case "callers": return r.callers >= 10;
      case "schedule": return !!r.scheduled;
      case "tests": return drafted(r);
      default: return true;
    }
  }
  var verbCount = { done: 0, prove: 0, check: 0, write: 0 };
  rows.forEach(function (r) { verbCount[r.verb] += 1; });
  var areaCount = {};
  rows.forEach(function (r) { areaCount[r.area] = (areaCount[r.area] || 0) + 1; });
  var areaList = Object.keys(areaCount).sort(function (a, b) { return areaCount[b] - areaCount[a] || (a < b ? -1 : a > b ? 1 : 0); });

  var S = { verbs: { done: true, prove: true, check: true, write: true }, lens: "all", area: "", q: "", sort: "priority", limit: 50, sel: rows.length ? rows[0].id : null };
  var PAGE = 50;

  function filtered() {
    var q = S.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (!S.verbs[r.verb]) return false;
      if (!lensMatch(r, S.lens)) return false;
      if (S.area && r.area !== S.area) return false;
      if (q && (r.title + " " + r.file).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var rk = function (r) { return r.rank == null ? 1e9 : r.rank; };
    out.sort(function (a, b) {
      if (S.sort === "churn") return (b.churn - a.churn) || (rk(a) - rk(b));
      if (S.sort === "callers") return (b.callers - a.callers) || (rk(a) - rk(b));
      return rk(a) - rk(b);
    });
    return out;
  }
  function anyFilter() { return S.lens !== "all" || S.area || S.q.trim() || L.order.some(function (v) { return !S.verbs[v]; }); }

  // The list names a test file by its file name; the panel shows the full path.
  function listReason(r) {
    if (r.verb === "check" && r.readFirst) return "Read " + r.readFirst.split("/").pop() + " first: a test there may cover it.";
    if (r.verb === "prove" && r.linkedTest && r.evidence === "linked") return r.linkedTest.split("/").pop() + " calls it; not yet proven to catch a break.";
    return r.reason;
  }
  function testsCell(r) {
    if (r.verb === "done") return "&mdash;";
    if (!r.slots) return '<span class="faint">&mdash;</span>';
    var ready = 0, plan = 0;
    r.slots.forEach(function (s) { if (s.state === "ready") ready++; else if (s.state === "plan") plan++; });
    if (!ready && !plan) return '<span class="faint">Not drafted</span>';
    var out = [];
    if (ready) out.push(ready + " ready");
    if (plan) out.push(plan + (plan === 1 ? " plan" : " plans"));
    return out.join(", ");
  }

  function renderFilters() {
    var h = '<section><h2>What to do</h2>';
    L.order.forEach(function (v) {
      h += '<button type="button" class="fbtn" data-verb="' + v + '" aria-pressed="' + (S.verbs[v] ? "true" : "false") + '" title="' + esc(L.meaning[v]) + '"><span class="dot v-' + v + '"></span><span class="fl">' + esc(L.verb[v]) + '</span><span class="fc mono">' + fmt(verbCount[v]) + "</span></button>";
      h += '<p class="fm">' + esc(L.meaning[v]) + "</p>";
    });
    h += "</section><section><h2>Why it matters</h2>";
    LENSES.forEach(function (l) {
      var n = l[0] === "all" ? rows.length : rows.filter(function (r) { return lensMatch(r, l[0]); }).length;
      h += '<button type="button" class="lbtn" data-lens="' + l[0] + '" aria-pressed="' + (S.lens === l[0] ? "true" : "false") + '"><span>' + esc(l[1]) + '</span><span class="fc mono">' + fmt(n) + "</span></button>";
    });
    h += '</section><section><h2><label for="area">Area</label></h2><select id="area"><option value="">All areas</option>';
    areaList.forEach(function (a) { h += '<option value="' + esc(a) + '"' + (S.area === a ? " selected" : "") + ">" + esc(a) + " (" + fmt(areaCount[a]) + ")</option>"; });
    h += "</select></section>";
    var t = M.tests;
    h += '<section class="export"><h2>Tests</h2><p class="small">' + fmt(t.drafted) + " drafted for the " + fmt(M.slotRows) + " highest-priority " + esc(NOUN) + (t.ready ? ", " + fmt(t.ready) + " ready to run" : "") + ".</p>";
    h += '<a class="btn primary" href="' + esc(M.links.csv) + '" download="tests.csv" data-csv>Export tests (CSV)</a><p class="tiny faint">One row per test, including the ones not drafted yet. Opens in Excel or Google Sheets and imports into TestRail, Jira Xray or Zephyr Scale. <a href="#import" data-goto="import">How the columns map</a></p></section>';
    $("filters").innerHTML = h;
  }

  function renderList() {
    var list = filtered();
    var shown = list.slice(0, S.limit);
    if (S.sel && !list.some(function (r) { return r.id === S.sel; }) && list.length) S.sel = list[0].id;
    var line = anyFilter()
      ? fmt(list.length) + (list.length === 1 ? " matches" : " match") + " these filters"
      : "The " + fmt(M.worklist.length) + " highest-priority of " + fmt(M.counts.ranked) + " ranked " + NOUN + (M.proofs.length ? ", and " + fmt(M.proofs.length) + " done" : "");
    var max = 0;
    M.worklist.forEach(function (r) { if (r.score > max) max = r.score; });
    var h = '<div class="lhead"><div><h1>Worklist</h1><p>' + esc(line) + '</p></div><div class="sortw"><label for="sort">Sort by</label><select id="sort">' +
      [["priority", "Priority"], ["churn", "Changed lines"], ["callers", "Callers"]].map(function (o) { return '<option value="' + o[0] + '"' + (S.sort === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      "</select></div></div>";
    h += '<p class="note">Priority = how likely a change breaks it &times; what a break would hurt &times; how hard a break is to notice. It orders the work; it is not a defect probability.</p>';
    h += '<div class="tbl"><div class="grid thead" aria-hidden="true"><span>#</span><span>Function</span><span>What to do</span><span>Tests</span><span>Priority</span></div>';
    if (!shown.length) h += '<p class="empty">No ' + esc(ONE) + " matches these filters.</p>";
    else {
      h += '<ul class="rows">';
      shown.forEach(function (r) {
        var pct = r.score != null && max > 0 ? Math.max(2, Math.round((r.score / max) * 100)) : 0;
        h += '<li><button type="button" class="row grid' + (r.id === S.sel ? " sel" : "") + '" data-id="' + esc(r.id) + '" aria-label="Show details for ' + esc(r.title) + '">' +
          '<span class="c-rank mono">' + (r.rank == null ? "&mdash;" : r.rank) + "</span>" +
          '<span class="c-fn"><span class="nm mono">' + brk(r.title) + '</span><span class="fl mono">' + brk(r.file) + "</span></span>" +
          '<span class="c-do">' + chip(r.verb) + '<span class="rs">' + esc(listReason(r)) + "</span></span>" +
          '<span class="c-tests">' + testsCell(r) + "</span>" +
          '<span class="c-pri mono">' + (r.score == null ? "&mdash;" : esc(r.score) + '<span class="pbar"><span style="width:' + pct + '%"></span></span>') + "</span></button></li>";
      });
      h += "</ul>";
    }
    h += '<div class="lfoot"><span>Showing ' + fmt(shown.length) + " of " + fmt(list.length) + "</span>" + (list.length > shown.length ? '<button type="button" class="btn" data-more>Show the next ' + fmt(Math.min(PAGE, list.length - shown.length)) + "</button>" : "") + "</div></div>";
    $("list").innerHTML = h;
  }

  function addToOf(r, slot) { return (slot && slot.addTo) || r.addTo || ""; }
  function numbered(a, word) { return a.map(function (s, i) { return (i + 1) + ". " + (word ? s.replace(new RegExp("^" + word + "\\s+", "i"), "") : s); }).join("\n"); }
  function promptFor(r, slot) {
    var P = [];
    var where = r.file + (r.line ? ":" + r.line : "");
    var addTo = addToOf(r, slot);
    P.push("Add a test for " + r.title + " (" + where + ") in " + M.repo.name + (M.repo.commit ? " at commit " + M.repo.commit.slice(0, 12) : "") + ".");
    if (r.facts && r.facts.length) P.push("Why it matters: " + r.facts.join(" "));
    if (r.verb === "check" && r.readFirst) P.push("First read " + r.readFirst + ". If a test there already calls " + r.title + " and checks its result, do not write a new one: strengthen that test if needed and prove it with the command below.");
    else if (r.verb === "prove") P.push((r.linkedTest ? "The test " + r.linkedTest + " calls it" : "A test already runs it") + ". Check that it fails when " + r.title + " is broken; if it does not, add the assertion that is missing.");
    else if (r.reason) P.push("Today: " + r.reason);
    if (slot && slot.state !== "not_drafted") {
      P.push("Test to write: " + slot.title + (slot.type ? " (" + slot.type + ")" : ""));
      var p = slot.plan;
      if (p) {
        if (p.preconditions && p.preconditions.length) P.push("Given:\n" + numbered(p.preconditions, "given"));
        if (p.steps && p.steps.length) P.push("When:\n" + numbered(p.steps, "when"));
        if (p.expected && p.expected.length) P.push("Then:\n" + numbered(p.expected, "then"));
        if (p.testData) P.push("Test data: " + p.testData);
      }
      if (slot.state === "ready" && slot.code) P.push("A draft that passed the compile check:\n" + slot.code);
      else if (slot.code) P.push("An earlier draft did not pass validation (" + (slot.reason || "unknown reason") + "). Use it only as a hint:\n" + slot.code);
    } else {
      P.push("Pick the scenario most likely to catch a real break: drive " + r.title + " through its public entry point and check the observable result, including an error path.");
    }
    if (addTo) P.push("Put it in " + addTo + " (create the file if it does not exist), in the style of the tests around it.");
    P.push("The test must pass on the current code and fail if " + r.title + " is broken, for example if it returns early or returns a fixed value. Do not mock " + r.title + " itself.");
    if (r.prove) P.push("Then prove it with OrangePro:\n" + r.prove.replace("<your test file>", addTo || "<your test file>"));
    return P.join("\n\n");
  }

  function slotHtml(r, s, i) {
    var h = '<div class="slot"><div class="slothead"><span class="chip s-' + s.state + '">' + SLOT[s.state] + "</span>" + (s.type ? '<span class="tag">' + esc(s.type) + "</span>" : "") + (s.framework ? '<span class="tiny faint">' + esc(s.framework) + "</span>" : "") + "</div>";
    if (s.state !== "not_drafted") h += '<p class="slottitle">' + esc(s.title) + "</p>";
    var p = s.plan;
    if (p) {
      h += '<dl class="plan">';
      if (p.preconditions.length) h += "<dt>Given</dt><dd><ol>" + p.preconditions.map(function (x) { return "<li>" + esc(x.replace(/^given\s+/i, "")) + "</li>"; }).join("") + "</ol></dd>";
      if (p.steps.length) h += "<dt>When</dt><dd><ol>" + p.steps.map(function (x) { return "<li>" + esc(x.replace(/^when\s+/i, "")) + "</li>"; }).join("") + "</ol></dd>";
      if (p.expected.length) h += "<dt>Then</dt><dd><ol>" + p.expected.map(function (x) { return "<li>" + esc(x.replace(/^then\s+/i, "")) + "</li>"; }).join("") + "</ol></dd>";
      if (p.testData) h += "<dt>Data</dt><dd>" + esc(p.testData) + "</dd>";
      h += "</dl>";
    }
    if (s.code) h += '<details class="code"><summary>' + (s.state === "ready" ? "Code, ready to run" : "Withheld draft") + "</summary><pre>" + esc(s.code) + "</pre></details>";
    if (s.reason) h += '<p class="tiny muted">' + esc(s.reason) + "</p>";
    if (s.addTo) h += '<p class="tiny">Add to <span class="mono">' + brk(s.addTo) + "</span></p>";
    h += '<div class="btns"><button type="button" class="btn' + (i === 0 ? " primary" : "") + '" data-copy="prompt:' + i + '">Copy prompt for your coding agent</button>' + (s.state === "ready" && s.code ? '<button type="button" class="btn" data-copy="code:' + i + '">Copy code</button>' : "") + "</div></div>";
    return h;
  }

  function renderPanel() {
    var r = S.sel ? byId[S.sel] : null;
    var el = $("panel");
    if (!r) { el.innerHTML = '<p class="muted">Select a ' + esc(ONE) + " to see what to do.</p>"; return; }
    var h = '<div class="ident"><span class="kick">' + (r.rank == null ? "Done" : "#" + r.rank + " of " + fmt(M.counts.ranked) + " ranked &middot; priority " + esc(r.score)) + "</span>" +
      '<h2 class="mono">' + brk(r.title) + "</h2>" + pathLink(r.file, r.line) + "</div>";
    h += '<section class="verbline">' + chip(r.verb) + "<p>" + esc(r.reason) + "</p></section>";
    h += '<section><h3>Evidence</h3><div><span class="chip e-' + r.evidence + '"><span class="dot"></span>' + esc(L.evidence[r.evidence]) + "</span></div><p class=\"small\">" + esc(EVI_TEXT[r.evidence]) + "</p>";
    if (r.provenTest) h += '<div class="box"><span class="tiny">Test that catches a break</span>' + (r.provenTestPath ? pathLink(r.provenTestPath, null, r.provenTest) : '<span class="mono">' + brk(r.provenTest) + "</span>") + "</div>";
    if (r.readFirst) h += '<div class="box"><span class="tiny">Read before writing a new test</span>' + pathLink(r.readFirst, null) + "</div>";
    if (r.linkedTest) h += '<div class="box"><span class="tiny">Test that calls it</span>' + pathLink(r.linkedTest, null) + "</div>";
    h += "</section>";
    if (r.facts && r.facts.length) h += '<section><h3>Why it ranks here</h3><ul class="facts">' + r.facts.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul></section>";
    if (r.verb !== "done") {
      h += "<section><h3>Tests</h3>";
      if (r.slots) r.slots.forEach(function (s, i) { h += slotHtml(r, s, i); });
      else h += '<p class="small">Tests are drafted for the ' + fmt(M.slotRows) + " highest-priority " + esc(NOUN) + '. Your coding agent can write one for this ' + esc(ONE) + ' without a model key here.</p><div class="btns"><button type="button" class="btn primary" data-copy="prompt:-1">Copy prompt for your coding agent</button></div>';
      h += "</section>";
      var steps = [];
      if (r.verb === "check") {
        steps.push("Read " + (r.readFirst || "the test file that points here") + ".");
        steps.push("If a test there drives this " + ONE + ", prove it with the command below.");
        steps.push("If not, write one of the tests above, then prove it.");
      } else if (r.verb === "prove") {
        steps.push("Run the proof with the command below.");
        steps.push("If the test does not fail when the code breaks, add the missing assertion and run it again.");
      } else {
        steps.push("Write one of the tests above.");
        steps.push("Prove it with the command below: it must fail when the code breaks.");
      }
      h += '<section><h3>Next step</h3><ol class="steps">' + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + '</ol><code class="cmd">' + esc(r.prove) + '</code><div class="btns"><button type="button" class="btn" data-copy="prove">Copy prove command</button></div></section>';
    } else {
      h += '<section><h3>Next step</h3><p class="small">Nothing to do now. If this ' + esc(ONE) + "&rsquo;s code changes, it moves back to Prove until the test is run again.</p></section>";
    }
    if (M.feedback) h += '<p><a class="fbwrong" href="' + esc(M.feedback.finding) + '" target="_blank" rel="noopener" data-finding="' + esc(r.title) + '">This looks wrong</a></p>';
    el.innerHTML = h;
  }

  function render() { renderFilters(); renderList(); renderPanel(); }

  function done(btn, ok) {
    var label = btn.getAttribute("data-label") || btn.textContent;
    btn.setAttribute("data-label", label);
    btn.textContent = ok ? "Copied" : "Copy failed: select the text instead";
    setTimeout(function () { btn.textContent = label; }, 1600);
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "0"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(btn, ok);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(btn, true); }, fallback);
    else fallback();
  }
  function saveCsv() {
    var url = URL.createObjectURL(new Blob([CSV], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url; a.download = "tests.csv"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function showTab(name, focus) {
    if (["worklist", "map", "run"].indexOf(name) < 0) name = "worklist";
    ["worklist", "map", "run"].forEach(function (t) { $(t).hidden = t !== name; });
    Array.prototype.forEach.call(document.querySelectorAll(".tabs a"), function (a) {
      if (a.getAttribute("data-tab") === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (focus) window.scrollTo(0, 0);
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    var el;
    if ((el = t.closest("[data-verb]"))) { var v = el.getAttribute("data-verb"); S.verbs[v] = !S.verbs[v]; S.limit = PAGE; render(); return; }
    if ((el = t.closest("[data-lens]"))) { S.lens = el.getAttribute("data-lens"); S.limit = PAGE; render(); return; }
    if ((el = t.closest("[data-more]"))) { S.limit += PAGE; renderList(); return; }
    if ((el = t.closest("[data-csv]"))) { e.preventDefault(); saveCsv(); return; }
    if ((el = t.closest("[data-goto]"))) { e.preventDefault(); history.replaceState(null, "", "#run"); showTab("run"); var target = $(el.getAttribute("data-goto")); if (target) target.scrollIntoView({ block: "start" }); return; }
    if ((el = t.closest("[data-area]"))) { S.area = el.getAttribute("data-area"); S.limit = PAGE; history.replaceState(null, "", "#worklist"); showTab("worklist", true); render(); return; }
    if ((el = t.closest("[data-id]"))) {
      S.sel = el.getAttribute("data-id");
      renderList(); renderPanel();
      if (window.matchMedia("(max-width: 1180px)").matches) { $("panel").scrollIntoView({ block: "start" }); $("panel").focus({ preventScroll: true }); }
      return;
    }
    if ((el = t.closest("[data-copy]"))) {
      var r = byId[S.sel];
      if (!r) return;
      var what = el.getAttribute("data-copy").split(":");
      var i = what.length > 1 ? Number(what[1]) : -1;
      var slot = r.slots && i >= 0 ? r.slots[i] : null;
      var text = what[0] === "prove" ? r.prove : what[0] === "code" ? (slot && slot.code) || "" : promptFor(r, slot);
      copyText(text, el);
      return;
    }
    if ((el = t.closest(".tabs a"))) { e.preventDefault(); var name = el.getAttribute("data-tab"); history.replaceState(null, "", "#" + name); showTab(name, true); }
  });
  document.addEventListener("change", function (e) {
    if (e.target.id === "area") { S.area = e.target.value; S.limit = PAGE; render(); }
    if (e.target.id === "sort") { S.sort = e.target.value; renderList(); }
  });
  $("q").addEventListener("input", function (e) { S.q = e.target.value; S.limit = PAGE; showTab("worklist"); renderList(); renderPanel(); });
  window.addEventListener("hashchange", function () { showTab(location.hash.slice(1)); });

  if (window.matchMedia("(max-width: 760px)").matches) { var d = document.querySelector(".fdet"); if (d) d.removeAttribute("open"); }
  showTab(location.hash.slice(1));
  render();
})();
`;
