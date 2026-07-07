// AUTO-GENERATED from private/design/behavior-report-vision.html — do not edit by hand.
// Regenerate: node scripts/gen-behavior-report-renderer.mjs
import type { BehaviorReportData } from "./behaviorReportData.js";

const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>OrangePro · Behavior Coverage</title>
<style>
:root {
  --bg:#0d1117; --s1:#161b22; --s2:#1c2128; --s3:#21262d;
  --bd:#2b313a; --bd2:#383f49;
  --ink:#e6edf3; --ink2:#c9d3df; --muted:#9aa4b1; --faint:#6e7681;
  --green:#3fb950; --gbg:rgba(63,185,80,.13); --gbd:rgba(63,185,80,.38);
  --amber:#e3b341; --abg:rgba(227,179,65,.13); --abd:rgba(227,179,65,.38);
  --red:#f85149;   --rbg:rgba(248,81,73,.12);  --rbd:rgba(248,81,73,.35);
  --blue:#58a6ff;  --bbg:rgba(88,166,255,.12); --bbd:rgba(88,166,255,.35);
  --orange:#f0883e;--obg:rgba(240,136,62,.12); --obd:rgba(240,136,62,.40);
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --ease:cubic-bezier(.22,1,.36,1);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none}
::-webkit-scrollbar{width:7px;height:7px}
::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px;border:2px solid var(--bg)}

.wrap{max-width:1100px;margin:0 auto;padding:24px 24px 80px}

