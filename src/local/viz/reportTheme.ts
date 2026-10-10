import type { Evidence, Verb } from "./worklist.js";

/**
 * Shared look of the summary and the detailed report (R14 §6): one palette, one
 * set of chips, the same five evidence colors and four verb colors everywhere.
 * Everything is inline; no fonts, images or scripts load from the network.
 */

export const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const fmt = (n: number): string => n.toLocaleString("en-US");

/** Escaped name with a line-break opportunity after each dot and slash. */
export const breakable = (label: string): string => esc(label).replace(/([./])/g, "$1<wbr>");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Oct 2026" from an ISO timestamp, in UTC, so the same data renders the same bytes. */
export function dateText(iso: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "9 Oct 2026, 03:00 UTC". */
export function dateTimeText(iso: string | undefined): string {
  const t = /T(\d{2}):(\d{2})/.exec(iso ?? "");
  return t ? `${dateText(iso)}, ${t[1]}:${t[2]} UTC` : dateText(iso);
}

export interface Swatch { fg: string; bg: string; fill: string }

export const EVIDENCE_COLOR: Record<Evidence, Swatch> = {
  proven: { fg: "#17613A", bg: "#E3F1E8", fill: "#17613A" },
  runtime: { fg: "#0F6B63", bg: "#DCF1EE", fill: "#2A9D8F" },
  linked: { fg: "#2B57B5", bg: "#E4ECFB", fill: "#3B6FD8" },
  unconfirmed: { fg: "#7A4F00", bg: "#FBF0D3", fill: "#E3B341" },
  none: { fg: "#A8331A", bg: "#FBE6DF", fill: "#D9603B" }
};

/** Verbs reuse the evidence colors they summarise: Done green, Prove blue, Check amber, Write red. */
export const VERB_COLOR: Record<Verb, Swatch> = {
  done: EVIDENCE_COLOR.proven,
  prove: EVIDENCE_COLOR.linked,
  check: EVIDENCE_COLOR.unconfirmed,
  write: EVIDENCE_COLOR.none
};

export const BRAND_SVG =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="#E0561B" stroke-width="2.5"></circle><circle cx="11" cy="11" r="4" fill="#E0561B"></circle></svg>';

export const ARROW_SVG =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8M8 4l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

export const RUN_COMMAND = "npx -y @orangepro/orangepro-mcp start .";

/** CSS both pages share: tokens, chips, buttons, code. */
export function baseCss(): string {
  const chips = [
    ...(Object.keys(VERB_COLOR) as Verb[]).map((v) => `.v-${v}{background:${VERB_COLOR[v].bg};color:${VERB_COLOR[v].fg}}.v-${v} .dot,.dot.v-${v}{background:${VERB_COLOR[v].fill}}`),
    ...(Object.keys(EVIDENCE_COLOR) as Evidence[]).map((e) => `.e-${e}{background:${EVIDENCE_COLOR[e].bg};color:${EVIDENCE_COLOR[e].fg}}.e-${e} .dot,.dot.e-${e}{background:${EVIDENCE_COLOR[e].fill}}`)
  ].join("\n");
  return `
:root{--ink:#1C1B19;--ink2:#3A3935;--muted:#55534E;--faint:#6B6862;--line:#E7E4DD;--line2:#F0EEE8;--bg:#F7F6F2;--card:#FFFFFF;--soft:#F3F1EC;--accent:#E0561B;--accent-ink:#B4471A;--sel:#FFF6EE}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:var(--ink)}a:hover{color:var(--accent-ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1,h2,h3{letter-spacing:-.01em}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:13px}.tiny{font-size:12px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;line-height:1.6}
.dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.tag{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:6px;background:var(--soft);color:var(--ink2);white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 14px;border:1px solid #CFCBC2;border-radius:8px;background:var(--card);color:var(--ink);font:600 14px/1.2 inherit;text-decoration:none;cursor:pointer}
.btn:hover{border-color:var(--ink);color:var(--ink)}
.btn.primary{background:var(--ink);border-color:var(--ink);color:#fff}
.btn.primary:hover{background:#000;color:#fff}
code{background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:12.5px}
pre{margin:0;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.cmd{display:block;font-size:12px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:8px 10px;overflow-wrap:anywhere}
.top{background:var(--card);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.brand b{font-weight:700}
.since{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 14px;font-size:14px;display:flex;gap:10px;align-items:flex-start}
.since::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none;margin-top:7px}
.since.same::before{background:#17613A}
.fbwrong{font-size:12px;color:var(--faint)}
.fbnote{display:block;margin-top:4px;font-size:12px;color:var(--faint)}
.fbinvite{border:1px solid #F3C4A8;background:#FFF6EE;border-radius:10px;padding:12px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.fbq{font-weight:700}
.fbans{display:flex;gap:6px;flex-wrap:wrap}
.fbans a{border:1px solid #F3C4A8;background:#fff;border-radius:8px;min-height:36px;display:inline-flex;align-items:center;padding:0 14px;font-weight:600;font-size:14px;text-decoration:none}
.fbskip{margin-left:auto;border:0;background:none;color:var(--faint);font-size:12px;text-decoration:underline;cursor:pointer}
.fbsub{flex-basis:100%;margin:0;font-size:12px;color:var(--faint)}
.fbblocked{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 14px;font-size:14px}
.fbblocked a{color:var(--accent-ink);font-weight:700}
${chips}
@media print{.btn,.fbinvite,.fbskip{display:none!important}body{background:#fff}}
`;
}

/** The feedback invitation, shown after the findings; nothing is sent from the page. */
export function feedbackPromptHtml(fb: import("../feedback.js").ReportFeedback | undefined): string {
  if (!fb) return "";
  if (fb.prompt.kind === "blocked") {
    const a = fb.prompt.answers[0];
    return `<div class="fbblocked">${esc(fb.prompt.question)} <a href="${esc(a?.url ?? fb.general)}" target="_blank" rel="noopener">${esc(a?.label ?? "Tell us")} &rarr;</a></div>`;
  }
  if (!fb.prompt.expanded) return "";
  return `<div class="fbinvite" id="fbinvite"><span class="fbq">${esc(fb.prompt.question)}</span><span class="fbans">${fb.prompt.answers
    .map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label)}</a>`)
    .join("")}</span><button type="button" class="fbskip" data-fb-skip>Don&rsquo;t ask again</button><p class="fbsub">Opens a short form in a new tab. Nothing is sent unless you press Submit there. Anonymous unless you add an email.</p></div>`;
}

/** Script for the invitation's "Don't ask again" and the "This looks wrong" note. */
export const FEEDBACK_SCRIPT = `
document.addEventListener("click", function (e) {
  var a = e.target.closest && e.target.closest("a.fbwrong");
  if (!a) return;
  var cell = a.parentNode;
  if (cell.querySelector(".fbnote")) return;
  var note = document.createElement("span");
  note.className = "fbnote";
  note.textContent = "Feedback form opened for \\u201c" + a.getAttribute("data-finding") + "\\u201d. Its name and code are not sent; mention them in your comment only if you want to.";
  cell.appendChild(note);
});
(function () {
  var inv = document.getElementById("fbinvite");
  if (!inv) return;
  try { if (localStorage.getItem("orangepro.feedback.invitations") === "off") inv.remove(); } catch (err) {}
  inv.addEventListener("click", function (e) {
    if (e.target.closest("a")) { inv.querySelector(".fbsub").textContent = "The form opened in a new tab. Nothing is sent until you press Submit there."; return; }
    if (e.target.closest("[data-fb-skip]")) {
      try { localStorage.setItem("orangepro.feedback.invitations", "off"); } catch (err) {}
      inv.innerHTML = '<p class="fbsub">Hidden in this browser. To stop it in every report, run <code>opro feedback off</code>. The footer link stays.</p>';
    }
  });
})();
`;
