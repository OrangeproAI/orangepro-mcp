import path from "node:path";
import type { RiskGap } from "../score/risk.js";
import type { BehaviorReportData } from "./behaviorReportData.js";

/**
 * Short, plain-language summary written next to the detailed behavior report.
 *
 * It reads the SAME report data and ranking rows as the detailed report and adds
 * no scoring, tiers or counts of its own: every number on the page is a field of
 * `BehaviorReportData` or of the `RiskGap` rows behind it. Offline and
 * self-contained (no scripts or styles from the network). Code links are plain
 * anchors to the repository host, only when the git remote is a known host.
 */

export const SHORT_REPORT_PREFIX = "short_";

/** `dir/behavior-coverage.html` → `dir/short_behavior-coverage.html`. */
export function shortReportPath(detailedPath: string): string {
  return path.join(path.dirname(detailedPath), `${SHORT_REPORT_PREFIX}${path.basename(detailedPath)}`);
}

export interface ShortReportProof {
  symbolId: string;
  title: string;
  file: string;
  /** Mutation expression or sentinel the oracle used, when recorded. */
  sentinel?: string;
  /** Test file (and node id, when the runner command names one). */
  testPath?: string;
  testId?: string;
  /** True when `testPath` is a repository-relative path that can be linked. */
  testPathResolved?: boolean;
  /** True when the proving test was written by a model rather than taken from the repository. */
  generated?: boolean;
}

export interface ShortReportInput {
  data: BehaviorReportData;
  /** Aligned 1:1 with `data.risks`. */
  topGaps: RiskGap[];
  /** Aligned 1:1 with `data.worklists.irreversible`. */
  deleteGaps: RiskGap[];
  /** Ranked unproven paths reaching a destructive call, before the display cap. */
  deleteTotal: number;
  /** Destructive paths already Dynamically Proven (the worklist omits them). */
  provenDeleteGaps?: RiskGap[];
  proofs: ShortReportProof[];
  /** Source line of a CodeSymbol external id, when known. */
  lineOf: (symbolId: string) => number | undefined;
  /** Web base of the repository (`https://github.com/org/repo`), or null for no code links. */
  repoWeb?: RepoWeb | null;
  /** Relative href of the detailed report written next to this one. */
  detailedHref: string;
  /** Denominator composition by symbol kind; picks an accurate noun for the counts. */
  kinds?: { functionLike: number; classes: number; total: number };
}

export interface RepoWeb {
  base: string;
  host: "github" | "gitlab";
}

/**
 * Web base for a git remote on a known host, with any credentials removed.
 * Unknown hosts return null, so no link is ever guessed.
 */
export function repoWebFromRemote(remote: string | null | undefined): RepoWeb | null {
  if (!remote) return null;
  let r = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(r);
  if (scp) r = `https://${scp[1]}/${scp[2]}`;
  let url: URL;
  try {
    url = new URL(r.replace(/^ssh:\/\//, "https://").replace(/^git:\/\//, "https://"));
  } catch {
    return null;
  }
  const hostName = url.hostname.toLowerCase();
  const host = hostName === "github.com" ? "github" : hostName === "gitlab.com" ? "gitlab" : null;
  if (!host) return null;
  const repoPath = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "").replace(/^\/+/, "");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repoPath)) return null;
  return { base: `https://${hostName}/${repoPath}`, host };
}

/** Plural noun that truthfully describes what the denominator counts. */
export function denominatorNoun(kinds?: { functionLike: number; classes: number; total: number }): { plural: string; singular: string; title: string } {
  if (!kinds || kinds.total === 0 || kinds.functionLike / kinds.total >= 0.9) return { plural: "functions", singular: "function", title: "Functions mapped" };
  if ((kinds.functionLike + kinds.classes) / kinds.total >= 0.9) return { plural: "functions and classes", singular: "function or class", title: "Functions and classes mapped" };
  return { plural: "code symbols", singular: "code symbol", title: "Code symbols mapped" };
}

// Labels the oracle records in place of a concrete value (mode names, not code).
const SENTINEL_MODE_LABELS = new Set(["return-json", "promise-json", "go-zero-return", "java-typed-sentinel"]);

/**
 * The replacement a proof applied, as code, from the certificate's `sentinel`
 * (the value; `sentinel_source` only says how it was chosen). Mode labels and
 * empty values return undefined so the page states it in words instead.
 */
export function proofSentinelText(sentinel: string | undefined): string | undefined {
  const value = sentinel?.trim();
  if (!value || SENTINEL_MODE_LABELS.has(value)) return undefined;
  return /^return\b/.test(value) ? value : `return ${value}`;
}

/**
 * Repository-relative path for a test path recorded relative to a sub-project
 * (`tests/x.py` run from `pkg/` → `pkg/tests/x.py`). Resolved only when exactly
 * one scanned file matches; otherwise the recorded path is kept as is.
 */