/* HEADER */
.hdr{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid var(--bd)}
.hdr-left{display:flex;align-items:center;gap:10px}
.logo{width:28px;height:28px;border-radius:6px;background:linear-gradient(145deg,#f0883e,#c95c1a);display:grid;place-items:center;font-weight:800;font-size:13px;color:#1a0a02;flex-shrink:0}
.hdr-name{font-size:15px;font-weight:650;letter-spacing:-.01em}
.hdr-right{font-size:11.5px;color:var(--muted);display:flex;gap:10px;align-items:center}
.hdr-tag{background:var(--s2);border:1px solid var(--bd);border-radius:4px;padding:2px 7px;font-family:var(--mono);font-size:10.5px;color:var(--ink2)}

/* KPI STRIP */
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:16px 0 0}
.kpi{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:13px 14px;position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.4;background:radial-gradient(90px 70px at 100% 0%,var(--kw,transparent),transparent 70%)}
.kpi-lbl{font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;position:relative}
.kpi-num{font-size:24px;font-weight:750;letter-spacing:-.02em;margin:5px 0 1px;line-height:1;font-variant-numeric:tabular-nums;position:relative}
.kpi-sub{font-size:10.5px;color:var(--faint);position:relative}
.kpi[data-t="total"]{--kw:rgba(88,166,255,.08)} .kpi[data-t="total"] .kpi-num{color:var(--ink)}
.kpi[data-t="proven"]{--kw:var(--gbg)} .kpi[data-t="proven"] .kpi-num{color:var(--green)}
.kpi[data-t="signal"]{--kw:var(--abg)} .kpi[data-t="signal"] .kpi-num{color:var(--amber)}
.kpi[data-t="reach"]{--kw:var(--bbg)} .kpi[data-t="reach"] .kpi-num{color:var(--blue)}
.kpi[data-t="nosig"]{--kw:var(--rbg)} .kpi[data-t="nosig"] .kpi-num{color:var(--red)}

/* TABS */
nav.tabs{display:flex;gap:2px;margin:18px 0 0;border-bottom:1px solid var(--bd)}
.tab{appearance:none;background:none;border:0;color:var(--muted);font:inherit;font-size:13px;font-weight:550;padding:9px 13px 10px;cursor:pointer;position:relative;display:inline-flex;align-items:center;gap:5px;border-radius:5px 5px 0 0;transition:color .12s}
.tab:hover{color:var(--ink2)}
.tab[aria-selected="true"]{color:var(--ink)}
.tab[aria-selected="true"]::after{content:"";position:absolute;left:5px;right:5px;bottom:-1px;height:2px;background:var(--orange);border-radius:2px 2px 0 0}
.tab .tc{font-size:10px;font-weight:600;color:var(--muted);background:var(--s3);padding:1px 5px;border-radius:20px;font-variant-numeric:tabular-nums}

/* PANELS */
.panel{display:none;padding-top:16px}
.panel.active{display:block;animation:fi .18s var(--ease)}
@keyframes fi{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}

/* SECTION BRIDGE — one-liner that connects developer vocab to OrangePro concepts */
.bridge{font-size:12.5px;color:var(--muted);margin-bottom:14px;padding:0;line-height:1.6}
.bridge b{color:var(--ink2);font-weight:600}
.bridge code{font-family:var(--mono);font-size:11px;background:var(--s2);border:1px solid var(--bd);border-radius:3px;padding:1px 4px;color:var(--ink2)}

/* CODEBASE */
.cols2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:16px}
.card-lbl{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--orange);font-weight:650;margin:0 0 8px}
.fw-pill{display:inline-block;background:var(--obg);border:1px solid var(--obd);color:#f6b079;border-radius:5px;padding:3px 9px;font-size:12px;font-family:var(--mono)}
.bignum{font-size:22px;font-weight:750;font-variant-numeric:tabular-nums}
.split2{display:flex;gap:16px;margin-top:4px}
.split2 .v{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.split2 .vb{color:var(--blue)} .split2 .vp{color:#bc8cff}
.split2 .k{font-size:10.5px;color:var(--muted)}
.svc-list{margin-top:6px;max-height:200px;overflow-y:auto}
.svc{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bd);font-size:12px}
.svc:last-child{border-bottom:0}
.svc .nm{font-family:var(--mono);color:var(--ink2)}
.svc .ct{color:var(--muted);font-variant-numeric:tabular-nums}

/* BEHAVIORS — card grid with tier glow */
.beh-layout{display:grid;grid-template-columns:160px 1fr;gap:12px}
.beh-side{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:5px;height:max-content;position:sticky;top:12px}
.beh-side-lbl{font-size:9.5px;color:var(--faint);font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:5px 8px 3px}
.beh-search{width:100%;margin:2px 0 8px;padding:7px 9px;font:inherit;font-size:12px;color:var(--ink);background:var(--s);border:1px solid var(--bd);border-radius:6px;outline:none}
.beh-search:focus{border-color:var(--amber)}
.grp{width:100%;text-align:left;appearance:none;border:0;background:none;font:inherit;font-size:12px;color:var(--muted);padding:6px 8px;border-radius:5px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background .1s,color .1s}
.grp:hover{background:var(--s2);color:var(--ink2)}
.grp[aria-pressed="true"]{background:var(--obg);color:var(--orange);font-weight:600}
.grp .gc{font-size:10px;opacity:.8}
.beh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:9px}
.beh-card{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:12px 14px;cursor:pointer;transition:border-color .12s,transform .12s;position:relative;overflow:hidden}
.beh-card::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .15s;background:radial-gradient(120px 90px at 0% 100%,var(--gw,transparent),transparent 70%)}
.beh-card:hover{transform:translateY(-1px);border-color:var(--bd2)}
.beh-card:hover::before{opacity:1}
.beh-card[data-t="proven"]{--gw:var(--gbg);border-color:rgba(63,185,80,.22)}
.beh-card[data-t="proven"]:hover{border-color:var(--gbd)}
.beh-card[data-t="assoc"]{--gw:var(--abg)}
.beh-card[data-t="assoc"]:hover{border-color:var(--abd)}
.beh-card[data-t="reach"]{--gw:var(--bbg)}
.beh-card[data-t="reach"]:hover{border-color:var(--bbd)}
.beh-card[data-t="nosig"]{--gw:var(--rbg)}
.beh-card[data-t="nosig"]:hover{border-color:var(--rbd)}
.bc-top{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
.bc-sig{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink);word-break:break-all;flex:1}
.bc-badge{flex-shrink:0}
.bc-file{font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-bar{height:3px;border-radius:0 0 9px 9px;position:absolute;bottom:0;left:0;right:0}
.beh-card[data-t="proven"] .bc-bar{background:var(--green)}
.beh-card[data-t="assoc"] .bc-bar{background:var(--amber)}
.beh-card[data-t="reach"] .bc-bar{background:var(--blue)}
.beh-card[data-t="nosig"] .bc-bar{background:var(--red)}

/* BADGES */
.badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:2px 6px;border-radius:20px;border:1px solid transparent}
.badge .d{width:4px;height:4px;border-radius:50%}
.b-proven{color:var(--green);background:var(--gbg);border-color:var(--gbd)} .b-proven .d{background:var(--green)}
.b-signal{color:var(--amber);background:var(--abg);border-color:var(--abd)} .b-signal .d{background:var(--amber)}
.b-reach{color:var(--blue);background:var(--bbg);border-color:var(--bbd)} .b-reach .d{background:var(--blue)}
.b-nosig{color:var(--red);background:var(--rbg);border-color:var(--rbd)} .b-nosig .d{background:var(--red)}
.b-risk{color:var(--red);background:var(--rbg);border-color:var(--rbd)} .b-risk .d{background:var(--red)}
.b-info{color:var(--muted);background:var(--s3);border-color:var(--bd2)}

