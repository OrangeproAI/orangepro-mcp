import type { ReportModel } from "./reportModel.js";
import { ARROW_SVG, BRAND_SVG, FEEDBACK_SCRIPT, RUN_COMMAND, VERB_COLOR, baseCss, breakable, dateText, dateTimeText, esc, feedbackPromptHtml, fmt } from "./reportTheme.js";
import { permalink } from "./shortReport.js";
import { VERB_LABEL, VERB_MEANING, VERB_ORDER, type Verb, type WorkItem } from "./worklist.js";

/**
 * The one-page summary (R14 §6): what to do first, for an engineer or a VP.
 * Headline, one bar of the highest-priority functions by verb, the top five with
 * what to do and the tests drafted for them, one "since the last report" line,
 * how to reproduce, and feedback. Everything else is in the detailed report.
 * Renders only from the saved report data, so the same data gives the same bytes.
 */

const TOP_ROWS = 5;

const VERB_PHRASE: Record<Verb, (n: number) => string> = {
  done: (n) => `${fmt(n)} done`,
  prove: (n) => `${fmt(n)} to prove`,
  check: (n) => `${fmt(n)} to check`,
  write: (n) => `${fmt(n)} to write a test for`
};

export function sinceHtml(model: ReportModel): string {
  if (model.checked) return `<p class="since same">${esc(model.checked.text)}</p>`;
  return `<p class="since${model.since.kind === "unchanged" ? " same" : ""}">${esc(model.since.text)}</p>`;
}

export function checkedText(previousGeneratedAt: string, checkedAt: string, rerendered: boolean, tool: string): string {
  const base = `Checked again ${dateTimeText(checkedAt)}. Nothing changed since this report was made on ${dateTimeText(previousGeneratedAt)}.`;
  return rerendered ? `${base} Findings unchanged; shown with OrangePro ${tool}.` : base;
}

function headline(model: ReportModel): string {
  const n = model.slotRows;
  if (model.counts.mapped === 0) return "No code was found to analyse.";
  if (n === 0) return `Every ranked ${model.noun.singular} is proven. Nothing is left on the worklist.`;
  const parts = VERB_ORDER.filter((v) => model.top[v] > 0).map((v) => VERB_PHRASE[v](model.top[v]));
  const subject = n === 1 ? `this ${model.noun.singular}` : `these ${fmt(n)} ${model.noun.plural}`;
  return `Start with ${subject}: ${parts.join(", ")}.`;
}

function testsLine(item: WorkItem): string {
  const slots = item.slots ?? [];
  if (slots.length === 0) return "";
  const ready = slots.filter((s) => s.state === "ready");
  const plans = slots.filter((s) => s.state === "plan");
  const drafted = [...ready, ...plans];
  if (drafted.length === 0) return `<p class="slots">No tests drafted: ${esc(slots[0]?.reason ?? "")}</p>`;
  const what = [ready.length ? `${ready.length} ready to run` : "", plans.length ? `${plans.length} test ${plans.length === 1 ? "plan" : "plans"}` : ""].filter(Boolean).join(" and ");
  const titles = drafted.map((s) => `&ldquo;${esc(s.title)}&rdquo;`).join(", ");
  return `<p class="slots"><b>Tests drafted:</b> ${what}. ${titles}</p>`;
}