export function repoRelativeTestPath(recorded: string, repoFiles: readonly string[]): { path: string; resolved: boolean } {
  const clean = recorded.replace(/^\.\//, "");
  if (repoFiles.includes(clean)) return { path: clean, resolved: true };
  const matches = repoFiles.filter((f) => f.endsWith(`/${clean}`));
  return matches.length === 1 ? { path: matches[0]!, resolved: true } : { path: clean, resolved: false };
}

/**
 * Where a proof's test lives, from the certificate. Runners record the test as
 * `file::selector` relative to the project they ran in; the file part is resolved
 * to a repository path (unique match only) and the selector is kept. When the
 * recorded path has no selector, the one in the runner command for that file is used.
 */
export function proofTestLocation(
  recorded: string | undefined,
  command: string | undefined,
  repoFiles: readonly string[]
): { testPath?: string; testPathResolved?: boolean; testId?: string } {
  const value = (recorded ?? "").trim().replace(/^\.\//, "");
  const cut = value.indexOf("::");
  const file = cut >= 0 ? value.slice(0, cut) : value;
  if (!file) return {};
  let selector = cut >= 0 ? value.slice(cut) : "";
  if (!selector && command) {
    for (const m of command.matchAll(/(\S+?\.\w+)(::\S+)/g)) {
      if (m[1]!.replace(/^['"]?\.?\/?/, "").endsWith(file)) {
        selector = m[2]!.replace(/['"]+$/, "");
        break;
      }
    }
  }
  const where = repoRelativeTestPath(file, repoFiles);
  return { testPath: where.path, testPathResolved: where.resolved, ...(selector ? { testId: `${where.path}${selector}` } : {}) };
}

export function permalink(web: RepoWeb, commit: string, file: string, line?: number): string {
  const enc = file.split("/").map(encodeURIComponent).join("/");
  const anchor = line ? `#L${line}` : "";
  return web.host === "gitlab" ? `${web.base}/-/blob/${commit}/${enc}${anchor}` : `${web.base}/blob/${commit}/${enc}${anchor}`;
}

// Generic container words that never name the data itself.
const STORE_NOISE = new Set([
  "self", "this", "cls", "s", "r", "c", "db", "database", "table", "tables", "client", "clients", "conn", "connection",
  "session", "tx", "txn", "repo", "repository", "store", "collection", "model", "models", "objects", "query", "manager",
  "orm", "dao", "ctx", "app", "api", "svc", "service", "opts", "options", "cfg", "conf", "deps", "impl", "inner", "base",
  "util", "utils", "helper", "helpers", "mgr"
]);
const STORE_SUFFIX = /(Repository|Repo|Table|Client|Dao|DAO|Collection)$|_(repository|repo|table|client|dao|collection)$/;

function words(identifier: string): string {
  const spaced = identifier
    .replace(/^_+/, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .trim();
  const parts = spaced.split(/\s+/).filter(Boolean).map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()));
  if (parts.length === 0) return "";
  const first = parts[0]!;
  parts[0] = /^[A-Z0-9]{2,}$/.test(first) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return parts.join(" ");
}

function meaningful(identifier: string): string | null {
  const stripped = identifier.replace(STORE_SUFFIX, "");
  if (!stripped || STORE_NOISE.has(stripped.toLowerCase()) || STORE_NOISE.has(identifier.toLowerCase())) return null;
  // Abbreviations (`pm`, `bs`) name nothing a reader recognizes; acronyms (`MCP`) do.
  if (stripped.replace(/^_+/, "").length < 4 && !/^[A-Z0-9]{2,}$/.test(stripped)) return null;
  return words(stripped) || null;
}

/**
 * Plain-language name for what a destructive call removes, read from the names in
 * the call itself (`OrdersRepository(conn).table.delete` → "Orders",
 * `self._session_cache.delete` → "Session cache"), else from the class that owns
 * the call (`AccountsRepository.remove_by_id` → "Accounts"). Names only; never a guess
 * beyond them. Empty string when nothing meaningful is named.
 */
export function storeLabel(sink: string, owner?: string): string {
  const qualifier = sink.replace(/\([^()]*\)/g, "()").split(".").slice(0, -1).join(".");
  for (const id of qualifier.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const label = meaningful(id);
    if (label) return label;
  }
  const ownerClass = owner?.split("#").pop()?.split(".").slice(-2, -1)[0];
  if (ownerClass && /^[A-Z]/.test(ownerClass)) {
    const label = meaningful(ownerClass);
    if (label) return label;
  }
  return "";
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fmt = (n: number): string => n.toLocaleString("en-US");

/** Escaped symbol name with line-break opportunities after each dot. */
const breakable = (label: string): string => esc(label).replace(/\./g, ".<wbr>");

type Tier = "none" | "candidate" | "associated" | "proven";

const TICK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const WARN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="M8 4.5v4.2M8 11.2v.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>';
const CROSS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';
const DL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2v8m-3.5-3.5L8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

function pill(tier: Tier): string {
  if (tier === "none") return `<span class="pill pill-gap">${WARN} No test found</span>`;
  if (tier === "candidate") return `<span class="pill pill-gap">${WARN} Name match only</span>`;
  if (tier === "associated") return `<span class="pill pill-ok">${TICK} Linked test</span>`;
  return `<span class="pill pill-ok">${TICK} Proven</span>`;
}

function tierOf(gap: RiskGap | undefined, provenIds: Set<string>): Tier {
  if (gap && provenIds.has(gap.id)) return "proven";
  return gap?.detection_tier ?? "none";
}

const RUN_COMMAND = "npx -y @orangepro/orangepro-mcp start .";

export function renderShortReport(input: ShortReportInput): string {
  const { data } = input;
  // Feedback links only: nothing is sent from this page. The finding link carries no
  // name, path or code; the page notes locally which finding the reader picked.
  const fb = data.feedback;
  const fbLink = (name: string): string =>
    fb ? ` <a class="fbwrong" href="${esc(fb.finding)}" target="_blank" rel="noopener" data-finding="${esc(name)}" title="Opens the feedback form. This finding's name and code are not sent.">This looks wrong</a>` : "";
  const s = data.summary;
  const prov = data.provenance;
  const commit = prov.commit ?? "";
  const short = commit.slice(0, 7);
  // The host path names the repository better than a local folder name does.
  const repoName = input.repoWeb ? input.repoWeb.base.replace(/^https:\/\/[^/]+\//, "") : (prov.gitRoot ?? data.repo);
  const nounInfo = denominatorNoun(input.kinds);
  const noun = nounInfo.plural;
  const tests = data.scan.tests.total;
  const days = data.configDisclosure.tuning.churn_window_days;
  const excluded = data.configDisclosure.rankExcludePaths;
  const provenIds = new Set(input.proofs.map((p) => p.symbolId));
  const pct = s.total > 0 ? (s.associated / s.total) * 100 : 0;

  const testCell = (p: ShortReportProof): string => {
    const label = `<span class="mono">${breakable(p.testId ?? p.testPath ?? "")}</span>`;
    if (!input.repoWeb || !commit || !p.testPath || !p.testPathResolved) return label;
    return `<a class="mono code" href="${esc(permalink(input.repoWeb, commit, p.testPath))}" target="_blank" rel="noopener noreferrer">${breakable(p.testId ?? p.testPath)}</a>`;
  };

  const link = (label: string, file: string, symbolId: string): string => {
    const line = input.lineOf(symbolId);
    if (!input.repoWeb || !commit) return `<span class="mono">${breakable(label)}</span>`;
    return `<a class="mono code" href="${esc(permalink(input.repoWeb, commit, file, line))}" target="_blank" rel="noopener noreferrer">${breakable(label)}</a>`;
  };

  // ---- delete paths ----
  const deletes = [
    ...data.worklists.irreversible.map((row, i) => {
      const gap = input.deleteGaps[i];
      return { row, gap, tier: tierOf(gap, provenIds), store: storeLabel(row.sink, gap?.sink_owner) };
    }),
    ...(input.provenDeleteGaps ?? []).map((gap) => ({
      row: { path: gap.title, file: gap.file, sink: gap.sink_callee ?? "" },
      gap,
      tier: "proven" as Tier,
      store: storeLabel(gap.sink_callee ?? "", gap.sink_owner)
    }))
  ];
  const unlinked = deletes.filter((d) => d.tier === "none" || d.tier === "candidate");
  const linkedDeletes = deletes.filter((d) => d.tier === "associated");
  const provenDeletes = deletes.filter((d) => d.tier === "proven");
  const nDel = deletes.length;
  const capped = input.deleteTotal > data.worklists.irreversible.length;
  const allFound = input.deleteTotal + provenDeletes.length;
  const delScope = capped ? `the ${nDel} highest-ranked code paths that delete data (of ${fmt(allFound)} found)` : `the ${nDel} code paths that delete data`;

  const provenDeleteIds = new Set(provenDeletes.map((d) => d.gap?.id ?? ""));
  const rankOf = new Map(data.risks.map((r, i) => [input.topGaps[i]?.id ?? "", r.rank]));
  const deleteIds = new Set(input.deleteGaps.map((g) => g.id));

  // ---- headline ----
  const headline = nDel > 0
    ? unlinked.length > 0
      ? `${fmt(s.total)} ${noun} mapped. ${unlinked.length} of ${capped ? `the ${nDel} highest-ranked` : nDel} code paths that delete data have no test linked to them.`
      : `${fmt(s.total)} ${noun} mapped. Every ranked code path that deletes data has a linked test.`
    : `${fmt(s.total)} ${noun} mapped. ${fmt(s.associated)} are linked to a test and ${fmt(s.proven)} are proven.`;

  // ---- where to start ----
  const actions: string[] = [];
  if (unlinked.length > 0) {
    const byStore = new Map<string, number>();
    for (const d of unlinked) if (d.store) byStore.set(d.store, (byStore.get(d.store) ?? 0) + 1);
    const kinds = [...byStore.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const kindText = kinds.length > 0
      ? ` They delete from ${kinds.length} place${kinds.length === 1 ? "" : "s"}: ${kinds.map(([k, n]) => (n > 1 ? `${esc(k)} (${n} paths)` : esc(k))).join(", ")}.`
      : "";
    const first = unlinked.slice(0, 2);
    const ranks = first.map((d) => (d.gap ? rankOf.get(d.gap.id) : undefined));
    const rankText = ranks.every((r) => r !== undefined) ? ` (${ranks.map((r) => `#${r}`).join(" and ")} overall)` : "";
    actions.push(
      `<li><strong>Add tests for the ${unlinked.length} delete path${unlinked.length === 1 ? "" : "s"} with no linked test.</strong>${kindText} ` +
        `Start with the highest-ranked: ${first.map((d) => `<span class="mono">${esc(d.row.path)}</span>`).join(" and ")}${rankText}. ` +
        `Each test should drive the path to the delete and fail when the check before it is broken.</li>`
    );
  }
  const topOther = data.risks.findIndex((_r, i) => input.topGaps[i] && !deleteIds.has(input.topGaps[i]!.id) && !input.topGaps[i]!.sink_callee);
  if (topOther >= 0) {
    const g = input.topGaps[topOther]!;
    const r = data.risks[topOther]!;
    const refs = g.incoming_refs > 0 ? ` ${fmt(g.incoming_refs)} place${g.incoming_refs === 1 ? "" : "s"} in the code call or import it, and` : "";
    const miss = g.detection_tier === "candidate" ? "no test call to it was traced" : "no test refers to it";
    actions.push(`<li><strong>Cover <span class="mono">${esc(r.path)}</span>, ranked #${r.rank}.</strong>${refs} ${miss}.</li>`);
  }
  actions.push(
    `<li><strong>Then confirm the tests catch breakage.</strong> A linked test is not yet proof. A proof run breaks the function in an isolated copy and checks that the test fails${
      input.proofs.length > 0 ? `, as shown for ${input.proofs.length} ${input.proofs.length === 1 ? "function" : "functions"} in section 03` : ""
    }.</li>`
  );

  const legend =
    '<p class="legend small muted"><strong>No test found</strong>: no test refers to it. <strong>Name match only</strong>: a test with a similar name exists, but no test call to this exact function was traced. ' +
    `<strong>Linked test</strong>: a test calls it directly.${input.repoWeb && commit ? " Names link to the code at the analysed commit." : ""}</p>`;

  // ---- section 01: delete paths ----
  const delSection = nDel === 0
    ? ""
    : `  <section class="block" aria-labelledby="n1">
    <h2 id="n1"><span class="n">01</span> Code paths that delete data</h2>
    <div class="callout">
      <p class="big">${unlinked.length} of ${esc(delScope)} have no test linked to them.</p>
      <p>${linkedDeletes.length > 0 ? `${linkedDeletes.length} ${linkedDeletes.length === 1 ? "has a test that calls it" : "have a test that calls them"} directly. ` : ""}${
        provenDeletes.length > 0
          ? `${provenDeletes.length} ${provenDeletes.length === 1 ? "is" : "are"} proven: the test fails when the code breaks (section 03). `
          : "None is proven yet. "
      }This is missing test protection, not a bug found in the code. Deletes from a cache are not counted. A test that reaches a path only through a fixture, an HTTP client or an end-to-end run is not linked, so check the tests before writing new ones.</p>
    </div>
    ${legend}
    <div class="tblwrap" style="margin-top:8px"><table class="tbl">
      <thead><tr><th style="width:18%">Deletes from</th><th>Function, file and the delete it reaches</th><th style="width:22%">Evidence</th></tr></thead>
      <tbody>
${deletes
  .map(
    (d) =>
      `<tr><td>${esc(d.store || "—")}</td><td>${link(d.row.path, d.row.file, d.gap?.id ?? "")}<span class="tiny muted mono fileline">${esc(d.row.file)}</span><span class="tiny muted fileline">Reaches <span class="mono">${esc(d.row.sink)}</span></span></td><td>${pill(d.tier)}${fbLink(d.row.path)}</td></tr>`
  )
  .join("\n")}
      </tbody>
    </table></div>
  </section>
`;

  // ---- section 02: ranked items ----
  const facts = (g: RiskGap): string[] => {
    const out: string[] = [];
    if (g.incoming_refs > 0) out.push(`${fmt(g.incoming_refs)} incoming reference${g.incoming_refs === 1 ? "" : "s"}`);
    if (g.churn_available !== false) out.push(`${fmt(g.git_churn)} changed line${g.git_churn === 1 ? "" : "s"} in ${days} days`);
    return out;
  };
  const cards = data.risks.slice(0, 3).map((r, i) => {
    const g = input.topGaps[i];
    const tier = tierOf(g, provenIds);
    return `      <article class="card card-gap">
        <div class="row small muted"><span>Priority ${r.rank}</span><span class="mono">Score ${esc(g?.risk_score ?? "")}</span></div>
        <h3 class="cardtitle">${g ? link(r.path, g.file, g.id) : esc(r.path)}</h3>
        <p class="tiny muted mono fileline">${esc(g?.file ?? "")}</p>
        <ul class="prs">${(g ? facts(g) : []).map((f) => `<li>${esc(f)}</li>`).join("")}${g?.sink_callee ? `<li>Reaches <span class="mono">${breakable(g.sink_callee)}</span></li>` : ""}</ul>
        <p class="finding">${pill(tier)}${g?.sink_callee ? ' <span class="pill pill-muted">Deletes data</span>' : ""}</p>
        <p class="tiny">${fbLink(r.path).trim()}</p>
      </article>`;
  });
  const rankedRows = data.risks
    .map((r, i) => {
      const g = input.topGaps[i];
      return `<tr><td class="mono muted">${r.rank}</td><td>${g ? link(r.path, g.file, g.id) : esc(r.path)}<span class="tiny muted mono fileline">${esc(g?.file ?? "")}</span></td><td class="mono">${esc(g?.risk_score ?? "")}</td><td>${pill(tierOf(g, provenIds))}${g?.sink_callee ? ' <span class="pill pill-muted">Deletes data</span>' : ""}${fbLink(r.path)}</td></tr>`;
    })
    .join("\n");
  const rankedSection = data.risks.length === 0
    ? ""
    : `  <section class="block" aria-labelledby="n2">
    <h2 id="n2"><span class="n">02</span> The highest-ranked items without test evidence</h2>
    <p class="sub">The score sets the order of work: how much code depends on it, how often it changes, and what it can break. It is not a defect probability.</p>
    <div class="grid3">
${cards.join("\n")}
    </div>
    <details class="light"><summary>Show all ${data.risks.length} ranked items</summary>
      ${legend}
      <div class="tblwrap"><table class="tbl">
        <thead><tr><th>#</th><th>Function and file</th><th>Score</th><th>Evidence</th></tr></thead>
        <tbody>
${rankedRows}
        </tbody>
      </table></div>
    </details>
  </section>
`;

  // ---- section 03: proofs ----
  const proofItems = input.proofs
    .map(
      (p, i) => `      <li class="fault">
        <div class="row top">
          <div>
            <p class="fault-title"><span class="mono muted">P${i + 1}</span> ${link(p.title, p.file, p.symbolId)}</p>
            <p class="mono tiny muted">${esc(p.file)}</p>
          </div>
          <span>${provenDeleteIds.has(p.symbolId) ? '<span class="pill pill-muted">Deletes data</span> ' : ""}<span class="pill pill-ok">${TICK} Detected</span></span>
        </div>
        <dl class="diff">
          <dt>Simulated</dt><dd>${p.sentinel ? `Function body replaced with <code>${esc(p.sentinel)}</code> in an isolated copy` : "Function replaced with a fixed return value in an isolated copy"}</dd>
          <dt>Test</dt><dd>${p.testId || p.testPath ? testCell(p) : "Recorded in the proof ledger"}${p.generated ? " (generated test)" : " (the project&#39;s own test, unchanged)"}</dd>
        </dl>
        <p class="small muted">The test passed on the original code and failed at its assertion on the simulated change.</p>
      </li>`
    )
    .join("\n");
  // "Did this help?" comes after the findings and proofs, never before them.
  const fbPrompt = !fb
    ? ""
    : fb.prompt.kind === "blocked"
      ? `  <div class="fbblocked">${esc(fb.prompt.question)} <a href="${esc(fb.prompt.answers[0].url)}" target="_blank" rel="noopener">${esc(fb.prompt.answers[0].label)} &rarr;</a></div>`
      : fb.prompt.expanded
        ? `  <div class="fbinvite" id="fbinvite"><span class="fbq">${esc(fb.prompt.question)}</span><span class="fbans">${fb.prompt.answers
            .map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label)}</a>`)
            .join("")}</span><button type="button" class="fbskip" data-fb-skip>Don&rsquo;t ask again</button><p class="fbsub">Opens a short form in a new tab. Nothing is sent unless you press Submit there. Anonymous unless you add an email.</p></div>`
        : "";
  const proofSection = `  <section class="block" aria-labelledby="n3">
    <h2 id="n3"><span class="n">03</span> How existing tests were checked</h2>
    <p class="sub">For a proof, OrangePro runs a test twice: once on the original code, once with the function deliberately broken in an isolated copy.</p>
    <div class="grid2">
      <div class="proof"><span class="ic" style="background:var(--ok-bg);color:var(--ok)">${TICK}</span><div><p class="t">Passes on the original code</p><p class="s">The test is green as the project ships it.</p></div></div>
      <div class="proof"><span class="ic" style="background:var(--orange-bg);color:var(--orange)">${CROSS}</span><div><p class="t">Fails when the function is broken</p><p class="s">At the test&#39;s own assertion, with the function running for real (not mocked).</p></div></div>
    </div>
${input.proofs.length > 0 ? `    <ul class="faults">\n${proofItems}\n    </ul>` : `    <p class="counts">${esc(data.proofGuidance.title)}. ${esc(data.proofGuidance.body)}</p>`}
    <p class="counts">Proven: ${fmt(s.proven)}.</p>
  </section>
`;

  // ---- section 04: still open ----
  const open: string[] = [
    "Tests that only assert on mocks or side effects are not counted as links.",
    "Calls made over HTTP in end-to-end tests are not linked to the handlers they reach.",
    "&ldquo;Name match only&rdquo; is a lead from similar names, not a link."
  ];
  if (nDel > provenDeletes.length) open.push(`${nDel - provenDeletes.length} of the ${nDel} delete paths listed ${nDel - provenDeletes.length === 1 ? "has" : "have"} not been proven. That is the natural next step.`);
  if (prov.churnState && prov.churnState !== "complete") open.push("Change history was not read in full, so the ranking is provisional.");

  // ---- section 05: what ran ----
  const steps: Array<[string, string, string]> = [
    ["Pick the commit and scope", "Analyst", `${short || "working tree"}${excluded.length ? `, with ${excluded.join(", ")} excluded` : ""}`],
    ["Map the code, endpoints and calls", "OrangePro", `${fmt(s.total)} ${noun}, ${fmt(tests)} test files`],
    ["Link tests that call each one", "OrangePro", `${fmt(s.associated)} linked`],
    ["Rank what is left", "OrangePro, deterministic scoring", "Dependence, change history, consequence"],
    ["Break code on purpose, rerun the tests", "OrangePro, the project&#39;s own test runner", `${fmt(s.proven)} proven`],
    ["Return the evidence", "OrangePro", "This summary and the detailed report"]
  ];

  const churnText = prov.churnState === "complete"
    ? `${fmt(prov.commitsScanned ?? 0)} commits over ${days} days, read in full`
    : prov.churnState === "partial"
      ? `Partial: ${fmt(prov.commitsScanned ?? 0)} commits read over ${days} days`
      : "Not available";

  // ---- downloads ----
  const receipt = {
    report: "OrangePro test-evidence summary",
    repository: repoName,
    commit: commit || null,
    analysedOn: data.scanned,
    toolVersion: prov.toolVersion,
    analyzer: prov.identity.analyzer_version,
    scope: { excludedByConfig: excluded, changeHistory: { windowDays: days, commitsRead: prov.commitsScanned ?? null, state: prov.churnState ?? null } },
    counts: {
      denominator: s.total,
      testFiles: tests,
      linkedToATest: s.associated,
      dynamicallyProven: s.proven,
      nameMatchOnly: s.candidate,
      noTestSignal: s.none
    },
    deletePaths: deletes.map((d) => ({ function: d.row.path, file: d.row.file, deleteCall: d.row.sink, deletesFrom: d.store || null, evidence: d.tier })),
    deletePathsFound: allFound,
    ranked: data.risks.map((r, i) => ({ rank: r.rank, function: r.path, file: input.topGaps[i]?.file ?? null, score: input.topGaps[i]?.risk_score ?? null, evidence: tierOf(input.topGaps[i], provenIds) })),
    proven: input.proofs.map((p) => ({ function: p.title, file: p.file, simulated: p.sentinel ?? null, test: p.testId ?? p.testPath ?? null })),
    fingerprints: {
      repositorySnapshot: prov.identity.repository_snapshot,
      analysis: prov.identity.analysis_fingerprint,
      ranking: prov.identity.ranking_fingerprint,
      run: prov.identity.run_fingerprint
    }
  };
  const runRecord = [
    "OrangePro run record",
    "",
    `repository        ${repoName}`,
    `commit            ${commit || "unknown"}`,
    `analysed          ${data.scanned}`,
    `tool              ${prov.toolVersion}`,
    `analyzer          ${prov.identity.analyzer_version}`,
    `ranking           ${prov.identity.ors_version} (deterministic; no AI model used for scoring)`,
    `excluded paths    ${excluded.length ? excluded.join(", ") : "none"}`,
    `change history    ${churnText}`,
    "",
    `denominator       ${fmt(s.total)}`,
    `test files        ${fmt(tests)}`,
    `linked to a test  ${fmt(s.associated)}`,
    `name match only   ${fmt(s.candidate)}`,
    `no test signal    ${fmt(s.none)}`,
    `proven            ${fmt(s.proven)}`,
    nDel > 0 ? `delete paths      ${nDel} shown of ${fmt(allFound)} found (${unlinked.length} with no linked test, ${linkedDeletes.length} linked, ${provenDeletes.length} proven)` : "delete paths      none found",
    "",
    "fingerprints",
    `  repository snapshot  ${prov.identity.repository_snapshot}`,
    `  analysis             ${prov.identity.analysis_fingerprint}`,
    `  ranking              ${prov.identity.ranking_fingerprint}`,
    `  run                  ${prov.identity.run_fingerprint}`,
    "",
    `reproduce         ${RUN_COMMAND}`,
    ""
  ].join("\n");
  const payload = JSON.stringify({ receipt: JSON.stringify(receipt, null, 2), logs: runRecord }).replace(/</g, "\\u003c");

  const repoCell = input.repoWeb ? `<a href="${esc(input.repoWeb.base)}" target="_blank" rel="noopener noreferrer">${esc(repoName)}</a>` : esc(repoName);
  const commitCell = commit ? (input.repoWeb ? `<a class="mono" href="${esc(`${input.repoWeb.base}/${input.repoWeb.host === "gitlab" ? "-/" : ""}commit/${commit}`)}" target="_blank" rel="noopener noreferrer">${esc(commit)}</a>` : `<span class="mono">${esc(commit)}</span>`) : "Not a git checkout";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Test-evidence summary · ${esc(repoName)}${short ? ` ${esc(short)}` : ""}</title>
<style>${SHORT_REPORT_CSS}</style>
</head>
<body>
<div class="bar"><div class="bar-in"><div class="brand"><span class="dot" aria-hidden="true"></span> OrangePro <span class="muted">· Test-evidence summary</span></div><a class="btn" href="${esc(input.detailedHref)}">Open the detailed report</a></div></div>
<div class="doc">
<main class="sheet">
  <header>
    <p class="kicker">Test-evidence summary</p>
    <h1>${esc(headline)}</h1>
    <p class="lede">OrangePro mapped this repository&#39;s code against its ${fmt(tests)} test files. It linked each ${esc(nounInfo.singular)} to the tests that call it, then ranked what is left by how much code depends on it, how often it changes, and what it can break.${
      s.proven > 0 ? ` It also checked ${fmt(s.proven)} of the project&#39;s tests by breaking the code on purpose and confirming the test fails.` : ""
    }</p>
    <dl class="meta">
      <dt>Repository</dt><dd>${repoCell}</dd>
      <dt>Commit</dt><dd>${commitCell}</dd>
      <dt>Scope</dt><dd>${excluded.length ? `Excluded by configuration: <span class="mono">${esc(excluded.join(", "))}</span>` : "Whole repository"}</dd>
      <dt>Change history</dt><dd>${esc(churnText)}</dd>
      <dt>Analysed</dt><dd>${esc(data.scanned)} with OrangePro ${esc(prov.toolVersion)} (${esc(prov.identity.analyzer_version)}). No AI model was used for scoring.</dd>
    </dl>
    <p class="notice"><strong>How to read this.</strong> &ldquo;Linked to a test&rdquo; means a test calls the function directly and the call can be traced to that exact function. Tests that only check mocks are not counted, so these numbers are a conservative floor, not a coverage percentage.</p>
  </header>

  <section class="verdict" aria-label="Status">
    <div class="stat"><p class="k">${esc(nounInfo.title)}</p><p class="v">${fmt(s.total)}</p><p class="d">Against ${fmt(tests)} test files</p></div>
    <div class="stat"><p class="k">Linked to a test</p><p class="v">${fmt(s.associated)}</p><p class="d">About ${pct.toFixed(0)}%, a conservative floor</p></div>
    <div class="stat"><p class="k">Dynamically proven</p><p class="v">${fmt(s.proven)}</p><p class="d">Test fails when the code breaks</p></div>
    ${
      nDel > 0
        ? `<div class="stat"><p class="k">Delete paths with no linked test</p><p class="v">${unlinked.length} of ${nDel}</p><p class="d">${capped ? `Top ${nDel} of ${fmt(allFound)} found; section 01` : "Listed in section 01"}</p></div>`
        : `<div class="stat"><p class="k">No test found</p><p class="v">${fmt(s.none)}</p><p class="d">No test refers to them</p></div>`
    }
  </section>

  <section class="block" aria-labelledby="n0">
    <h2 id="n0">Where to start</h2>
    <ol class="actions">
      ${actions.join("\n      ")}
    </ol>
  </section>

${delSection}
${rankedSection}
${proofSection}
${fbPrompt}
  <section class="block" aria-labelledby="n4">
    <h2 id="n4"><span class="n">04</span> Still open</h2>
    <ul class="open">
      ${open.map((o) => `<li>${o}</li>`).join("\n      ")}
    </ul>
    <div class="limits">
      <div><h3>What this shows</h3><ul><li>Where the tests do and do not reach, one ${esc(nounInfo.singular)} at a time.</li><li>Which high-risk code has no test linked to it, in priority order.</li><li>For proven functions, that the existing test really fails when the code breaks.</li></ul></div>
      <div><h3>What it does not show</h3><ul><li>That untested code is broken. A missing test is a gap, not a defect.</li><li>A line-coverage percentage. Tests that only check mocks are not counted.</li><li>That the code is secure or insecure. This is a test-evidence map, not a security audit.</li></ul></div>
    </div>
  </section>

  <section class="block" aria-labelledby="n5">
    <h2 id="n5"><span class="n">05</span> What ran, and who did each step</h2>
    <ol class="steps">
      ${steps
        .map(
          ([what, who, result], i) =>
            `<li><span class="l"><span class="tick">${TICK}</span><span><span class="mono muted small">${i + 1}</span> ${esc(what)}<span class="how">${who}</span></span></span><span class="r">${esc(result)}</span></li>`
        )
        .join("\n      ")}
    </ol>
  </section>

  <section class="block" aria-labelledby="n6">
    <h2 id="n6"><span class="n">06</span> What you get back</h2>
    <div class="files">
      <a class="file" href="${esc(input.detailedHref)}"><span class="fileic">&lt;/&gt;</span><span><span class="fn mono">${esc(input.detailedHref)}</span><span class="fd">The detailed interactive report: every ${esc(nounInfo.singular)}, flows, ranking and settings.</span></span></a>
      <button type="button" class="file" data-download="receipt"><span class="fileic">{ }</span><span><span class="fn mono">evidence-summary.json ${DL}</span><span class="fd">Commit, scope, counts, delete paths, ranking and proofs.</span></span></button>
      <button type="button" class="file" data-download="logs"><span class="fileic">&gt;_</span><span><span class="fn mono">orangepro-run.txt ${DL}</span><span class="fd">Settings, counts and fingerprints for this run.</span></span></button>
    </div>
    <p class="sub">Run it yourself from the repository root: <code>${esc(RUN_COMMAND)}</code></p>
    <p class="sub">This is evidence for deciding where to add tests first. It is not a certification.</p>
  </section>
</main>
<p class="foot">Generated by OrangePro ${esc(prov.toolVersion)} from ${esc(repoName)}${short ? ` at ${esc(short)}` : ""}, ${esc(data.scanned)}${fb ? ` · <a href="${esc(fb.general)}" target="_blank" rel="noopener">Give feedback</a>` : ""} · <a href="https://orangepro.ai" target="_blank" rel="noopener noreferrer">orangepro.ai</a></p>
</div>
<script>
(function () {
  var DATA = ${payload};
  function save(name, body, type) {
    var url = URL.createObjectURL(new Blob([body], { type: type }));
    var a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  document.querySelector('[data-download="receipt"]').addEventListener("click", function () { save("evidence-summary.json", DATA.receipt, "application/json"); });
  document.querySelector('[data-download="logs"]').addEventListener("click", function () { save("orangepro-run.txt", DATA.logs, "text/plain"); });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a.fbwrong");
    if (!a) return;
    var cell = a.parentNode;
    if (cell.querySelector(".fbnote")) return;
    var note = document.createElement("span");
    note.className = "fbnote";
    note.textContent = "Feedback form opened for \u201c" + a.getAttribute("data-finding") + "\u201d. Its name and code are not sent; mention them in your comment only if you want to.";
    cell.appendChild(note);
  });
  var inv = document.getElementById("fbinvite");
  if (inv) {
    try { if (localStorage.getItem("orangepro.feedback.invitations") === "off") inv.remove(); } catch (err) {}
    inv.addEventListener("click", function (e) {
      if (e.target.closest("a")) { inv.querySelector(".fbsub").textContent = "The form opened in a new tab. Nothing is sent until you press Submit there."; return; }
      if (e.target.closest("[data-fb-skip]")) {
        try { localStorage.setItem("orangepro.feedback.invitations", "off"); } catch (err) {}
        inv.innerHTML = '<p class="fbsub">Hidden in this browser. To stop it in every report, run <code>opro feedback off</code>. The footer link stays.</p>';
      }
    });
  }
})();
</script></body></html>
`;
}

const SHORT_REPORT_CSS = `
:root { --ink:#18181b; --muted:#6b6b73; --line:#e4e4e7; --bg:#f4f4f5; --card:#fff; --orange:#c2410c; --orange-bg:#fff7ed; --ok:#047857; --ok-bg:#ecfdf5; }
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.mono, code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
a { color:inherit; }
.bar { background:#18181b; color:#e4e4e7; }
.bar-in { max-width:960px; margin:0 auto; padding:10px 20px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.brand { display:flex; align-items:center; gap:10px; font-weight:600; font-size:14px; }
.dot { width:16px; height:16px; border-radius:50%; border:2px solid #e4e4e7; display:grid; place-items:center; }
.dot::after { content:""; width:6px; height:6px; border-radius:50%; background:#f97316; }
.bar .muted { color:#a1a1aa; }
.btn { display:inline-flex; align-items:center; gap:6px; border:1px solid #3f3f46; background:#27272a; color:#fafafa; border-radius:6px; padding:6px 10px; font:600 13px/1 inherit; text-decoration:none; }
.btn:hover { background:#3f3f46; }
.doc { max-width:960px; margin:0 auto; padding:24px 20px 56px; }
.sheet { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:28px; }
.kicker { margin:0; font:600 12px/1.4 ui-monospace, Menlo, monospace; letter-spacing:.08em; text-transform:uppercase; color:var(--orange); }
h1 { margin:8px 0 0; font-size:26px; line-height:1.25; }
h2 { margin:0; font-size:18px; display:flex; gap:10px; align-items:baseline; }
h2 .n { font:600 12px ui-monospace, Menlo, monospace; color:var(--orange); }
h3 { margin:8px 0 0; font-size:16px; }
.cardtitle { overflow-wrap:anywhere; font-size:15px; }
.lede { margin:10px 0 0; color:#3f3f46; max-width:720px; }
.meta { margin:18px 0 0; display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; font-size:13px; }
.meta dt { color:var(--muted); }
.meta dd { margin:0; overflow-wrap:anywhere; }
.notice { margin:18px 0 0; background:#fffbeb; border:1px solid #fcd34d; color:#78350f; border-radius:8px; padding:10px 14px; font-size:14px; }
.verdict { margin-top:20px; display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
.stat { border:1px solid var(--line); border-radius:8px; padding:14px; }
.stat .k { margin:0; font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.stat .v { margin:6px 0 0; font-size:17px; font-weight:700; line-height:1.3; }
.stat .d { margin:4px 0 0; font-size:13px; color:var(--muted); }
section.block { margin-top:32px; }
.sub { margin:6px 0 0; color:var(--muted); font-size:14px; }
.actions { margin:12px 0 0; padding-left:20px; display:grid; gap:10px; }
.actions li { padding-left:4px; line-height:1.55; min-width:0; overflow-wrap:anywhere; }
.steps { margin:14px 0 0; padding:0; list-style:none; border:1px solid var(--line); border-radius:8px; }
.steps li { display:flex; justify-content:space-between; gap:12px; padding:10px 14px; border-top:1px solid var(--line); font-size:14px; }
.steps li:first-child { border-top:0; }
.steps .l { display:flex; gap:10px; align-items:flex-start; }
.steps .how { display:block; font-size:12px; color:var(--muted); }
.tick { width:20px; height:20px; border-radius:50%; background:var(--ok-bg); color:var(--ok); display:grid; place-items:center; flex:none; margin-top:1px; }
.steps .r { color:var(--muted); text-align:right; }
.grid3 { margin-top:14px; display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
.grid2 { margin-top:14px; display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
.grid3 > *, .grid2 > *, .files > * { min-width:0; }
.card { border:1px solid var(--line); border-radius:8px; padding:14px; display:flex; flex-direction:column; }
.card-gap { border:2px solid #fb923c; background:var(--orange-bg); }
.prs { margin:8px 0 0; padding:0; list-style:none; font-size:13px; color:#3f3f46; flex:1; }
.prs li { margin-top:2px; overflow-wrap:anywhere; }
.row { display:flex; justify-content:space-between; gap:10px; }
.row.top { align-items:flex-start; }
.small { font-size:13px; } .tiny { font-size:12px; margin:2px 0 0; } .muted { color:var(--muted); }
.small.muted { margin:6px 0 0; }
.finding { margin:12px 0 0; }
.pill { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:3px 9px; font-size:12px; font-weight:700; white-space:nowrap; flex:none; }
.pill-ok { background:var(--ok-bg); color:var(--ok); }
.pill-gap { background:var(--orange); color:#fff; }
.pill-muted { background:#f4f4f5; color:#52525b; border:1px solid var(--line); }
.callout { margin-top:14px; border:2px solid #fb923c; border-radius:8px; padding:16px 18px; background:var(--orange-bg); }
.callout .big { margin:0; font-weight:700; font-size:16px; }
.callout p { margin:8px 0 0; font-size:14px; color:#3f3f46; }
.proof { display:flex; gap:10px; align-items:center; border:1px solid var(--line); border-radius:8px; padding:14px; }
.proof .ic { width:30px; height:30px; border-radius:50%; display:grid; place-items:center; flex:none; }
.proof p { margin:0; } .proof .t { font-weight:600; } .proof .s { font-size:13px; color:var(--muted); }
.faults { margin:14px 0 0; padding:0; list-style:none; display:grid; gap:10px; }
.fault { border:1px solid var(--line); border-radius:8px; padding:14px; }
.fault .row > div { min-width:0; }
.fault-title { margin:0; font-weight:600; overflow-wrap:anywhere; }
.fault p.mono { overflow-wrap:anywhere; }
.diff { margin:10px 0 6px; display:grid; grid-template-columns:max-content 1fr; gap:4px 10px; font-size:13px; }
.diff dt { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; padding-top:3px; }
.diff dd { margin:0; overflow-wrap:anywhere; }
.counts { margin:10px 0 0; font-size:13px; color:var(--muted); }
code { background:#f4f4f5; border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:12.5px; word-break:break-all; }
.limits { margin-top:14px; display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
.limits > div { border:1px solid var(--line); border-radius:8px; padding:14px; }
.limits h3 { margin:0; font-size:14px; }
.limits ul, .open { margin:8px 0 0; padding-left:18px; font-size:14px; color:#3f3f46; }
.limits li, .open li { margin-top:4px; }
details.light { margin-top:10px; border:1px solid var(--line); border-radius:8px; background:#fff; }
details.light summary { cursor:pointer; padding:10px 14px; font-size:14px; font-weight:600; list-style:none; }
details.light summary::-webkit-details-marker { display:none; }
details.light summary::before { content:"\\203A"; display:inline-block; margin-right:8px; transition:transform .15s; }
details.light[open] summary::before { transform:rotate(90deg); }
details.light .legend { padding:0 14px; }
details.light .tblwrap { border:0; border-top:1px solid var(--line); border-radius:0; margin-top:10px; }
.legend { margin:12px 0 0; line-height:1.5; }
.tbl { width:100%; border-collapse:collapse; font-size:14px; }
.tbl th { text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); }
.tbl td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
.tbl tr:last-child td { border-bottom:0; }
.tblwrap { border:1px solid var(--line); border-radius:8px; overflow-x:auto; }
.fileline { display:block; margin-top:2px; word-break:break-all; }
a.code { color:inherit; text-decoration:underline; text-decoration-color:#d4d4d8; text-underline-offset:2px; overflow-wrap:anywhere; }
a.code:hover { text-decoration-color:currentColor; }
.tbl td .mono { overflow-wrap:anywhere; }
.files { margin-top:14px; display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
.file { display:flex; gap:12px; align-items:flex-start; text-align:left; border:1px solid var(--line); background:#fff; border-radius:8px; padding:14px; cursor:pointer; font:inherit; color:inherit; width:100%; text-decoration:none; }
.file:hover { border-color:#fb923c; }
.file .fn { display:flex; align-items:center; gap:6px; font-weight:600; font-size:12px; overflow-wrap:anywhere; }
.file .fd { display:block; margin-top:2px; font-size:13px; color:var(--muted); }
.fileic { width:28px; height:28px; border-radius:6px; background:var(--orange-bg); color:var(--orange); display:grid; place-items:center; flex:none; font:700 11px ui-monospace, Menlo, monospace; }
.foot { margin-top:16px; font-size:12px; color:var(--muted); text-align:center; }
.fbwrong { font-size:11px; color:var(--muted); white-space:nowrap; margin-left:6px; }
.fbnote { display:block; margin-top:4px; font-size:11px; color:var(--muted); }
.fbinvite { margin-top:28px; border:1px solid #fdba74; background:var(--orange-bg); border-radius:8px; padding:12px 16px; display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.fbq { font-weight:700; font-size:15px; }
.fbans { display:flex; gap:6px; flex-wrap:wrap; }
.fbans a { border:1px solid #fdba74; background:#fff; border-radius:6px; padding:4px 12px; font-weight:600; font-size:13px; text-decoration:none; }
.fbskip { margin-left:auto; border:0; background:none; color:var(--muted); font-size:12px; text-decoration:underline; cursor:pointer; }
.fbsub { flex-basis:100%; margin:0; font-size:12px; color:var(--muted); }
.fbblocked { margin-top:28px; border:1px solid var(--line); background:var(--card); border-radius:8px; padding:10px 14px; font-size:14px; }
.fbblocked a { color:var(--orange); font-weight:700; }
@media (max-width:760px) {
  .sheet { padding:18px; }
  h1 { font-size:22px; }
  .verdict { grid-template-columns:repeat(2,1fr); }
  .grid3, .grid2, .limits, .files { grid-template-columns:1fr; }
  .steps li { flex-direction:column; gap:2px; }
  .steps .r { text-align:left; padding-left:30px; }
  .tbl { font-size:13px; }
}
@media (max-width:640px) {
  .tbl thead { display:none; }
  .tbl, .tbl tbody, .tbl tr, .tbl td { display:block; width:auto !important; }
  .tbl tr { padding:10px 2px; border-bottom:1px solid var(--line); }
  .tbl tr:last-child { border-bottom:0; }
  .tbl td { border:0; padding:3px 10px; }
}
@media print {
  .bar .btn, details.light { display:none !important; }
  body { background:#fff; } .sheet { border:0; padding:0; }
}
`;