/* FLOWS */
.flow-card{background:var(--s1);border:1px solid var(--bd);border-radius:9px;margin-bottom:12px;overflow:hidden;transition:border-color .12s}
.flow-card:hover{border-color:var(--bd2)}
.flow-head{padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--bd)}
.flow-head h3{font-size:13.5px;font-weight:650;letter-spacing:-.01em;margin:0}
.flow-tags{display:flex;gap:5px;flex-wrap:wrap}
/* horizontal chain */
.flow-chain{padding:14px 16px;display:flex;align-items:center;gap:0;overflow-x:auto;min-height:60px}
.flow-chain::-webkit-scrollbar{height:3px}
.fn{display:flex;flex-direction:column;align-items:center;flex-shrink:0;min-width:80px;max-width:150px}
.fn-box{background:var(--s2);border:1px solid var(--bd2);border-radius:7px;padding:6px 10px;font-family:var(--mono);font-size:11px;color:var(--ink2);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:145px;width:100%;transition:border-color .15s}
.fn-box.fnb-entry{background:var(--bbg);border-color:var(--bbd);color:var(--blue)}
.fn-box.fnb-proven{background:var(--gbg);border-color:var(--gbd);color:var(--green);animation:pulse 2.4s ease infinite}
.fn-box.fnb-assoc{background:var(--abg);border-color:var(--abd);color:var(--amber)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 var(--gbg)}50%{box-shadow:0 0 0 4px transparent}}
.fe{flex:1;min-width:20px;max-width:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.fe-line{width:100%;height:2px}
.fe-line.fel-hard{background:linear-gradient(90deg,var(--blue),rgba(88,166,255,.4))}
.fe-line.fel-fw{background:repeating-linear-gradient(90deg,var(--amber) 0,var(--amber) 3px,transparent 3px,transparent 6px)}
/* vertical chain for 5+ nodes */
.flow-chain.fc-vert{flex-direction:column;align-items:flex-start;gap:0;overflow-x:visible;padding:16px 20px}
.fc-vert .fn{flex-direction:row;align-items:center;min-width:0;max-width:none;gap:10px}
.fc-vert .fn-box{text-align:left;white-space:normal;max-width:300px;width:auto}
.fc-vert .fe{min-width:0;max-width:none;width:auto;margin-left:18px;padding:3px 0}
.fc-vert .fe-line{width:2px;height:20px;min-width:2px}
.fc-vert .fe-line.fel-hard{background:linear-gradient(180deg,var(--blue),rgba(88,166,255,.4))}
.fc-vert .fe-line.fel-fw{background:repeating-linear-gradient(180deg,var(--amber) 0,var(--amber) 3px,transparent 3px,transparent 6px)}
/* AI flows */
.ai-sec{margin-top:20px;padding-top:14px;border-top:1px dashed var(--bd2)}
.ai-lbl{font-size:11px;color:var(--faint);font-weight:600;margin-bottom:10px}
.ai-card{background:var(--s1);border:1px dashed var(--bd2);border-radius:9px;margin-bottom:10px;overflow:hidden}
.ai-card .fn-box{border-style:dashed}
.ai-card .fe-line{opacity:.45}

/* RISKS */
.risk-card{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:14px 16px;margin-bottom:10px}
.risk-tools{display:flex;align-items:center;gap:8px;margin:0 0 12px;flex-wrap:wrap}
.risk-filter{appearance:none;border:1px solid var(--bd);background:var(--s1);color:var(--muted);border-radius:20px;padding:5px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.risk-filter:hover{border-color:var(--bd2);color:var(--ink2)}
.risk-filter[aria-pressed="true"]{border-color:var(--orange);background:var(--obg);color:var(--orange)}
.risk-rank{font-size:10px;color:var(--orange);font-weight:700;margin-bottom:3px}
.risk-ep{font-family:var(--mono);font-size:13px;margin:0 0 6px}
.risk-ep .v{color:var(--green);font-weight:700}
.risk-desc{font-size:12px;color:var(--muted);margin:0 0 8px;max-width:72ch}
.risk-tags{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.todo{background:var(--gbg);border:1px solid var(--gbd);border-radius:6px;padding:8px 11px;font-size:11.5px;color:var(--ink2)}

/* DRILL MODAL */
.drill-overlay{display:none;position:fixed;inset:0;z-index:600;padding:24px;background:rgba(1,4,9,.7);justify-content:center;align-items:center}
.drill-overlay.open{display:flex;animation:fi .14s var(--ease)}
.drill-card{position:relative;background:var(--s1);border:1px solid var(--bd2);border-radius:11px;padding:18px 20px;max-width:480px;width:100%;max-height:75vh;overflow-y:auto;box-shadow:0 16px 50px rgba(0,0,0,.5)}
.drill-close{position:absolute;top:8px;right:10px;appearance:none;background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer;padding:4px 7px;border-radius:4px}
.drill-close:hover{color:var(--ink);background:var(--s2)}
.drill-title{font-family:var(--mono);font-size:13px;font-weight:650;margin:0 28px 12px 0;word-break:break-all}
.drill-row{margin-bottom:10px}
.drill-row:last-child{margin-bottom:0}
.drill-row h4{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--orange);font-weight:650;margin:0 0 4px}
.drill-row p{margin:0;font-size:12px;color:var(--muted)}
.drill-row .mono{font-family:var(--mono);font-size:11px;color:var(--blue)}
.abox{font-size:12px;color:var(--ink2);border-radius:6px;padding:8px 10px}
.abox code{font-family:var(--mono);font-size:10.5px;background:rgba(0,0,0,.3);border-radius:3px;padding:1px 4px}
.abox.ax-proven{background:var(--gbg);border:1px solid var(--gbd)}
.abox.ax-signal{background:var(--abg);border:1px solid var(--abd)}
.abox.ax-reach{background:var(--bbg);border:1px solid var(--bbd)}
.abox.ax-nosig{background:var(--rbg);border:1px solid var(--rbd)}

/* GENERATED TEST SAMPLES */
.gen-tests{margin-top:10px;border-top:1px solid var(--bd);padding-top:10px}
.gen-tests-lbl{font-size:10px;color:var(--orange);font-weight:650;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;gap:5px}
.gen-tests-lbl::before{content:"";width:12px;height:12px;background:var(--obg);border:1px solid var(--obd);border-radius:3px;display:inline-block}
.gen-test{background:var(--s2);border:1px solid var(--bd);border-radius:7px;margin-bottom:6px;overflow:hidden}
.gen-test-head{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;cursor:pointer;gap:8px}
.gen-test-head:hover{background:var(--s3)}
.gen-test-name{font-family:var(--mono);font-size:11.5px;color:var(--ink2);font-weight:600}
.gen-test-assert{font-size:10.5px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gen-test-toggle{color:var(--faint);font-size:10px;flex-shrink:0;transition:transform .15s}
.gen-test.open .gen-test-toggle{transform:rotate(180deg)}
.gen-test-body{display:none;padding:0 11px 10px;font-family:var(--mono);font-size:11px;line-height:1.6;color:var(--ink2);white-space:pre-wrap;border-top:1px solid var(--bd)}
.gen-test.open .gen-test-body{display:block}
/* TESTING CATEGORIES STRIP */
.cat-strip{margin-top:10px;padding-top:9px;border-top:1px solid var(--bd)}
.cat-strip-lbl{font-size:9.5px;color:var(--muted);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
.cat-pills{display:flex;flex-wrap:wrap;gap:5px}
.cat-pill{font-size:10px;padding:3px 8px;border-radius:4px;font-weight:600;letter-spacing:.01em;display:inline-flex;align-items:center;gap:4px}
.cat-pill.cp-shown{background:var(--gbg);border:1px solid var(--gbd);color:var(--green)}
.cat-pill.cp-locked{background:transparent;border:1px dashed var(--bd2);color:var(--faint)}
.cat-pill.cp-locked::after{content:"\\1F512";font-size:8px}
/* PAYWALL CTA */
.paywall{background:linear-gradient(135deg,rgba(240,136,62,.08),rgba(240,136,62,.02));border:1px dashed var(--obd);border-radius:9px;padding:14px 16px;margin-top:14px;text-align:center}
.paywall-num{font-size:18px;font-weight:750;color:var(--orange);font-variant-numeric:tabular-nums}
.paywall-txt{font-size:12px;color:var(--muted);margin:4px 0 10px}
.paywall-btn{display:inline-flex;align-items:center;gap:6px;background:var(--orange);color:#1a0a02;font-size:12px;font-weight:700;padding:7px 14px;border-radius:6px;text-decoration:none;transition:opacity .12s}
.paywall-btn:hover{opacity:.85}

@media(max-width:800px){
  .kpis{grid-template-columns:repeat(3,1fr)}
  .cols2,.beh-layout{grid-template-columns:1fr}
  .beh-side{position:static}
}
@media(max-width:500px){.kpis{grid-template-columns:repeat(2,1fr)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important}}
</style>
</head>
<body>
<div class="wrap">

<header class="hdr">
  <div class="hdr-left">
    <div class="logo">O</div>
    <span class="hdr-name" id="repo-name">—</span>
  </div>
  <div class="hdr-right">
    <span class="hdr-tag" id="framework">—</span>
    <span id="scan-date">—</span>
  </div>
</header>

<section class="kpis" id="kpis"></section>

<nav class="tabs" role="tablist">
  <button class="tab" role="tab" aria-selected="true" data-tab="codebase">Your Code</button>
  <button class="tab" role="tab" aria-selected="false" data-tab="behaviors">Behaviors <span class="tc" id="t-beh">—</span></button>
  <button class="tab" role="tab" aria-selected="false" data-tab="flows">Flows <span class="tc" id="t-flow">—</span></button>
  <button class="tab" role="tab" aria-selected="false" data-tab="risks">Risks <span class="tc" id="t-risk">—</span></button>
</nav>

<!-- TAB 1: YOUR CODE — familiar territory -->
<section class="panel active" id="panel-codebase" role="tabpanel">
  <p class="bridge">We scanned your repo and found <b id="br-methods">—</b> public methods across <b id="br-services">—</b> services, with <b id="br-tests">—</b> test files. Here's what we're working with.</p>
  <div class="cols2">
    <div class="card">
      <p class="card-lbl">Framework</p>
      <span class="fw-pill" id="fw-pill">—</span>
      <p class="card-lbl" style="margin-top:14px">Services (by exported method count)</p>
      <div class="svc-list" id="svc-list"></div>
    </div>
    <div class="card">
      <p class="card-lbl">Test files found</p>
      <div class="bignum" id="test-total">—</div>
      <div class="split2">
        <div><div class="v vb" id="test-int">—</div><div class="k">Integration</div></div>
        <div><div class="v vp" id="test-unit">—</div><div class="k">Unit</div></div>
      </div>
    </div>
  </div>
</section>

<!-- TAB 2: BEHAVIORS — bridge from "methods" to "behaviors" -->
<section class="panel" id="panel-behaviors" role="tabpanel">
  <p class="bridge">Each card below is a <b>public method</b> in your code that has an observable outcome — we call it a <b>behavior</b>. The color tells you how well it's tested: <span style="color:var(--green)">green</span> = a test proves it breaks if you change it, <span style="color:var(--amber)">amber</span> = a test touches it but doesn't prove breakage, <span style="color:var(--red)">red</span> = nothing tests it.</p>
  <div class="beh-layout">
    <aside class="beh-side" id="beh-groups">
      <div class="beh-side-lbl">Search</div>
      <input id="beh-search" class="beh-search" type="search" placeholder="name or file…" aria-label="Search behaviors by name or file">
      <div class="beh-side-lbl">Evidence</div>
      <div id="tier-filter"></div>
      <div class="beh-side-lbl">Package</div>
    </aside>
    <div class="beh-grid" id="beh-grid"></div>
  </div>
</section>

<!-- TAB 3: FLOWS — bridge from "methods" to "user journeys" -->
<section class="panel" id="panel-flows" role="tabpanel">
  <p class="bridge">A <b>flow</b> is the sequence of methods that execute when a real request hits your system. Each box is a method you already saw in the Behaviors tab — but here they're connected as a call chain. Solid lines = hard-coded calls. Dashed = framework-derived. <span style="color:var(--green)">Green boxes</span> pulse because a test proves they break if mutated.</p>
  <div id="flow-list"></div>
  <div class="ai-sec" id="ai-sec" hidden>
    <div class="ai-lbl">AI-suggested flows — plausible paths, not proven. Dashed borders = unverified.</div>
    <div id="ai-list"></div>
  </div>
</section>

<!-- TAB 4: RISKS — actionable -->
<section class="panel" id="panel-risks" role="tabpanel">
  <p class="bridge">These are the flows with the highest blast radius and the weakest test coverage. Each one tells you exactly what to do next.</p>
  <div class="risk-tools" id="risk-tools"></div>
  <div id="risk-list"></div>
</section>

</div>

<div class="drill-overlay" id="drill">
  <div class="drill-card" role="dialog" aria-modal="true">
    <button class="drill-close" id="drill-close" type="button">&times;</button>
    <div id="drill-content"></div>
  </div>
</div>

<script>
window.DATA = __ORANGEPRO_DATA__;

(function(){
const D=window.DATA,$=(s)=>document.querySelector(s);
const el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e};
const esc=s=>String(s).replace(/[&<>]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[m]));
const S=D.summary;

// header
$("#repo-name").textContent=D.repo;
$("#scan-date").textContent=new Date(D.scanned+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
$("#framework").textContent=D.framework;
$("#fw-pill").textContent=D.framework;

// bridge text in codebase tab
$("#br-methods").textContent=S.total;
$("#br-services").textContent=D.scan.serviceTotal;
$("#br-tests").textContent=D.scan.tests.total;

// tab counts
$("#t-beh").textContent=D.behaviors.length;
$("#t-flow").textContent=D.flows.length;
$("#t-risk").textContent=D.risks.length;

// KPIs
[
  {lbl:"Methods found",num:S.total,sub:"public, with observable outcome",t:"total"},
  {lbl:"Dynamically Proven",num:S.proven,sub:"test breaks if you change it",t:"proven"},
  {lbl:"Test signal",num:S.associated,sub:"test touches it, no proof",t:"signal"},
  {lbl:"Reachable",num:S.reachableUntested,sub:"called but untested",t:"reach"},
  {lbl:"No signal",num:S.noSignal,sub:"nothing touches it",t:"nosig"},
].forEach(k=>{
  const d=el("div","kpi",\`<div class="kpi-lbl">\${k.lbl}</div><div class="kpi-num">\${k.num}</div><div class="kpi-sub">\${k.sub}</div>\`);
  d.dataset.t=k.t;
  $("#kpis").append(d);
});

// codebase
D.scan.services.forEach(([nm,ct])=>$("#svc-list").append(el("div","svc",\`<span class="nm">\${esc(nm)}</span><span class="ct">\${ct}</span>\`)));
$("#test-total").textContent=D.scan.tests.total;
$("#test-int").textContent=D.scan.tests.integration;
$("#test-unit").textContent=D.scan.tests.unit;

// behaviors
function tierOf(b){
  if(b.tier==="proven")return{cls:"proven",badge:"b-proven",label:"Dynamically Proven",ax:"ax-proven"};
  if(b.tier==="assoc")return{cls:"assoc",badge:"b-signal",label:"Test signal",ax:"ax-signal"};
  if(b.tier==="none"&&b.reachable)return{cls:"reach",badge:"b-reach",label:"Reachable",ax:"ax-reach"};
  return{cls:"nosig",badge:"b-nosig",label:"No signal",ax:"ax-nosig"};
}
function ctaOf(b){
  if(b.tier==="proven")return"This method is Dynamically Proven. A test breaks if you mutate it. Keep it green.";
  if(b.tier==="assoc")return"A test calls this method, but doesn't prove breakage. Run <code>npx -y @orangepro/orangepro-mcp start</code> to attempt dynamic proof.";
  if(b.tier==="none"&&b.reachable)return"This method is reachable from a tested path but has no direct test. Write one.";
  return"Nothing in your test suite touches this method. Write a test that calls it and asserts the output.";
}

let activeGrp=null,activeTier=null,searchQ="";
const behSide=$("#beh-groups"),behGrid=$("#beh-grid");
function renderBeh(){
  behGrid.innerHTML="";
  const rows=D.behaviors.filter(b=>(!activeGrp||b.group===activeGrp)&&(!activeTier||tierOf(b).cls===activeTier)&&(!searchQ||(b.sig+" "+b.file).toLowerCase().includes(searchQ)));
  rows.forEach(b=>{
    const t=tierOf(b);
    const c=el("div","beh-card",
      \`<div class="bc-top"><span class="bc-sig">\${esc(b.sig)}</span><span class="badge \${t.badge} bc-badge"><span class="d"></span>\${t.label}</span></div><div class="bc-file">\${esc(b.file)}</div><div class="bc-bar"></div>\`);
    c.dataset.t=t.cls;
    c.tabIndex=0;
    c.onclick=()=>showDrill(D.behaviors.indexOf(b));
    behGrid.append(c);
  });
}
// text search across behavior signature + file
const searchEl=$("#beh-search");
searchEl.addEventListener("input",()=>{searchQ=searchEl.value.trim().toLowerCase();renderBeh();});
// evidence-tier filter (Dynamically Proven first) so users can jump straight to a tier
const tierWrap=$("#tier-filter");
[["proven","Dynamically Proven"],["assoc","Test signal"],["reach","Reachable"],["nosig","No signal"]].forEach(([cls,label])=>{
  const n=D.behaviors.filter(b=>tierOf(b).cls===cls).length;
  const btn=el("button","grp",\`<span>\${label}</span><span class="gc">\${n}</span>\`);
  btn.setAttribute("aria-pressed","false");
  btn.onclick=()=>{
    activeTier=activeTier===cls?null:cls;
    [...tierWrap.querySelectorAll(".grp")].forEach(x=>x.setAttribute("aria-pressed",String(x===btn&&!!activeTier)));
    renderBeh();
  };
  tierWrap.append(btn);
});
D.behaviorGroups.forEach(g=>{
  const btn=el("button","grp",\`<span>\${esc(g.key)}</span><span class="gc">\${g.count}</span>\`);
  btn.setAttribute("aria-pressed","false");
  btn.onclick=()=>{
    activeGrp=activeGrp===g.key?null:g.key;
    [...behSide.querySelectorAll(".grp")].forEach(x=>x.setAttribute("aria-pressed",String(x===btn&&!!activeGrp)));
    renderBeh();
  };
  behSide.append(btn);
});
renderBeh();

// drill
const drill=$("#drill"),dc=$("#drill-content");
function showDrill(i){
  const b=D.behaviors[i];if(!b)return;
  const t=tierOf(b);
  dc.innerHTML=\`<h2 class="drill-title">\${esc(b.sig)}</h2>
    <div class="drill-row"><h4>Evidence</h4><span class="badge \${t.badge}"><span class="d"></span>\${t.label}</span></div>
    <div class="drill-row"><h4>File</h4><p class="mono">\${esc(b.file)}</p></div>
    <div class="drill-row"><h4>What to do</h4><div class="abox \${t.ax}">\${ctaOf(b)}</div></div>\`;
  drill.classList.add("open");document.body.style.overflow="hidden";
}
$("#drill-close").onclick=()=>{drill.classList.remove("open");document.body.style.overflow=""};
drill.onclick=e=>{if(e.target===drill){drill.classList.remove("open");document.body.style.overflow=""}};
document.onkeydown=e=>{if(e.key==="Escape"){drill.classList.remove("open");document.body.style.overflow=""}};

// flows
const fl=$("#flow-list");
D.flows.forEach(f=>{
  const rBadge=f.risk==="critical"?\`<span class="badge b-risk"><span class="d"></span>critical</span>\`:\`<span class="badge b-signal"><span class="d"></span>high</span>\`;
  const pBadge=f.proof==="proven"?\`<span class="badge b-proven"><span class="d"></span>dynamically proven</span>\`:f.proof==="assoc"?\`<span class="badge b-signal"><span class="d"></span>signal</span>\`:\`<span class="badge b-nosig"><span class="d"></span>no proof</span>\`;

  const totalNodes=(f.trigger?1:0)+f.steps.length;
  const vert=totalNodes>4;
  let chain=vert?\`<div class="flow-chain fc-vert">\`:\`<div class="flow-chain">\`;

  if(f.trigger){
    chain+=\`<div class="fn"><div class="fn-box fnb-entry"><span style="color:var(--green);font-weight:700">\${esc(f.trigger.verb)}</span> \${esc(f.trigger.path)}</div></div>\`;
  }
  f.steps.forEach(s=>{
    const eCls=s.edge==="framework-derived"?"fel-fw":"fel-hard";
    chain+=\`<div class="fe"><div class="fe-line \${eCls}"></div></div>\`;
    const nCls=s.proof==="proven"?"fnb-proven":s.proof==="assoc"?"fnb-assoc":"";
    chain+=\`<div class="fn"><div class="fn-box \${nCls}">\${esc(s.sig)}</div></div>\`;
  });
  chain+=\`</div>\`;

  fl.append(el("div","flow-card",
    \`<div class="flow-head"><h3>\${esc(f.title)}</h3><div class="flow-tags">\${rBadge}\${pBadge}</div></div>\${chain}\`));
});

// AI flows
const cf=D.candidateFlows;
if(cf&&cf.flows.length){
  $("#ai-sec").hidden=false;
  cf.flows.forEach(f=>{
    const vert=f.steps.length>4;
    let chain=vert?\`<div class="flow-chain fc-vert">\`:\`<div class="flow-chain">\`;
    f.steps.forEach((s,i)=>{
      if(i)chain+=\`<div class="fe"><div class="fe-line fel-hard"></div></div>\`;
      chain+=\`<div class="fn"><div class="fn-box">\${esc(s.sig)}</div></div>\`;
    });
    chain+=\`</div>\`;
    $("#ai-list").append(el("div","flow-card ai-card",
      \`<div class="flow-head"><h3>\${esc(f.title)}</h3><div class="flow-tags"><span class="badge b-info">\${esc(cf.model)}</span></div></div>\${chain}\`));
  });
}

// risks + generated test samples
let activeRiskFilter="all";
const riskList=$("#risk-list"),riskTools=$("#risk-tools");
function riskMatchesFilter(r){
  const hasGenerated=Boolean(r.generatedTests&&r.generatedTests.length);
  if(activeRiskFilter==="generated")return hasGenerated;
  if(activeRiskFilter==="missing")return !hasGenerated;
  return true;
}
function renderRiskFilters(){
  const options=[
    ["all","All",D.risks.length],
    ["generated","Generated tests",D.risks.filter(r=>r.generatedTests&&r.generatedTests.length).length],
    ["missing","No generated tests",D.risks.filter(r=>!(r.generatedTests&&r.generatedTests.length)).length]
  ];
  riskTools.innerHTML=options.map(([key,label,count])=>\`<button class="risk-filter" type="button" data-risk-filter="\${key}" aria-pressed="\${key===activeRiskFilter}">\${label} <span class="gc">\${count}</span></button>\`).join("");
}
function riskCardHtml(r){
  const tags=r.tags.map(([t,k])=>\`<span class="badge b-\${k}"><span class="d"></span>\${esc(t)}</span>\`).join("");
  // category strip: show which concern categories apply to this flow
  let catHtml='';
  if(r.applicableCategories&&r.applicableCategories.length){
    const shownConcerns=new Set((r.generatedTests||[]).map(t=>t.concern).filter(Boolean));
    const pills=r.applicableCategories.map(c=>{
      const shown=shownConcerns.has(c);
      const label=c.replace(/_/g,' ');
      return \`<span class="cat-pill \${shown?'cp-shown':'cp-locked'}">\${esc(label)}</span>\`;
    }).join('');
    const shownN=r.applicableCategories.filter(c=>shownConcerns.has(c)).length;
    const totalN=r.applicableCategories.length;
    catHtml=\`<div class="cat-strip"><div class="cat-strip-lbl">Testing categories for this flow (\${shownN} of \${totalN} shown)</div><div class="cat-pills">\${pills}</div></div>\`;
  }
  let testsHtml='';
  if(r.generatedTests&&r.generatedTests.length){
    testsHtml=\`<div class="gen-tests"><div class="gen-tests-lbl">Generated tests (integration)</div>\`;
    r.generatedTests.forEach(t=>{
      const cBadge=t.concern?\`<span class="badge b-info" style="margin-left:6px;font-size:9px">\${esc(t.concern.replace('_',' '))}</span>\`:'';
      testsHtml+=\`<div class="gen-test"><div class="gen-test-head"><span class="gen-test-name">\${esc(t.name)}\${cBadge}</span><span class="gen-test-assert">\${esc(t.assertion)}</span><span class="gen-test-toggle">&#9660;</span></div><div class="gen-test-body">\${esc(t.code)}</div></div>\`;
    });
    testsHtml+=\`</div>\`;
  }
  return \`<div class="risk-rank">#\${r.rank}</div>
     <div class="risk-ep"><span class="v">\${esc(r.verb)}</span> \${esc(r.path)}</div>
     <div class="risk-desc">\${esc(r.desc)}</div>
     <div class="risk-tags">\${tags}</div>
     <div class="todo">\${esc(r.todo)}</div>\${testsHtml}\${catHtml}\`;
}
function renderRisks(){
  riskList.innerHTML="";
  D.risks.filter(riskMatchesFilter).forEach(r=>riskList.append(el("div","risk-card",riskCardHtml(r))));
  if(activeRiskFilter==="all"&&D.generatedTotal){
    const hiddenGenerated=Math.max(0,D.generatedTotal-D.shownCount);
    const remainingRiskFlows=Math.max(0,D.risks.length-D.generatedTotal);
    riskList.append(el("div","paywall",
      hiddenGenerated
        ? \`<div class="paywall-num">\${hiddenGenerated} more tests generated</div>
           <div class="paywall-txt">OrangePro generated tests for \${D.generatedTotal} behaviors across your highest-risk flows. You're seeing \${D.shownCount}.</div>
           <a class="paywall-btn" href="https://app.orangepro.ai" target="_blank">View all on OrangePro Platform &rarr;</a>\`
        : remainingRiskFlows
          ? \`<div class="paywall-num">\${remainingRiskFlows} high-risk flows left</div>
             <div class="paywall-txt">The local MCP accepted \${D.generatedTotal} runnable generated test\${D.generatedTotal===1?"":"s"} for this report. Generate the remaining high-risk flow tests on OrangePro Platform.</div>
             <a class="paywall-btn" href="https://app.orangepro.ai" target="_blank">Generate remaining tests on Platform &rarr;</a>\`
          : \`<div class="paywall-num">All generated tests are shown</div>
             <div class="paywall-txt">OrangePro generated tests for every high-risk flow in this report, and every generated test is visible here.</div>\`));
  }
}
riskTools.addEventListener("click",e=>{
  const btn=e.target.closest("[data-risk-filter]");
  if(!btn)return;
  activeRiskFilter=btn.dataset.riskFilter;
  renderRiskFilters();
  renderRisks();
});
renderRiskFilters();
renderRisks();
// toggle test expand
document.addEventListener('click',e=>{
  const h=e.target.closest('.gen-test-head');
  if(h)h.parentElement.classList.toggle('open');
});

// tabs
const tabs=[...document.querySelectorAll(".tab")];
tabs.forEach(t=>t.onclick=()=>{
  tabs.forEach(x=>x.setAttribute("aria-selected",String(x===t)));
  document.querySelectorAll(".panel").forEach(p=>p.classList.toggle("active",p.id==="panel-"+t.dataset.tab));
});
})();
</script>
</body>
</html>
`;

/** JSON safe to embed inside an inline <script> (neutralize </script> and JS line separators). */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Render the self-contained behavior report HTML from the report data object. */
export function renderBehaviorReport(data: BehaviorReportData): string {
  return TEMPLATE.replace("__ORANGEPRO_DATA__", () => safeJson(data));
}