export function renderSummaryReport(model: ReportModel): string {
  const fb = model.feedback;
  const commit = model.repo.commit ?? "";
  const short = commit.slice(0, 7);
  const web = model.repo.web;
  const n = model.slotRows;
  const codeLink = (item: Pick<WorkItem, "title" | "file" | "line">): string =>
    web && commit
      ? `<a class="mono name" href="${esc(permalink(web, commit, item.file, item.line))}" target="_blank" rel="noopener noreferrer">${breakable(item.title)}</a>`
      : `<span class="mono name">${breakable(item.title)}</span>`;
  const fbLink = (name: string): string =>
    fb ? `<a class="fbwrong" href="${esc(fb.finding)}" target="_blank" rel="noopener" data-finding="${esc(name)}" title="Opens the feedback form. This finding's name and code are not sent.">This looks wrong</a>` : "";

  const c = model.counts;
  const pct = c.mapped > 0 ? Math.round((c.withEvidence / c.mapped) * 100) : 0;
  const doneLine = c.proven > 0
    ? `${fmt(c.proven)} ${c.proven === 1 ? model.noun.singular + " is" : model.noun.plural + " are"} already done: a test fails when ${c.proven === 1 ? "it breaks" : "they break"}.`
    : `Nothing is proven yet: no test has been shown to fail when the code breaks.`;

  const bar = n === 0
    ? ""
    : `<section class="card" aria-labelledby="bar-h">
  <div class="rowx"><h2 id="bar-h">What to do with the ${fmt(n)} highest-priority ${esc(model.noun.plural)}</h2><span class="tiny faint">Ranked by how likely a change breaks it, what a break would hurt, and how hard it is to notice.</span></div>
  <div class="bar" role="img" aria-label="${esc(VERB_ORDER.filter((v) => model.top[v] > 0).map((v) => `${model.top[v]} ${VERB_LABEL[v]}`).join(", "))}">${VERB_ORDER.filter((v) => model.top[v] > 0)
      .map((v) => `<span style="width:${((model.top[v] / n) * 100).toFixed(2)}%;background:${VERB_COLOR[v].fill}"></span>`)
      .join("")}</div>
  <div class="legend">${VERB_ORDER.filter((v) => v !== "done" || model.top.done > 0)
      .map((v) => `<div><span class="chip v-${v}"><span class="dot"></span>${VERB_LABEL[v]}</span> <b>${fmt(model.top[v])}</b><p>${esc(VERB_MEANING[v])}</p></div>`)
      .join("")}</div>
</section>`;

  const rows = model.worklist.slice(0, Math.min(TOP_ROWS, n || TOP_ROWS)).map(
    (item) => `<li class="item">
  <div class="rank mono">${item.rank}</div>
  <div class="body">
    <div class="head"><span class="chip v-${item.verb}"><span class="dot"></span>${VERB_LABEL[item.verb]}</span>${codeLink(item)}${item.deletes ? ` <span class="tag">Deletes data</span>` : ""}</div>
    <p class="file mono">${breakable(item.file)}${item.line ? `:${item.line}` : ""}</p>
    <p class="reason">${esc(item.reason)}</p>
    ${testsLine(item)}
    <p class="tiny">${fbLink(item.title)}</p>
  </div>
</li>`
  );

  const fp = (k: string): string => model.run.fingerprints.find((r) => r.k === k)?.v ?? "";
  const configHash = (model.run.settings.find((r) => r.k === "Config")?.v ?? "").split(",")[0] ?? "";
  const inputsLine = model.run.inputs.filter((r) => r.k === "Git history" || r.k === "Coverage").map((r) => `${r.k}: ${r.v}`).join(" · ");
  const repoLabel = web ? `<a href="${esc(web.base)}" target="_blank" rel="noopener noreferrer">${esc(model.repo.name)}</a>` : esc(model.repo.name);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Test-evidence summary · ${esc(model.repo.name)}${short ? ` ${esc(short)}` : ""}</title>
<style>${baseCss()}${SUMMARY_CSS}</style>
</head>
<body>
<header class="top"><div class="wrap topin">
  <div class="brand">${BRAND_SVG}<b>OrangePro</b><span class="muted">Test-evidence summary</span></div>
  <a class="btn" href="${esc(model.links.detailed)}">Open the detailed report ${ARROW_SVG}</a>
</div></header>
<main class="wrap main">
<section class="hero" aria-labelledby="h">
  <p class="meta">${repoLabel}${short ? ` · commit ${web ? `<a class="mono" href="${esc(`${web.base}/${web.host === "gitlab" ? "-/" : ""}commit/${commit}`)}" target="_blank" rel="noopener noreferrer">${esc(short)}</a>` : `<span class="mono">${esc(short)}</span>`}` : ""} · analysed ${esc(dateText(model.generatedAt))} · OrangePro ${esc(model.tool)} · no AI model used for scoring</p>
  <h1 id="h">${esc(headline(model))}</h1>
  <p class="lede">${esc(doneLine)}</p>
  ${sinceHtml(model)}
  <dl class="stats">
    <div><dt>${esc(model.noun.title)}</dt><dd>${fmt(c.mapped)}</dd><p>against ${fmt(c.testFiles)} test files</p></div>
    <div><dt>With test evidence</dt><dd>${fmt(c.withEvidence)} <span class="pct">${pct}%</span></dd><p>proven, run under tests, or linked</p></div>
    <div><dt>Delete data</dt><dd>${fmt(c.deletePaths)}</dd><p>code paths reach a delete</p></div>
    <div><dt>Proven</dt><dd>${fmt(c.proven)}</dd><p>a test fails when the code breaks</p></div>
  </dl>
  <p class="tiny faint">Counts are a floor. Tests that only check mocks, and calls over HTTP from end-to-end tests, are not linked.</p>
</section>
${bar}
${n > 0 ? `<section aria-labelledby="top-h">
  <h2 id="top-h" class="h2">The top ${rows.length}</h2>
  <ol class="items">
${rows.join("\n")}
  </ol>
  <p class="more"><a href="${esc(model.links.detailed)}">All ${fmt(c.ranked)} ranked ${esc(model.noun.plural)}, the tests drafted for the top ${fmt(n)}, and where tests reach ${ARROW_SVG}</a></p>
</section>` : ""}
<section class="card" aria-labelledby="rep-h">
  <h2 id="rep-h">Run it yourself</h2>
  <code class="cmd">${esc(RUN_COMMAND)}</code>
  <p class="small muted">The same commit, git history, settings and OrangePro version give the same ranking.${inputsLine ? ` ${esc(inputsLine.replace(/\.?$/, "."))}` : ""}</p>
  <p class="mono tiny faint">${esc([`${model.analyzer.replace(/^orangepro\./, "")}`, fp("Run") ? `run ${fp("Run")}` : "", configHash ? `config ${configHash}` : ""].filter(Boolean).join(" · "))}</p>
</section>
${feedbackPromptHtml(fb)}
</main>
<footer class="wrap foot">Generated by OrangePro ${esc(model.tool)} from ${esc(model.repo.name)}${short ? ` at ${esc(short)}` : ""}${fb ? ` · <a href="${esc(fb.general)}" target="_blank" rel="noopener">Give feedback</a>` : ""} · <a href="https://orangepro.ai" target="_blank" rel="noopener noreferrer">orangepro.ai</a></footer>
<script>${FEEDBACK_SCRIPT}</script>
</body></html>
`;
}

const SUMMARY_CSS = `
.wrap{max-width:960px;margin:0 auto;padding-left:24px;padding-right:24px}
.topin{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding-top:12px;padding-bottom:12px}
.main{padding-top:36px;padding-bottom:24px;display:flex;flex-direction:column;gap:32px}
.hero{display:flex;flex-direction:column;gap:14px}
.meta{margin:0;font-size:13px;color:var(--faint)}
h1{margin:0;font-size:32px;line-height:1.2;font-weight:700;max-width:820px}
.lede{margin:0;font-size:17px;color:var(--ink2);max-width:780px}
.since{margin:0}
.stats{margin:6px 0 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.stats>div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.stats dt{font-size:12px;font-weight:600;color:var(--muted)}
.stats dd{margin:2px 0 0;font-size:24px;font-weight:700;letter-spacing:-.02em}
.stats .pct{font-size:14px;font-weight:600;color:var(--muted)}
.stats p{margin:0;font-size:12.5px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:12px}
.card h2,.h2{margin:0;font-size:16px}
.h2{font-size:22px}
.rowx{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:6px 12px}
.bar{display:flex;height:16px;border-radius:8px;overflow:hidden;background:var(--soft);gap:2px}
.bar span{display:block;height:100%;min-width:4px}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px 18px}
.legend b{font-size:18px;margin-left:4px}
.legend p{margin:4px 0 0;font-size:13px;color:var(--muted)}
.items{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
.item{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:flex;gap:14px}
.rank{flex:none;width:28px;height:28px;border-radius:8px;background:var(--soft);display:grid;place-items:center;font-size:13px;font-weight:600;color:var(--muted)}
.body{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}
.body p,.card p{margin:0}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.name{font-weight:600;font-size:14.5px;text-decoration-color:#CFCBC2}
.file{margin:0;font-size:12px;color:var(--faint)}
.reason{margin:2px 0 0;font-size:14.5px;color:var(--ink2)}
.slots{margin:2px 0 0;font-size:13px;color:var(--muted)}
.slots b{color:var(--ink2);font-weight:600}
.more{margin:12px 0 0;font-weight:600}
.more a{display:inline-flex;align-items:center;gap:6px}
.foot{padding-top:8px;padding-bottom:40px;font-size:12.5px;color:var(--faint)}
.foot a{color:var(--muted)}
@media (max-width:760px){
  .wrap{padding-left:16px;padding-right:16px}
  h1{font-size:25px}
  .lede{font-size:16px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .item{padding:14px;gap:10px}
}
`;
