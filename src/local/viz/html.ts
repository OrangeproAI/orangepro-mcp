import { VizPayload } from "./payload.js";
import { D3_SOURCE } from "./d3.bundle.js";

/**
 * Render a self-contained, offline coverage-gap explorer ("Gap Zones").
 *
 * Three tabs:
 *  - Gap Zones — a D3 force layout where every code area is a hub in the centre
 *    lane and its sampled symbols are pulled into tier zones: covered (dynamic Proven +
 *    runtime) hug the centre, ASSOCIATED weak signals pull left, GAP (no test
 *    link) glow on the right. The right column IS the gap.
 *  - Overview — dynamic-Proven-share donut + a squarified treemap of areas (size = real
 *    code units, fill = tier mix).
 *  - Matrix — area × tier heat table + an area × language tier strip.
 *
 * No CDN, no network: D3 v7 is vendored inline and the gap-first DATA (the
 * curated `payload.gap` view model) is injected as JSON. This is a LOCAL artifact
 * (written by `opro export --format graph-html`, never uploaded), so it intentionally
 * includes real test/area names. It embeds NO raw source code, generated test
 * bodies, prompts, secrets, or node `properties` beyond the curated gap view.
 *
 * TIERS ARE DISJOINT AND HONEST. "Proven" = dynamic targeted-proof ledger
 * records only; static, runtime, associated, and AI-suggested signals NEVER move the proven %.
 * The 4-tier breakdown (proven / runtime-covered / associated / no-link) is
 * derived here straight from `payload.gap` — this renderer adds no scoring.
 */
export function renderVizHtml(payload: VizPayload): string {
  const data = JSON.stringify(payload.gap).replace(/</g, "\\u003c");
  // Inert, metadata-only provenance comment (generated-test bucket tally + counts).
  // Carries no bodies/source — just trust-artifact aggregates for back-compat.
  const meta = scriptSafe(
    [
      `confirmed=${payload.gap.stats.confirmed}/${payload.gap.stats.userflows}`,
      `inferred=${payload.gap.stats.inferred}`,
      `none=${payload.gap.stats.none}`,
      `generated=${payload.meta.generated.count}`,
      ...payload.meta.generated.byBucket.map((b) => `${b.bucket}=${b.count}`)
    ].join(" ")
  ).replace(/--/g, "—");
  // Function replacements throughout: a STRING replacement interprets $-patterns
  // ($&, $`, $', $$) inside the INSERTED text. D3's minified source contains
  // literal $` sequences, and DATA / workspace names can contain $&/$'. A function
  // replacement is inert: the returned string is inserted verbatim.
  return HTML_TEMPLATE.replace(/__TITLE__/g, () => escapeHtml(payload.gap.workspace))
    .replace("__META__", () => escapeHtml(meta))
    .replace("__GENERATED__", () => escapeHtml(payload.meta.created_at || ""))
    .replace("/*__D3__*/", () => scriptSafe(D3_SOURCE))
    .replace('"__DATA__"', () => data)
    .replace("/*__VIZ_LOGIC__*/", () => scriptSafe(VIZ_LOGIC));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/** Neutralize any `</script` so embedded JS can never close the host script tag. */
function scriptSafe(s: string): string {
  return s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

const VIZ_LOGIC = `
document.addEventListener('DOMContentLoaded', function() {
  try { initViz(); }
  catch(e) {
    var lm = document.getElementById('loading-msg');
    if (lm) { lm.style.display = 'block'; lm.textContent = 'Error loading visualization: ' + e.message; }
    if (window.console) console.error(e);
  }
});

function initViz() {
  var D = DATA;
  var $ = function(id){ return document.getElementById(id); };
  function fmt(n){ return (Number(n) || 0).toLocaleString(); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  var lm = $('loading-msg'); if (lm) lm.style.display = 'none';
  var appEl = $('app'); if (appEl) appEl.style.display = 'block';

  // ---- derive the fields the view needs straight from payload.gap ----
  var LT = (D.language_tiers || []).map(function(l){
    return {
      language: l.language,
      total: Number(l.total) || 0,
      proven: Number(l.proven) || 0,
      runtime_covered: Number(l.runtime_covered) || 0,
      associated: Number(l.associated) || 0,
      unlinked: Number(l.unlinked) || 0,
      proven_pct: Number(l.proven_pct) || 0,
      dynamic_proof: (Number(l.proven) || 0) > 0
    };
  });
  function lsum(f){ return LT.reduce(function(s,l){ return s + (Number(f(l)) || 0); }, 0); }
  var TOTAL_PROVEN = lsum(function(l){ return l.proven; });
  var TOTAL_RUNTIME = lsum(function(l){ return l.runtime_covered; });
  var TOTAL_ASSOC = lsum(function(l){ return l.associated; });
  var TOTAL_NONE = lsum(function(l){ return l.unlinked; });
  var BEHAVIOR_TOTAL = (D.stats && Number(D.stats.behavior_total)) || (TOTAL_PROVEN + TOTAL_RUNTIME + TOTAL_ASSOC + TOTAL_NONE);
  var PROVEN_PCT = (D.stats && Number(D.stats.behavior_confirmed_pct)) || 0;

  // majority language per area (area_summary carries no language; code_behaviors do)
  var areaLangCount = {};
  (D.code_behaviors || []).forEach(function(b){
    if (!b.area) return;
    var m = areaLangCount[b.area] = areaLangCount[b.area] || {};
    var L = b.language || '';
    if (L) m[L] = (m[L] || 0) + 1;
  });
  function langOf(area){
    var m = areaLangCount[area]; if (!m) return '';
    var best = '', bn = -1;
    for (var k in m){ if (m[k] > bn){ bn = m[k]; best = k; } }
    return best;
  }
  // area rows, normalized to 4 disjoint tiers (confirmed=proven, runtime_covered,
  // inferred=associated, none=no-link) + a derived language label.
  var AREAS = (D.area_summary || []).map(function(a){
    return {
      area: a.area || 'core',
      lang: langOf(a.area),
      total: Number(a.total) || 0,
      proven: Number(a.confirmed) || 0,
      runtime: Number(a.runtime_covered) || 0,
      associated: Number(a.inferred) || 0,
      none: Number(a.none) || 0,
      proven_pct: Number(a.confirmed_pct) || 0,
      sample_gaps: Array.isArray(a.sample_gaps) ? a.sample_gaps : []
    };
  });
  var areaByName = {};
  AREAS.forEach(function(a){ areaByName[a.area] = a; });
  function areaMatchesLang(a, langName){ return !langName || a.lang === langName; }

  // ---- header / headline ----
  var hp = $('hl-pct'); if (hp) hp.textContent = PROVEN_PCT.toFixed(2) + '%';
  var hd = $('hl-denom'); if (hd) hd.textContent = fmt(BEHAVIOR_TOTAL);
  var kP = $('kpi-proven'); if (kP) kP.textContent = fmt(TOTAL_PROVEN);
  var kR = $('kpi-runtime'); if (kR) kR.textContent = fmt(TOTAL_RUNTIME);
  var kA = $('kpi-assoc'); if (kA) kA.textContent = fmt(TOTAL_ASSOC);
  var kN = $('kpi-none'); if (kN) kN.textContent = fmt(TOTAL_NONE);
  var wsn = $('ws-name'); if (wsn) wsn.textContent = D.workspace || '';
  var ftw = $('ft-ws'); if (ftw) ftw.textContent = D.workspace || '';
  var ftd = $('ft-date'); if (ftd) ftd.textContent = (document.body.getAttribute('data-generated') || '').slice(0, 10);

  // ---- partial-scan banner (a budget-stopped run must never read as complete) ----
  if (D.partial_scan && $('partial-banner')) {
    $('partial-banner').classList.add('show');
    var ps = (D.partial_scan && typeof D.partial_scan === 'object') ? D.partial_scan : {};
    var pf = (typeof D.files_not_analyzed === 'number') ? D.files_not_analyzed : (ps.files_not_analyzed || 0);
    var bt = $('banner-text');
    if (bt) bt.textContent = 'PARTIAL SCAN — ' + fmt(pf) + ' file(s) NOT analyzed'
      + (ps.budget_ms ? ' (budget ' + Math.round(ps.budget_ms/1000) + 's)' : '')
      + '. The coverage below is a FLOOR over a partial scan. Raise ORANGEPRO_MAX_ANALYZE_MS or scope with --base.';
  }
  // ---- hard-proof-limited banner (full proof pass exceeded the budget) ----
  var proofLimited = D.proof_limited;
  var proofBanner = $('proof-banner');
  if (proofLimited && proofBanner) {
    proofBanner.style.display = 'block';
    if (proofLimited.scoped_by_risk) {
      proofBanner.textContent = 'HARD PROOF SCOPED — this full scan had '
        + fmt(proofLimited.skipped_files_budget)
        + ' confirmable files, above the confirmer budget. OrangePro ran a risk-ranked subset ('
        + fmt(proofLimited.scoped_by_risk.candidate_pairs)
        + ' candidate pair(s)); Proven is still a conservative lower bound. Associated links are not proof. Use PR scope (--base <ref>) or raise ORANGEPRO_MAX_CONFIRM_FILES for the whole repo.';
    } else {
      proofBanner.textContent = 'HARD PROOF SKIPPED — this full scan exceeded the confirmer budget ('
        + fmt(proofLimited.skipped_files_budget)
        + ' files). Proven coverage is a conservative lower bound because that proof pass did not run. Associated links are still shown, but they are not proof. Use PR scope (--base <ref>) or raise ORANGEPRO_MAX_CONFIRM_FILES.';
    }
  }

  // ===================================================================
  //  STATE + TABS
  // ===================================================================
  var state = { tiers: { proven:true, runtime:true, associated:true, none:true }, area:null, lang:'', search:'' };

  var langSel = $('lang-filter');
  if (langSel) LT.forEach(function(l){
    var o = document.createElement('option'); o.value = l.language; o.textContent = l.language; langSel.appendChild(o);
  });

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab){
    tabs.forEach(function(t){
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true':'false');
      t.tabIndex = on ? 0 : -1;
      var pane = $(t.getAttribute('aria-controls'));
      if (pane) pane.classList.toggle('active', on);
    });
    tab.focus();
    if (tab.id === 'tab-zones') setTimeout(layoutForce, 0);
    if (tab.id === 'tab-overview') drawOverview();
    if (tab.id === 'tab-matrix') drawMatrix();
  }
  tabs.forEach(function(tab, i){
    tab.addEventListener('click', function(){ selectTab(tab); });
    tab.addEventListener('keydown', function(e){
      if (e.key === 'ArrowRight'){ selectTab(tabs[(i+1)%tabs.length]); e.preventDefault(); }
      else if (e.key === 'ArrowLeft'){ selectTab(tabs[(i-1+tabs.length)%tabs.length]); e.preventDefault(); }
      else if (e.key === 'Home'){ selectTab(tabs[0]); e.preventDefault(); }
      else if (e.key === 'End'){ selectTab(tabs[tabs.length-1]); e.preventDefault(); }
    });
  });

  // ===================================================================
  //  TOOLTIP
  // ===================================================================
  var tip = $('tip');
  function showTip(html, x, y){
    if (!tip) return;
    tip.innerHTML = html; tip.classList.add('show'); tip.setAttribute('aria-hidden','false');
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var px = Math.min((x||0) + 14, window.innerWidth - w - 10);
    var py = Math.min((y||0) + 14, window.innerHeight - h - 10);
    if (py < 8) py = 8;
    tip.style.left = px + 'px'; tip.style.top = py + 'px';
  }
  function hideTip(){ if (tip){ tip.classList.remove('show'); tip.setAttribute('aria-hidden','true'); } }

  var TIER = {
    proven:     { color:'var(--proven)', label:'Dynamic Proven' },
    runtime:    { color:'var(--runtime)', label:'Runtime-covered' },
    associated: { color:'var(--assoc)', label:'Associated' },
    none:       { color:'var(--none)', label:'No link' }
  };

  // ===================================================================
  //  DRILL PANEL (shared across tabs)
  // ===================================================================
  function glyphSVG(status){
    if (status === 'associated')
      return '<svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="var(--assoc)" stroke-width="2.4"/></svg>';
    if (status === 'proven' || status === 'runtime')
      return '<svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="' + (status === 'runtime' ? 'var(--runtime)' : 'var(--proven)') + '"/></svg>';
    return '<svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.4" fill="none" stroke="var(--none)" stroke-width="2.2"/><circle cx="8" cy="8" r="7" fill="none" stroke="var(--none)" stroke-width="1" opacity=".55"/></svg>';
  }
  function openDrillForArea(areaName){
    var a = areaByName[areaName]; if (!a) return;
    $('drillEmpty').hidden = true; $('drillContent').hidden = false;
    $('drillTitle').textContent = a.area;
    $('drillSub').innerHTML = esc(a.lang) + ' &middot; <span class="num">' + fmt(a.total) + '</span> real-code units &middot; <span class="num">' + a.proven_pct.toFixed(2) + '%</span> proven';
    $('dm-proven').textContent = fmt(a.proven);
    $('dm-runtime').textContent = fmt(a.runtime);
    $('dm-assoc').textContent = fmt(a.associated);
    $('dm-none').textContent = fmt(a.none);
    var list = $('gaplist'); list.innerHTML = '';
    (a.sample_gaps || []).slice().sort(function(p,q){
      var r = (p.status==='none'?0:1) - (q.status==='none'?0:1);
      if (r) return r;
      return (p.file||'').localeCompare(q.file||'') || (p.title||'').localeCompare(q.title||'');
    }).forEach(function(g){
      var row = document.createElement('div'); row.className = 'gaprow';
      var col = g.status === 'associated' ? 'var(--assoc)' : 'var(--none)';
      row.innerHTML =
        '<div class="top">' + glyphSVG(g.status) +
          '<span class="gt" title="' + esc(g.title) + '">' + esc(g.title) + '</span></div>' +
        '<div class="gf" title="' + esc(g.file) + '">' + esc(g.file) + '</div>' +
        '<div class="gtag" style="color:' + col + '">' + (g.status === 'associated' ? 'associated test link, not counted as proven' : 'no test link') + '</div>';
      list.appendChild(row);
    });
    if (!(a.sample_gaps || []).length)
      list.innerHTML = '<div style="color:var(--ink-3);font-size:12px;padding:10px 2px">No sampled uncovered symbols for this area.</div>';
  }

  // ===================================================================
  //  GAP ZONES — D3 force layout (covered centre / associated left / gap right)
  // ===================================================================
  var svg = $('forceSvg');
  var VW = 1000, VH = 560;
  var zonesLayer = $('zonesLayer'), linksLayer = $('linksLayer'), hubsLayer = $('hubsLayer'),
      dotsLayer = $('dotsLayer'), viewport = $('viewport');
  var SVGNS = 'http://www.w3.org/2000/svg';
  var nodes = [], links = [], sim = null;
  var CAP_PER_AREA = 40;
  var totalSymbolsShown = 0;
  var CENTER_X = VW * 0.5;   // covered (proven + runtime) lane
  var SIDE = 200;            // horizontal pull: associated left, gap right

  function buildModel(){
    nodes = []; links = []; totalSymbolsShown = 0;
    var areas = AREAS.slice();
    var n = areas.length, topPad = 74, botPad = 50;
    areas.forEach(function(a, i){
      var t = n > 1 ? i/(n-1) : 0.5;
      var rowY = topPad + t*(VH - topPad - botPad);
      var size = Math.max(6, Math.min(12, 5 + Math.sqrt(a.total)/4.6));
      var hub = { id:'hub:'+a.area, kind:'hub', area:a.area, lang:a.lang, x:CENTER_X, y:rowY,
                  fx:CENTER_X, fy:rowY, pinX:CENTER_X, pinY:rowY, r:size, data:a };
      nodes.push(hub);
      var tiers = [
        { key:'proven', n:a.proven }, { key:'runtime', n:a.runtime },
        { key:'associated', n:a.associated }, { key:'none', n:a.none }
      ];
      var areaTotal = a.total || 1;
      var alloc = tiers.map(function(t2){
        return { key:t2.key, n:t2.n, want: t2.n > 0 ? Math.max(1, Math.round(t2.n/areaTotal*CAP_PER_AREA)) : 0 };
      });
      var sum = alloc.reduce(function(s,x){ return s + x.want; }, 0);
      while (sum > CAP_PER_AREA){
        alloc.sort(function(p,q){ return q.want - p.want; });
        for (var k=0; k<alloc.length && sum>CAP_PER_AREA; k++){ if (alloc[k].want > 1){ alloc[k].want--; sum--; } }
      }
      alloc.forEach(function(al){
        for (var d=0; d<al.want; d++){
          totalSymbolsShown++;
          // covered (proven/runtime) hug centre; associated pull left; gap (none) push right.
          var side = al.key === 'associated' ? -1 : al.key === 'none' ? 1 : 0;
          var targetX = CENTER_X + side*SIDE;
          var dot = { id:'dot:'+a.area+':'+al.key+':'+d, kind:'dot', area:a.area, lang:a.lang, tier:al.key,
                      side:side, targetX:targetX, hub:hub,
                      x: targetX + (Math.random()-0.5)*70, y: rowY + (Math.random()-0.5)*46,
                      r: (al.key === 'proven' || al.key === 'runtime') ? 4.4 + Math.random()*1.6 : 3.6 + Math.random()*2.2 };
          links.push({ source:hub, target:dot, tier:al.key });
        }
      });
    });
  }

  function dotMatchesFilters(dt){
    if (dt.kind !== 'dot') return true;
    if (!state.tiers[dt.tier]) return false;
    if (state.area && dt.area !== state.area) return false;
    if (state.lang && !areaMatchesLang(areaByName[dt.area] || {}, state.lang)) return false;
    if (state.search && dt.area.toLowerCase().indexOf(state.search.toLowerCase()) === -1) return false;
    return true;
  }

  function dragBehavior(node){
    return d3.drag()
      .on('start', function(e){ if (!e.active && sim) sim.alphaTarget(0.2).restart(); node.fx = node.x; node.fy = node.y; })
      .on('drag', function(e){ node.fx = e.x; node.fy = e.y; })
      .on('end', function(e){ if (!e.active && sim) sim.alphaTarget(0); if (node.kind === 'dot'){ node.fx = null; node.fy = null; } });
  }

  function drawGraph(){
    if (!svg) return;
    zonesLayer.innerHTML = ''; linksLayer.innerHTML = ''; hubsLayer.innerHTML = ''; dotsLayer.innerHTML = '';
    // zone bands: associated (left) / covered (centre) / gap (right)
    var zones = [
      { x0:0,      x1:0.375, tint:'rgba(245,158,11,.05)', op:'0.42', label:'ASSOCIATED', sub:'weak signal · not proof' },
      { x0:0.375,  x1:0.625, tint:'rgba(234,88,12,.05)',  op:'0.42', label:'CODE · COVERED', sub:'proven + runtime' },
      { x0:0.625,  x1:1,     tint:'rgba(244,63,94,.07)',  op:'0.7',  label:'GAP ZONE · NO TEST LINK', sub:'real code, no test signal' }
    ];
    zones.forEach(function(z){
      var rect = document.createElementNS(SVGNS,'rect');
      rect.setAttribute('x', (z.x0*VW)); rect.setAttribute('y', 0);
      rect.setAttribute('width', (z.x1-z.x0)*VW); rect.setAttribute('height', VH);
      rect.setAttribute('fill', z.tint); rect.setAttribute('opacity', z.op);
      zonesLayer.appendChild(rect);
      var lab = document.createElementNS(SVGNS,'text');
      lab.setAttribute('class','zoneLabel'); lab.setAttribute('x', (z.x0+ (z.x1-z.x0)/2)*VW); lab.setAttribute('y', 26);
      lab.setAttribute('text-anchor','middle'); lab.setAttribute('fill','var(--ink-3)');
      lab.textContent = z.label; zonesLayer.appendChild(lab);
      var sub = document.createElementNS(SVGNS,'text');
      sub.setAttribute('class','zoneSub'); sub.setAttribute('x', (z.x0+ (z.x1-z.x0)/2)*VW); sub.setAttribute('y', 40);
      sub.setAttribute('text-anchor','middle'); sub.setAttribute('fill','var(--ink-3)');
      sub.textContent = z.sub; zonesLayer.appendChild(sub);
    });

    // links (hub -> symbol)
    links.forEach(function(ln){
      var el = document.createElementNS(SVGNS,'line');
      el.setAttribute('stroke', TIER[ln.tier].color);
      el.setAttribute('stroke-opacity', (ln.tier === 'proven' || ln.tier === 'runtime') ? 0.42 : 0.16);
      el.setAttribute('stroke-width', 0.8);
      ln._el = el; linksLayer.appendChild(el);
    });

    // hubs (one per area, centre column)
    nodes.filter(function(n){ return n.kind === 'hub'; }).forEach(function(h){
      var g = document.createElementNS(SVGNS,'g');
      g.setAttribute('class','node-focus'); g.setAttribute('tabindex','0');
      g.setAttribute('role','button'); g.setAttribute('aria-label', h.area + ' code area');
      var c = document.createElementNS(SVGNS,'circle');
      c.setAttribute('r', h.r); c.setAttribute('fill','var(--accent)');
      c.setAttribute('stroke','var(--bg)'); c.setAttribute('stroke-width','1.5');
      c.setAttribute('filter','url(#hubGlow)'); g.appendChild(c);
      var lbl = document.createElementNS(SVGNS,'text');
      lbl.setAttribute('class','hub-label'); lbl.setAttribute('text-anchor','middle');
      lbl.setAttribute('dy', h.r + 12); lbl.textContent = h.area; g.appendChild(lbl);
      h._g = g; hubsLayer.appendChild(g);
      function hubTip(e){
        var a = h.data;
        showTip('<div class="tt">' + esc(h.area) + '</div>' +
          '<div class="trow"><span>real-code units</span><span class="v">' + fmt(a.total) + '</span></div>' +
          '<div class="trow"><span style="color:var(--proven)">Dynamic Proven</span><span class="v">' + fmt(a.proven) + '</span></div>' +
          '<div class="trow"><span style="color:var(--runtime)">Runtime</span><span class="v">' + fmt(a.runtime) + '</span></div>' +
          '<div class="trow"><span style="color:var(--assoc)">Associated</span><span class="v">' + fmt(a.associated) + '</span></div>' +
          '<div class="trow"><span style="color:var(--none)">No link</span><span class="v">' + fmt(a.none) + '</span></div>',
          (e.clientX||0),(e.clientY||0));
      }
      g.addEventListener('mouseenter', hubTip); g.addEventListener('mousemove', hubTip); g.addEventListener('mouseleave', hideTip);
      g.addEventListener('click', function(){ setArea(h.area, true); });
      g.addEventListener('keydown', function(e){ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); setArea(h.area, true); } });
      d3.select(g).call(dragBehavior(h));
    });

    // dots (sampled symbols)
    nodes.filter(function(n){ return n.kind === 'dot'; }).forEach(function(dt){
      var g = document.createElementNS(SVGNS,'g'); g.setAttribute('class','node-focus');
      g.style.display = dotMatchesFilters(dt) ? '' : 'none';
      var col = TIER[dt.tier].color;
      if (dt.tier === 'proven' || dt.tier === 'runtime'){
        var c = document.createElementNS(SVGNS,'circle');
        c.setAttribute('r', dt.r); c.setAttribute('fill', col); c.setAttribute('fill-opacity','0.95');
        g.appendChild(c);
      } else if (dt.tier === 'associated'){
        var c2 = document.createElementNS(SVGNS,'circle');
        c2.setAttribute('r', dt.r); c2.setAttribute('fill','none'); c2.setAttribute('stroke', col); c2.setAttribute('stroke-width','1.8');
        g.appendChild(c2);
      } else {
        var c3 = document.createElementNS(SVGNS,'circle');
        c3.setAttribute('r', dt.r); c3.setAttribute('fill','none'); c3.setAttribute('stroke', col);
        c3.setAttribute('stroke-width','1.9'); c3.setAttribute('filter','url(#redGlow)'); g.appendChild(c3);
        var c3b = document.createElementNS(SVGNS,'circle');
        c3b.setAttribute('r', dt.r+2.6); c3b.setAttribute('fill','none'); c3b.setAttribute('stroke', col);
        c3b.setAttribute('stroke-width','0.8'); c3b.setAttribute('stroke-opacity','0.5'); g.appendChild(c3b);
      }
      dt._g = g; dotsLayer.appendChild(g);
      function dotTip(e){
        var label = (dt.tier === 'proven') ? 'Proven — dynamic targeted proof'
                  : (dt.tier === 'runtime') ? 'Runtime-covered — executed by a coverage report, not proof'
                  : (dt.tier === 'associated') ? 'Associated — name/path/import/structural matching only, not proof'
                  : 'No link — no static or runtime signal';
        showTip('<div class="tt">' + esc(dt.area) + ' &middot; symbol</div>' +
          '<div class="trow"><span>tier</span><span class="v" style="color:' + col + '">' + TIER[dt.tier].label + '</span></div>' +
          '<div style="margin-top:6px;color:var(--ink-3);font-size:11px">' + label + '</div>',
          (e.clientX||0),(e.clientY||0));
      }
      g.addEventListener('mouseenter', dotTip); g.addEventListener('mousemove', dotTip); g.addEventListener('mouseleave', hideTip);
      g.addEventListener('click', function(){ setArea(dt.area, true); });
      d3.select(g).call(dragBehavior(dt));
    });
  }

  function ticked(){
    links.forEach(function(ln){
      if (!ln._el) return;
      ln._el.setAttribute('x1', ln.source.x); ln._el.setAttribute('y1', ln.source.y);
      ln._el.setAttribute('x2', ln.target.x); ln._el.setAttribute('y2', ln.target.y);
    });
    nodes.forEach(function(nd){ if (nd._g) nd._g.setAttribute('transform', 'translate(' + nd.x + ',' + nd.y + ')'); });
  }
  function startSim(){
    if (!nodes.length) return;
    sim = d3.forceSimulation(nodes)
      .force('x', d3.forceX(function(d){ return d.kind === 'hub' ? d.pinX : d.targetX; }).strength(function(d){ return d.kind === 'hub' ? 1 : 0.2; }))
      .force('y', d3.forceY(function(d){ return d.kind === 'hub' ? d.pinY : (d.hub ? d.hub.y : VH/2); }).strength(function(d){ return d.kind === 'hub' ? 1 : 0.12; }))
      .force('collide', d3.forceCollide(function(d){ return (d.r || 4) + 1.4; }))
      .force('link', d3.forceLink(links).id(function(d){ return d.id; }).distance(46).strength(0.02))
      .on('tick', ticked);
    for (var ti=0; ti<260; ti++) sim.tick();
    ticked();
    sim.alpha(0.4).restart();
  }

  // ---- zoom / pan (D3) — pinned to the viewBox so content never leaves view ----
  if (svg) {
    var ZB_EXTENT = [[0,0],[VW,VH]];
    var ZB_CENTER = [VW/2, VH/2];
    var zoomB = d3.zoom().scaleExtent([1,6]).extent(ZB_EXTENT).translateExtent(ZB_EXTENT)
      .filter(function(event){ return event.type === 'wheel' ? true : !(event.target.closest && event.target.closest('.node-focus')); })
      .on('zoom', function(event){ viewport.setAttribute('transform', event.transform.toString()); });
    var svgSel = d3.select(svg).call(zoomB);
    svgSel.on('dblclick.zoom', null);
    if ($('zoom-in')) $('zoom-in').addEventListener('click', function(){ svgSel.transition().duration(200).call(zoomB.scaleBy, 1.25, ZB_CENTER); });
    if ($('zoom-out')) $('zoom-out').addEventListener('click', function(){ svgSel.transition().duration(200).call(zoomB.scaleBy, 1/1.25, ZB_CENTER); });
    if ($('zoom-reset')) $('zoom-reset').addEventListener('click', function(){ svgSel.transition().duration(250).call(zoomB.transform, d3.zoomIdentity); });
  }

  function layoutForce(){
    if (!nodes.length){ buildModel(); drawGraph(); startSim(); }
    else if (sim){ sim.alpha(0.5).restart(); }
    updateSampleNote();
  }
  function updateSampleNote(){
    var sn = $('sample-note');
    if (sn) sn.textContent = 'showing ' + fmt(totalSymbolsShown) + ' of ' + fmt(BEHAVIOR_TOTAL) + ' symbols (capped ' + CAP_PER_AREA + '/area, proportional)';
  }

  // ===================================================================
  //  AREA SELECT (cross-tab highlight) + filters
  // ===================================================================
  function setArea(areaName, openDrill){
    state.area = (state.area === areaName) ? null : areaName;
    syncAreaButtons(); refreshDotVisibility();
    if (state.area){ openDrillForArea(state.area); var sw = $('drillSw'); if (sw) sw.style.background = 'var(--accent)'; }
    highlightMatrix(); highlightTreemap();
  }
  function syncAreaButtons(){
    Array.prototype.forEach.call(document.querySelectorAll('.areabtn'), function(b){
      b.setAttribute('aria-pressed', b.dataset.area === state.area ? 'true':'false');
    });
  }
  (function(){
    var wrap = $('areafilters'); if (!wrap) return;
    AREAS.forEach(function(a){
      var b = document.createElement('button'); b.className = 'areabtn'; b.dataset.area = a.area;
      b.setAttribute('aria-pressed','false');
      b.innerHTML = '<span class="sw"></span>' + esc(a.area) + '<span class="ct num">' + fmt(a.total) + '</span>';
      b.addEventListener('click', function(){ setArea(a.area, true); });
      wrap.appendChild(b);
    });
  })();
  function refreshDotVisibility(){
    nodes.forEach(function(nd){
      if (nd.kind === 'dot' && nd._g) nd._g.style.display = dotMatchesFilters(nd) ? '' : 'none';
      if (nd.kind === 'hub' && nd._g){
        var keep = true;
        if (state.area && nd.area !== state.area) keep = false;
        if (state.search && nd.area.toLowerCase().indexOf(state.search.toLowerCase()) === -1) keep = false;
        if (state.lang && !areaMatchesLang(nd.data, state.lang)) keep = false;
        nd._g.style.opacity = keep ? '1' : '0.18';
      }
    });
    var focused = !!(state.area || state.search || state.lang);
    links.forEach(function(ln){
      if (!ln._el) return;
      var vis = dotMatchesFilters(ln.target);
      ln._el.style.display = vis ? '' : 'none';
      if (vis){
        var base = (ln.tier === 'proven' || ln.tier === 'runtime') ? 0.42 : 0.16;
        ln._el.setAttribute('stroke-opacity', focused ? Math.min(0.62, base + 0.24) : base);
      }
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.chip[data-tier]'), function(chip){
    chip.addEventListener('click', function(){
      var key = chip.dataset.tier, on = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', on ? 'false':'true');
      state.tiers[key] = !on;
      refreshDotVisibility(); drawOverview(); drawMatrix();
    });
  });
  var searchTimer = null;
  if ($('search')) $('search').addEventListener('input', function(e){
    state.search = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ refreshDotVisibility(); drawMatrix(); highlightTreemap(); }, 120);
  });
  if (langSel) langSel.addEventListener('change', function(e){ state.lang = e.target.value; refreshDotVisibility(); drawMatrix(); drawOverview(); });

  // ===================================================================
  //  OVERVIEW TAB (donut + split bar + treemap)
  // ===================================================================
  function drawOverview(){
    var r = 68, circ = 2*Math.PI*r;
    var arc = Math.max(circ*PROVEN_PCT/100, 2.5);
    if ($('donutArc')) $('donutArc').setAttribute('stroke-dasharray', arc.toFixed(1) + ' ' + circ.toFixed(1));
    if ($('donutPct')) $('donutPct').textContent = PROVEN_PCT.toFixed(2) + '%';
    var denom = (TOTAL_PROVEN + TOTAL_RUNTIME + TOTAL_ASSOC + TOTAL_NONE) || 1;
    var track = $('splitTrack');
    if (track){
      track.innerHTML = '';
      [ { key:'proven', n:TOTAL_PROVEN, col:'var(--proven)' },
        { key:'runtime', n:TOTAL_RUNTIME, col:'var(--runtime)' },
        { key:'associated', n:TOTAL_ASSOC, col:'var(--assoc)' },
        { key:'none', n:TOTAL_NONE, col:'var(--none)' } ].forEach(function(s){
        var w = s.n/denom*100, el = document.createElement('div'); el.className = 'seg';
        el.style.width = w.toFixed(2) + '%';
        el.style.background = state.tiers[s.key] ? s.col : 'var(--panel-3)';
        el.style.opacity = state.tiers[s.key] ? '1' : '0.5';
        el.style.color = (s.key==='associated' || s.key==='runtime') ? '#06210f' : '#06210f';
        el.title = s.key + ': ' + fmt(s.n);
        el.textContent = w >= 6 ? fmt(s.n) : '';
        track.appendChild(el);
      });
    }
    if ($('sb-proven')) $('sb-proven').textContent = fmt(TOTAL_PROVEN);
    if ($('sb-runtime')) $('sb-runtime').textContent = fmt(TOTAL_RUNTIME);
    if ($('sb-assoc')) $('sb-assoc').textContent = fmt(TOTAL_ASSOC);
    if ($('sb-none')) $('sb-none').textContent = fmt(TOTAL_NONE);
    drawTreemap();
  }
  function drawTreemap(){
    var host = $('treemap'); if (!host) return;
    host.innerHTML = '';
    var W = host.clientWidth || 640, H = 360; host.style.height = H + 'px';
    var areas = AREAS.filter(function(a){
      if (state.lang && !areaMatchesLang(a, state.lang)) return false;
      if (state.search && a.area.toLowerCase().indexOf(state.search.toLowerCase()) === -1) return false;
      return a.total > 0;
    }).slice().sort(function(p,q){ return q.total - p.total; });
    if (!areas.length){ host.innerHTML = '<div class="empty" style="position:static"><div>No areas match the current filters.</div></div>'; return; }
    var total = areas.reduce(function(s,a){ return s + a.total; }, 0) || 1;
    function worst(row, len){
      var max=-Infinity, min=Infinity, sum=0;
      row.forEach(function(rr){ sum+=rr.val; max=Math.max(max,rr.val); min=Math.min(min,rr.val); });
      var s2 = sum*sum, len2 = len*len;
      return Math.max(len2*max/s2, s2/(len2*min));
    }
    function layoutRow(row, horizontal, ox, oy, ow, oh){
      var sum = row.reduce(function(s,rr){ return s+rr.val; }, 0), off = 0;
      row.forEach(function(rr){
        var frac = rr.val/sum, tx,ty,tw,th;
        if (horizontal){ tw=ow; th=oh*frac; tx=ox; ty=oy+off; off+=th; }
        else { tw=ow*frac; th=oh; tx=ox+off; ty=oy; off+=tw; }
        drawTile(rr.a, tx, ty, tw, th);
      });
    }
    var areaScale = (W*H)/total;
    var remaining = areas.map(function(a){ return { a:a, val:a.total*areaScale }; });
    var cx=0, cy=0, cw=W, ch=H;
    while (remaining.length){
      var horizontal = cw >= ch ? false : true;
      var row = [remaining[0]], shortest = horizontal ? cw : ch, i=1;
      while (i < remaining.length){
        var test = row.concat([remaining[i]]);
        if (worst(row, shortest) >= worst(test, shortest)){ row = test; i++; } else break;
      }
      var rowVal = row.reduce(function(s,rr){ return s+rr.val; }, 0), thick = rowVal/shortest;
      if (horizontal){ layoutRow(row, false, cx, cy, cw, thick); cy += thick; ch -= thick; }
      else { layoutRow(row, true, cx, cy, thick, ch); cx += thick; cw -= thick; }
      remaining = remaining.slice(row.length);
    }
    function drawTile(a, x, y, w, h){
      var el = document.createElement('button'); el.className = 'tile';
      el.style.left = (x+1)+'px'; el.style.top = (y+1)+'px';
      el.style.width = Math.max(0,w-2)+'px'; el.style.height = Math.max(0,h-2)+'px';
      var tot = a.total || 1, pNone = a.none/tot, pAssoc = a.associated/tot;
      el.style.background = pNone > pAssoc
        ? 'linear-gradient(135deg, rgba(244,63,94,' + (0.22+pNone*0.45).toFixed(2) + '), rgba(190,18,60,0.18))'
        : 'linear-gradient(135deg, rgba(245,158,11,' + (0.22+pAssoc*0.4).toFixed(2) + '), rgba(180,83,9,0.18))';
      el.setAttribute('aria-label', a.area + ', ' + fmt(a.total) + ' units, ' + a.proven_pct.toFixed(2) + '% proven');
      var showText = (w > 54 && h > 34);
      el.innerHTML = (showText ? '<div class="tn">' + esc(a.area) + '</div>' : '') +
        (showText ? '<div><div class="tm">' +
            '<span style="width:' + (a.proven/tot*100) + '%;background:var(--proven)"></span>' +
            '<span style="width:' + (a.runtime/tot*100) + '%;background:var(--runtime)"></span>' +
            '<span style="width:' + (a.associated/tot*100) + '%;background:var(--assoc)"></span>' +
            '<span style="width:' + (a.none/tot*100) + '%;background:var(--none)"></span>' +
          '</div><div class="tc">' + fmt(a.total) + ' &middot; ' + a.proven_pct.toFixed(1) + '%</div></div>' : '');
      el.addEventListener('click', function(){ setArea(a.area, true); });
      el.addEventListener('mouseenter', function(e){
        showTip('<div class="tt">' + esc(a.area) + '</div>' +
          '<div class="trow"><span>real-code units</span><span class="v">' + fmt(a.total) + '</span></div>' +
          '<div class="trow"><span style="color:var(--proven)">Dynamic Proven</span><span class="v">' + fmt(a.proven) + '</span></div>' +
          '<div class="trow"><span style="color:var(--runtime)">Runtime</span><span class="v">' + fmt(a.runtime) + '</span></div>' +
          '<div class="trow"><span style="color:var(--assoc)">Associated</span><span class="v">' + fmt(a.associated) + '</span></div>' +
          '<div class="trow"><span style="color:var(--none)">No link</span><span class="v">' + fmt(a.none) + '</span></div>',
          e.clientX, e.clientY);
      });
      el.addEventListener('mouseleave', hideTip);
      host.appendChild(el);
    }
    highlightTreemap();
  }
  function highlightTreemap(){
    Array.prototype.forEach.call(document.querySelectorAll('.tile'), function(t){ t.style.outline = ''; });
    if (state.area) Array.prototype.forEach.call(document.querySelectorAll('.tile'), function(t){
      var al = t.getAttribute('aria-label');
      if (al && al.indexOf(state.area + ',') === 0) t.style.outline = '2px solid var(--accent-ring)';
    });
  }

  // ===================================================================
  //  MATRIX TAB (area × tier heat table + area × language strip)
  // ===================================================================
  function heatBg(share, col){ var a = 0.10 + share*0.55; return 'rgba(' + col + ',' + a.toFixed(2) + ')'; }
  var RGB = { proven:'34,197,94', runtime:'88,166,255', associated:'245,158,11', none:'244,63,94' };
  function drawMatrix(){
    var body = $('mxbody'); if (!body) return;
    body.innerHTML = '';
    var areas = AREAS.filter(function(a){
      if (state.lang && !areaMatchesLang(a, state.lang)) return false;
      if (state.search && a.area.toLowerCase().indexOf(state.search.toLowerCase()) === -1) return false;
      return true;
    });
    if (!areas.length){
      var tr0 = document.createElement('tr');
      tr0.innerHTML = '<td colspan="6" style="color:var(--ink-3);padding:18px;text-align:center">No areas match the current filters.</td>';
      body.appendChild(tr0); drawLangStrip(); return;
    }
    areas.forEach(function(a){
      var tr = document.createElement('tr'); tr.dataset.area = a.area;
      var maxCell = Math.max(a.proven, a.runtime, a.associated, a.none) || 1;
      function cell(key, n, col, glyph){
        var dim = !state.tiers[key], share = n/maxCell;
        return '<td><div class="mxcell" role="button" tabindex="0" data-area="' + esc(a.area) + '" aria-label="' + esc(a.area) + ' ' + key + ' ' + fmt(n) + '" ' +
          'style="background:' + (dim ? 'var(--panel-2)' : heatBg(share, col)) + ';opacity:' + (dim ? 0.4 : 1) + '">' + glyph + '<span>' + fmt(n) + '</span></div></td>';
      }
      var gP = '<svg class="gly" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="var(--proven)"/></svg>';
      var gR = '<svg class="gly" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="var(--runtime)"/></svg>';
      var gA = '<svg class="gly" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="var(--assoc)" stroke-width="2.4"/></svg>';
      var gN = '<svg class="gly" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.4" fill="none" stroke="var(--none)" stroke-width="2.2"/></svg>';
      tr.innerHTML =
        '<td class="rname">' + esc(a.area) + '<span class="lg">' + esc(a.lang) + '</span></td>' +
        cell('proven', a.proven, RGB.proven, gP) +
        cell('runtime', a.runtime, RGB.runtime, gR) +
        cell('associated', a.associated, RGB.associated, gA) +
        cell('none', a.none, RGB.none, gN) +
        '<td class="pctcell" style="color:var(--proven)">' + a.proven_pct.toFixed(2) + '%</td>';
      body.appendChild(tr);
    });
    Array.prototype.forEach.call(body.querySelectorAll('.mxcell'), function(c){
      c.addEventListener('click', function(){ setArea(c.dataset.area, true); });
      c.addEventListener('keydown', function(e){ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); setArea(c.dataset.area, true); } });
    });
    highlightMatrix(); drawLangStrip();
  }
  function highlightMatrix(){
    Array.prototype.forEach.call(document.querySelectorAll('#mxbody tr'), function(tr){
      tr.style.background = (state.area && tr.dataset.area === state.area) ? 'var(--accent-soft)' : '';
    });
  }
  function drawLangStrip(){
    var host = $('langstrip'); if (!host) return;
    host.innerHTML = '';
    LT.forEach(function(l){
      if (state.lang && l.language !== state.lang) return;
      var denom = l.total || 1, row = document.createElement('div'); row.className = 'lsrow';
      var hp = l.dynamic_proof ? '<span class="hp hard">dynamic proof</span>' : '<span class="hp assoc">assoc-only</span>';
      row.innerHTML =
        '<div class="ln">' + esc(l.language) + hp + '</div>' +
        '<div class="lstrack" role="img" aria-label="' + esc(l.language) + ': ' + fmt(l.proven) + ' proven, ' + fmt(l.runtime_covered) + ' runtime, ' + fmt(l.associated) + ' associated, ' + fmt(l.unlinked) + ' no link">' +
          '<span class="s" style="width:' + (l.proven/denom*100) + '%;background:var(--proven)" title="proven ' + fmt(l.proven) + '"></span>' +
          '<span class="s" style="width:' + (l.runtime_covered/denom*100) + '%;background:var(--runtime)" title="runtime ' + fmt(l.runtime_covered) + '"></span>' +
          '<span class="s" style="width:' + (l.associated/denom*100) + '%;background:var(--assoc)" title="associated ' + fmt(l.associated) + '"></span>' +
          '<span class="s" style="width:' + (l.unlinked/denom*100) + '%;background:var(--none)" title="no link ' + fmt(l.unlinked) + '"></span>' +
        '</div>' +
        '<div class="lstotal">' + fmt(l.total) + '</div>';
      host.appendChild(row);
    });
    if (!host.childNodes.length) host.innerHTML = '<div style="color:var(--ink-3);font-size:12px">No languages match the current filter.</div>';
  }

  // ===================================================================
  //  THEME TOGGLE
  // ===================================================================
  if ($('theme-toggle')) $('theme-toggle').addEventListener('click', function(){
    var html = document.documentElement;
    html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // ===================================================================
  //  INIT — Overview is the default tab; Gap Zones builds on first open.
  // ===================================================================
  buildModel(); drawGraph(); updateSampleNote(); startSim();
  drawOverview(); drawMatrix();
  if (location.hash){
    var hashTab = document.querySelector('[role="tab"]#tab-' + location.hash.slice(1));
    if (hashTab) selectTab(hashTab);
  }
  window.addEventListener('resize', function(){ if ($('pane-overview') && $('pane-overview').classList.contains('active')) drawTreemap(); });
}
`;

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OrangePro · Gap Zones · __TITLE__</title>
<!-- orangepro: __META__ -->
<style>
  :root{
    --accent:#ea580c; --accent-700:#c2410c; --accent-soft:rgba(234,88,12,.16); --accent-line:rgba(234,88,12,.55); --accent-ring:#fb923c;
    --proven:#22c55e; --proven-deep:#15803d; --proven-soft:rgba(34,197,94,.13);
    --runtime:#58a6ff; --runtime-deep:#1f6feb; --runtime-soft:rgba(88,166,255,.14);
    --assoc:#f59e0b; --assoc-deep:#b45309; --assoc-soft:rgba(245,158,11,.13);
    --none:#f43f5e; --none-deep:#be123c; --none-soft:rgba(244,63,94,.14);
    --nsc:#8b98ab; --nsc-soft:rgba(139,152,171,.14);
    --bg:#0b0e13; --bg-2:#0f131a; --panel:#141a23; --panel-2:#1a212c; --panel-3:#202938;
    --border:#242d3b; --border-strong:#33405380; --ink:#eef2f7; --ink-2:#b3bdcb; --ink-3:#8590a0; --grid:#1c2431;
    --radius:12px; --radius-sm:8px; --radius-xs:6px; --shadow:0 6px 24px rgba(0,0,0,.42); --shadow-lg:0 22px 60px rgba(0,0,0,.55);
    --mono:ui-monospace,"SF Mono",SFMono-Regular,"Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; --speed:200ms;
  }
  *{ box-sizing:border-box; } html,body{ margin:0; padding:0; }
  body{
    background:radial-gradient(1100px 460px at 82% -10%, rgba(234,88,12,.10) 0%, rgba(234,88,12,0) 62%), linear-gradient(180deg, var(--bg), var(--bg-2));
    background-attachment:fixed; color:var(--ink); font-family:var(--sans); font-size:14px; line-height:1.45; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  }
  .num,.mono{ font-family:var(--mono); font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1; }
  a{ color:var(--accent-ring); }
  :focus-visible{ outline:3px solid var(--accent-ring); outline-offset:2px; border-radius:7px; }
  [tabindex]:focus:not(:focus-visible){ outline:none; }
  ::selection{ background:rgba(234,88,12,.35); }
  button{ font-family:inherit; color:inherit; }
  .wrap{ max-width:1480px; margin:0 auto; padding:16px 22px 48px; }
  .sr-only{ position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }

  .topbar{ display:flex; align-items:center; gap:14px; padding:4px 2px 14px; flex-wrap:wrap; }
  .brand{ display:flex; align-items:center; gap:11px; }
  .logo{ width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,var(--accent),#fb923c); display:grid; place-items:center; box-shadow:0 4px 14px rgba(234,88,12,.4); }
  .brand h1{ font-size:16px; margin:0; letter-spacing:-.01em; font-weight:680; }
  .brand .sub{ font-size:12px; color:var(--ink-3); }
  .ws{ margin-left:auto; display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--ink-2); background:var(--panel); border:1px solid var(--border); padding:7px 12px; border-radius:999px; box-shadow:var(--shadow); }
  .ws .dot{ width:7px; height:7px; border-radius:50%; background:var(--proven); flex:none; box-shadow:0 0 0 3px var(--proven-soft); }
  .ws b{ color:var(--ink); font-weight:600; }

  .banner{ display:none; align-items:flex-start; gap:11px; background:rgba(234,88,12,.10); border:1px solid #6b3a13; border-left:4px solid var(--accent); color:#fcd9bb; padding:11px 14px; border-radius:var(--radius-sm); margin-bottom:14px; box-shadow:var(--shadow); }
  .banner.show{ display:flex; }
  .banner svg{ flex:none; margin-top:1px; } .banner b{ color:#fff; }
  .proofbanner{ display:none; background:rgba(245,158,11,.10); border:1px solid #6b531a; border-left:4px solid var(--assoc); color:#fde6b8; padding:11px 14px; border-radius:var(--radius-sm); margin-bottom:14px; box-shadow:var(--shadow); font-weight:560; }

  .headline{ display:flex; align-items:center; gap:18px; flex-wrap:wrap; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:12px 16px; margin-bottom:12px; }
  .hl-num{ display:flex; align-items:baseline; gap:8px; }
  .hl-num .big{ font-family:var(--mono); font-size:30px; font-weight:680; color:var(--proven); letter-spacing:-.02em; }
  .hl-num .lbl{ font-size:12px; color:var(--ink-2); max-width:230px; line-height:1.35; }
  .hl-frame{ font-size:12.5px; color:var(--ink-2); line-height:1.4; max-width:560px; border-left:1px solid var(--border); padding-left:16px; }
  .hl-frame b{ color:var(--ink); font-weight:620; }
  .hl-kpis{ margin-left:auto; display:flex; gap:10px; flex-wrap:wrap; }
  .kpi{ background:var(--panel-2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:8px 12px; min-width:92px; }
  .kpi .k{ font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-3); }
  .kpi .v{ font-family:var(--mono); font-size:18px; font-weight:660; margin-top:2px; }
  .kpi.proven .v{ color:var(--proven); } .kpi.runtime .v{ color:var(--runtime); } .kpi.assoc .v{ color:var(--assoc); } .kpi.none .v{ color:var(--none); }

  .toolbar{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:9px 12px; margin-bottom:12px; }
  .search{ position:relative; display:flex; align-items:center; }
  .search svg{ position:absolute; left:10px; color:var(--ink-3); pointer-events:none; }
  .search input{ background:var(--panel-2); border:1px solid var(--border); color:var(--ink); border-radius:999px; padding:7px 12px 7px 32px; font-size:13px; width:240px; transition:border-color var(--speed); }
  .search input::placeholder{ color:var(--ink-3); } .search input:focus{ border-color:var(--accent-line); }
  .chips{ display:flex; gap:6px; align-items:center; }
  .chips .lab{ font-size:11px; color:var(--ink-3); text-transform:uppercase; letter-spacing:.06em; margin-right:2px; }
  .chip{ display:inline-flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--border); color:var(--ink-2); border-radius:999px; padding:6px 11px; font-size:12.5px; cursor:pointer; transition:background var(--speed), border-color var(--speed), opacity var(--speed); }
  .chip .gly{ width:13px; height:13px; flex:none; }
  .chip[aria-pressed="false"]{ opacity:.42; }
  .chip.proven[aria-pressed="true"]{ border-color:var(--proven-deep); background:var(--proven-soft); color:var(--proven); }
  .chip.runtime[aria-pressed="true"]{ border-color:var(--runtime-deep); background:var(--runtime-soft); color:var(--runtime); }
  .chip.assoc[aria-pressed="true"]{ border-color:var(--assoc-deep); background:var(--assoc-soft); color:var(--assoc); }
  .chip.none[aria-pressed="true"]{ border-color:var(--none-deep); background:var(--none-soft); color:var(--none); }
  .selsrc{ margin-left:auto; display:flex; align-items:center; gap:8px; }
  .selsrc select{ background:var(--panel-2); border:1px solid var(--border); color:var(--ink); border-radius:var(--radius-sm); padding:7px 10px; font-size:13px; }
  .iconbtn{ background:var(--panel-2); border:1px solid var(--border); color:var(--ink-2); border-radius:var(--radius-sm); padding:7px 9px; cursor:pointer; display:grid; place-items:center; transition:border-color var(--speed), color var(--speed); }
  .iconbtn:hover{ border-color:var(--accent-line); color:var(--ink); }

  .tabs{ display:flex; gap:4px; margin-bottom:12px; border-bottom:1px solid var(--border); }
  .tab{ background:transparent; border:1px solid transparent; border-bottom:none; color:var(--ink-3); padding:9px 16px; font-size:13.5px; font-weight:560; cursor:pointer; border-radius:9px 9px 0 0; display:inline-flex; align-items:center; gap:8px; position:relative; top:1px; transition:color var(--speed), background var(--speed); }
  .tab:hover{ color:var(--ink); }
  .tab[aria-selected="true"]{ color:var(--ink); background:var(--panel); border-color:var(--border); }
  .tab[aria-selected="true"]::after{ content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px; background:var(--accent); }

  .panel{ background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); }
  .stagewrap{ display:grid; grid-template-columns:1fr 312px; gap:12px; align-items:stretch; }
  @media (max-width:1100px){ .stagewrap{ grid-template-columns:1fr; } }
  .tabpane{ display:none; } .tabpane.active{ display:block; }

  .heroGrid{ display:grid; grid-template-columns:196px 1fr; gap:0; }
  @media (max-width:760px){ .heroGrid{ grid-template-columns:1fr; } }
  .rail{ border-right:1px solid var(--border); padding:14px; display:flex; flex-direction:column; gap:14px; }
  @media (max-width:760px){ .rail{ border-right:none; border-bottom:1px solid var(--border); } }
  .rail h3{ font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink-3); margin:0 0 8px; }
  .legend-row{ display:flex; align-items:flex-start; gap:9px; margin-bottom:9px; font-size:12px; }
  .legend-row .gly{ width:16px; height:16px; flex:none; margin-top:1px; }
  .legend-row .lt{ font-weight:600; color:var(--ink); } .legend-row .ld{ color:var(--ink-3); font-size:11px; }
  .areafilters{ display:flex; flex-direction:column; gap:4px; max-height:230px; overflow-y:auto; }
  .areabtn{ text-align:left; background:transparent; border:1px solid transparent; color:var(--ink-2); border-radius:var(--radius-xs); padding:5px 8px; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:7px; transition:background var(--speed), border-color var(--speed); }
  .areabtn:hover{ background:var(--panel-2); }
  .areabtn[aria-pressed="true"]{ background:var(--accent-soft); border-color:var(--accent-line); color:var(--ink); }
  .areabtn .sw{ width:8px; height:8px; border-radius:2px; background:var(--accent); flex:none; }
  .areabtn .ct{ margin-left:auto; font-family:var(--mono); font-size:10.5px; color:var(--ink-3); }
  .explain{ font-size:11.5px; color:var(--ink-2); line-height:1.5; } .explain b{ color:var(--ink); }

  .stage{ position:relative; }
  #forceSvg{ display:block; width:100%; height:560px; touch-action:none; cursor:grab; background:radial-gradient(900px 380px at 84% 50%, rgba(244,63,94,.05), rgba(244,63,94,0) 60%); }
  #forceSvg.grabbing{ cursor:grabbing; }
  .zoneLabel{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; font-weight:700; }
  .zoneSub{ font-size:10px; }
  .hub-label{ font-size:11px; font-weight:620; fill:var(--ink); paint-order:stroke; stroke:var(--bg); stroke-width:3px; }
  .node-focus{ outline:none; cursor:pointer; }
  .sample-note{ position:absolute; left:12px; bottom:10px; font-size:11px; color:var(--ink-2); background:rgba(11,14,19,.78); border:1px solid var(--border); border-radius:999px; padding:4px 11px; backdrop-filter:blur(3px); }
  .zoomctl{ position:absolute; right:12px; bottom:10px; display:flex; gap:6px; }
  .zoomctl .iconbtn svg{ width:15px; height:15px; }

  .tip{ position:fixed; z-index:60; pointer-events:none; max-width:280px; background:var(--panel-2); border:1px solid var(--border-strong); border-radius:var(--radius-sm); box-shadow:var(--shadow-lg); padding:10px 12px; font-size:12px; color:var(--ink-2); opacity:0; transform:translateY(4px); transition:opacity 120ms, transform 120ms; }
  .tip.show{ opacity:1; transform:translateY(0); }
  .tip .tt{ font-weight:660; color:var(--ink); font-size:13px; margin-bottom:5px; display:flex; align-items:center; gap:7px; }
  .tip .trow{ display:flex; justify-content:space-between; gap:16px; margin-top:2px; } .tip .trow .v{ font-family:var(--mono); }

  .drill{ padding:14px; display:flex; flex-direction:column; min-height:560px; }
  .drill .dh{ display:flex; align-items:center; gap:9px; margin-bottom:4px; }
  .drill .dh .sw{ width:10px; height:10px; border-radius:3px; background:var(--accent); flex:none; }
  .drill .dh h2{ font-size:14px; margin:0; }
  .drill .dsub{ font-size:11.5px; color:var(--ink-3); margin-bottom:12px; }
  .drill .dmini{ display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  .dmini .seg{ flex:1; min-width:54px; border:1px solid var(--border); border-radius:var(--radius-xs); padding:6px 8px; background:var(--panel-2); }
  .dmini .seg .k{ font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-3); }
  .dmini .seg .v{ font-family:var(--mono); font-size:15px; font-weight:640; margin-top:1px; }
  .dmini .seg.proven .v{ color:var(--proven); } .dmini .seg.runtime .v{ color:var(--runtime); } .dmini .seg.assoc .v{ color:var(--assoc); } .dmini .seg.none .v{ color:var(--none); }
  .gaplist{ display:flex; flex-direction:column; gap:9px; overflow-y:auto; padding-right:2px; }
  .gaprow{ display:block; width:100%; text-align:left; background:var(--panel-2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:9px 10px; }
  .gaprow:hover{ border-color:var(--border-strong); }
  .gaprow .top{ display:flex; align-items:center; gap:8px; margin-bottom:7px; }
  .gaprow .gly{ width:13px; height:13px; flex:none; }
  .gaprow .gt{ font-size:12.5px; font-weight:600; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gaprow .gf{ font-family:var(--mono); font-size:10.5px; color:var(--ink-3); margin-bottom:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gaprow .gtag{ font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; opacity:.92; }
  .churn{ font-size:9.5px; font-weight:600; padding:1px 6px; border-radius:999px; text-transform:uppercase; letter-spacing:.04em; }
  .churn.high{ background:var(--none-soft); color:var(--none); } .churn.med{ background:var(--assoc-soft); color:var(--assoc); } .churn.low{ background:var(--nsc-soft); color:var(--nsc); }
  .empty{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--ink-3); text-align:center; padding:40px 16px; flex:1; }
  .empty svg{ opacity:.5; }

  .ovgrid{ display:grid; grid-template-columns:280px 1fr; gap:12px; }
  @media (max-width:900px){ .ovgrid{ grid-template-columns:1fr; } }
  .card{ padding:16px; }
  .card h3{ font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-3); margin:0 0 12px; }
  .donutwrap{ display:flex; flex-direction:column; align-items:center; gap:14px; }
  .splitbar{ margin-top:6px; }
  .splitbar .track{ display:flex; height:26px; border-radius:7px; overflow:hidden; border:1px solid var(--border); }
  .splitbar .seg{ display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:11px; font-weight:600; color:#0b0e13; min-width:2px; }
  .splitbar .legend{ display:flex; justify-content:space-between; margin-top:8px; gap:8px; font-size:11px; flex-wrap:wrap; }
  .splitbar .legend span{ display:inline-flex; align-items:center; gap:6px; color:var(--ink-2); }
  .splitbar .legend .dotc{ width:9px; height:9px; border-radius:3px; flex:none; }
  .treemap{ position:relative; width:100%; }
  .tile{ position:absolute; border-radius:6px; overflow:hidden; cursor:pointer; border:1px solid rgba(0,0,0,.35); transition:transform var(--speed), filter var(--speed); display:flex; flex-direction:column; justify-content:space-between; padding:8px 9px; }
  .tile:hover{ filter:brightness(1.12); transform:translateY(-1px); z-index:5; }
  .tile .tn{ font-size:11.5px; font-weight:660; color:#fff; text-shadow:0 1px 3px rgba(0,0,0,.6); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tile .tm{ display:flex; height:5px; border-radius:3px; overflow:hidden; }
  .tile .tc{ font-family:var(--mono); font-size:10px; color:rgba(255,255,255,.92); text-shadow:0 1px 2px rgba(0,0,0,.7); }

  .mxtable{ width:100%; border-collapse:separate; border-spacing:0; font-size:12.5px; }
  .mxtable caption{ text-align:left; font-size:12px; color:var(--ink-3); margin-bottom:8px; }
  .mxtable th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-3); font-weight:600; padding:7px 9px; }
  .mxtable th.cnum{ text-align:center; }
  .mxtable td{ padding:5px 7px; border-top:1px solid var(--border); }
  .mxtable .rname{ font-size:12.5px; font-weight:560; }
  .mxtable .rname .lg{ font-family:var(--mono); font-size:10px; color:var(--ink-3); margin-left:6px; }
  .mxcell{ position:relative; height:30px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:11.5px; font-weight:600; cursor:pointer; gap:5px; }
  .mxcell .gly{ width:11px; height:11px; flex:none; }
  .mxcell:hover{ outline:2px solid var(--accent-line); outline-offset:-2px; }
  .pctcell{ font-family:var(--mono); font-weight:660; text-align:right; padding-right:12px !important; }
  .langstrip{ margin-top:6px; }
  .lsrow{ display:grid; grid-template-columns:170px 1fr 56px; gap:10px; align-items:center; margin-bottom:8px; }
  .lsrow .ln{ font-size:12px; }
  .lsrow .ln .hp{ font-size:9.5px; font-weight:700; padding:1px 5px; border-radius:4px; margin-left:6px; vertical-align:1px; }
  .hp.hard{ background:var(--proven-soft); color:var(--proven); } .hp.assoc{ background:var(--nsc-soft); color:var(--nsc); }
  .lstrack{ display:flex; height:18px; border-radius:5px; overflow:hidden; border:1px solid var(--border); }
  .lstrack .s{ height:100%; }
  .lstotal{ font-family:var(--mono); font-size:11px; color:var(--ink-2); text-align:right; }

  .footer{ margin-top:18px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:11.5px; color:var(--ink-3); padding:12px 4px 0; border-top:1px solid var(--border); }
  .footer .lock{ display:inline-flex; align-items:center; gap:6px; }
  .footer .sep{ width:3px; height:3px; border-radius:50%; background:var(--ink-3); }
  .footer b{ color:var(--ink-2); }
  .whatcounts{ font-size:11.5px; color:var(--ink-2); display:inline-flex; align-items:center; gap:7px; }
  .whatcounts svg{ color:var(--accent-ring); flex:none; }
  #loading-msg{ padding:40px; text-align:center; color:var(--ink-3); font-size:14px; }
  html[data-theme="light"]{ --bg:#f4f5f7; --bg-2:#eceef1; --panel:#ffffff; --panel-2:#f6f8fa; --panel-3:#e7eaef; --border:#dde1e7; --border-strong:#c6cdd6; --ink:#161b22; --ink-2:#3d4756; --ink-3:#5e6979; --grid:#e6e9ee; --proven:#15803d; --runtime:#1f6feb; --assoc:#b45309; --none:#be123c; --proven-soft:rgba(21,128,61,.12); --runtime-soft:rgba(31,111,235,.12); --assoc-soft:rgba(180,83,9,.12); --none-soft:rgba(190,18,60,.12); --nsc-soft:rgba(94,107,125,.14); }
  @media (prefers-reduced-motion: reduce){ *{ transition:none !important; animation:none !important; } }
</style>
</head>
<body data-generated="__GENERATED__">

<div id="loading-msg">Loading visualization…</div>

<div class="wrap" id="app" style="display:none">

  <div class="topbar">
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3.2"/><circle cx="5" cy="6" r="1.7"/><circle cx="19" cy="6" r="1.7"/><circle cx="19" cy="18" r="1.7"/>
          <path d="M9.4 10.4 6.2 7.2M14.6 10.4l3-3M14.4 13.6l3 3"/>
        </svg>
      </div>
      <div><h1>OrangePro · Gap Zones</h1><div class="sub">Offline coverage-gap explorer · metadata only</div></div>
    </div>
    <div class="ws" aria-label="Workspace status">
      <span class="dot" aria-hidden="true"></span>
      <span>workspace <b id="ws-name">__TITLE__</b></span>
    </div>
  </div>

  <div class="banner" id="partial-banner" role="status">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
    <div><b>Partial scan.</b> <span id="banner-text"></span> Coverage below is incomplete — re-run a full scan for fresh numbers.</div>
  </div>
  <div class="proofbanner" id="proof-banner" role="status"></div>

  <div class="headline">
    <div class="hl-num">
      <span class="big num" id="hl-pct">0%</span>
      <span class="lbl">proven over <span class="num" id="hl-denom">0</span> real-code units</span>
    </div>
    <div class="hl-frame">
      A small proven % is the point: a behavior is <b>proven</b> only when a dynamic targeted proof certificate closes it.
      The rest is <b>runtime-covered</b>, a <b>weak signal</b>, or <b>no link</b> — not "untested," just not yet proven. The hero is the gap zone on the right.
    </div>
    <div class="hl-kpis">
      <div class="kpi proven"><div class="k">Dynamic Proven</div><div class="v num" id="kpi-proven">0</div></div>
      <div class="kpi runtime"><div class="k">Runtime</div><div class="v num" id="kpi-runtime">0</div></div>
      <div class="kpi assoc"><div class="k">Associated</div><div class="v num" id="kpi-assoc">0</div></div>
      <div class="kpi none"><div class="k">No&nbsp;link</div><div class="v num" id="kpi-none">0</div></div>
    </div>
  </div>

  <div class="toolbar" role="toolbar" aria-label="Filters">
    <div class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="search" type="search" placeholder="Filter areas…" aria-label="Filter areas by name" autocomplete="off" />
    </div>
    <div class="chips" role="group" aria-label="Tier filters">
      <span class="lab">Tiers</span>
      <button class="chip proven" data-tier="proven" aria-pressed="true"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="var(--proven)"/></svg>Dynamic Proven</button>
      <button class="chip runtime" data-tier="runtime" aria-pressed="true"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="var(--runtime)"/></svg>Runtime</button>
      <button class="chip assoc" data-tier="associated" aria-pressed="true"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="var(--assoc)" stroke-width="2.2"/></svg>Associated</button>
      <button class="chip none" data-tier="none" aria-pressed="true"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="var(--none)" stroke-width="2.2"/></svg>No&nbsp;link</button>
    </div>
    <div class="selsrc">
      <label class="sr-only" for="lang-filter">Language filter</label>
      <select id="lang-filter" aria-label="Filter by language"><option value="">All languages</option></select>
      <button class="iconbtn" id="theme-toggle" aria-label="Toggle light / dark theme" title="Toggle theme">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
    </div>
  </div>

  <div class="tabs" role="tablist" aria-label="Coverage views">
    <button class="tab" role="tab" id="tab-zones" aria-controls="pane-zones" aria-selected="false" tabindex="-1">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.1 11l7.8-3.5M8.1 13l7.8 3.5"/></svg>
      Gap Zones</button>
    <button class="tab" role="tab" id="tab-overview" aria-controls="pane-overview" aria-selected="true" tabindex="0">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>
      Overview</button>
    <button class="tab" role="tab" id="tab-matrix" aria-controls="pane-matrix" aria-selected="false" tabindex="-1">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>
      Matrix</button>
  </div>

  <div class="stagewrap">
    <div>
      <!-- TAB 1: GAP ZONES -->
      <div class="tabpane panel" id="pane-zones" role="tabpanel" aria-labelledby="tab-zones" tabindex="0">
        <div class="heroGrid">
          <div class="rail">
            <div>
              <h3>Tiers</h3>
              <div class="legend-row"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="var(--proven)"/></svg><div><div class="lt">Dynamic Proven</div><div class="ld">disc · dynamic targeted proof</div></div></div>
              <div class="legend-row"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="var(--runtime)"/></svg><div><div class="lt">Runtime-covered</div><div class="ld">disc · executed by coverage, not proof</div></div></div>
              <div class="legend-row"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="var(--assoc)" stroke-width="2.4"/></svg><div><div class="lt">Associated</div><div class="ld">ring · weak signal, not proof</div></div></div>
              <div class="legend-row"><svg class="gly" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.4" fill="none" stroke="var(--none)" stroke-width="2.2"/><circle cx="8" cy="8" r="7" fill="none" stroke="var(--none)" stroke-width="1" opacity=".55"/></svg><div><div class="lt">No link</div><div class="ld">glowing ring · no test signal</div></div></div>
            </div>
            <div><h3>Code areas</h3><div class="areafilters" id="areafilters"></div></div>
            <div class="explain">
              <b>Tier definitions.</b> Proven = dynamic targeted mutation proof recorded in the local ledger, not static matching or LLM. Runtime-covered = executed by a repo coverage report. Associated signal = name/path/import/structural matching only, not semantic proof. No link = no direct static or runtime signal found. Broad e2e or integration coverage may still exist.
            </div>
          </div>
          <div class="stage" id="stage">
            <svg id="forceSvg" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gap zones: code areas as hubs with sampled symbols placed in covered, associated, and no-link zones">
              <defs>
                <filter id="redGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
                <filter id="hubGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              </defs>
              <g id="viewport"><g id="zonesLayer"></g><g id="linksLayer"></g><g id="hubsLayer"></g><g id="dotsLayer"></g></g>
            </svg>
            <div class="sample-note num" id="sample-note">showing 0 of 0 symbols</div>
            <div class="zoomctl">
              <button class="iconbtn" id="zoom-in" aria-label="Zoom in"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
              <button class="iconbtn" id="zoom-out" aria-label="Zoom out"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
              <button class="iconbtn" id="zoom-reset" aria-label="Reset view"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/></svg></button>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 2: OVERVIEW -->
      <div class="tabpane active panel" id="pane-overview" role="tabpanel" aria-labelledby="tab-overview" tabindex="0">
        <div class="ovgrid">
          <div class="card">
            <h3>Proven share</h3>
            <div class="donutwrap">
              <svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label="Proven share of real-code denominator">
                <circle cx="90" cy="90" r="68" fill="none" stroke="var(--panel-3)" stroke-width="20"/>
                <circle id="donutArc" cx="90" cy="90" r="68" fill="none" stroke="var(--proven)" stroke-width="20" stroke-linecap="round" transform="rotate(-90 90 90)" stroke-dasharray="0 999"/>
                <text x="90" y="84" text-anchor="middle" class="num" font-size="30" font-weight="680" fill="var(--proven)" id="donutPct">0%</text>
                <text x="90" y="104" text-anchor="middle" font-size="11" fill="var(--ink-3)">proven</text>
              </svg>
              <div class="splitbar" style="width:100%">
                <div class="track" id="splitTrack" aria-hidden="true"></div>
                <div class="legend">
                  <span><span class="dotc" style="background:var(--proven)"></span>Proven <b class="num" id="sb-proven">0</b></span>
                  <span><span class="dotc" style="background:var(--runtime)"></span>Runtime <b class="num" id="sb-runtime">0</b></span>
                  <span><span class="dotc" style="background:var(--assoc)"></span>Assoc <b class="num" id="sb-assoc">0</b></span>
                  <span><span class="dotc" style="background:var(--none)"></span>No link <b class="num" id="sb-none">0</b></span>
                </div>
              </div>
            </div>
          </div>
          <div class="card">
            <h3>Gap heatmap — code areas (size = real-code units, fill = tier mix)</h3>
            <div class="treemap" id="treemap" role="group" aria-label="Treemap of code areas by coverage"></div>
          </div>
        </div>
      </div>

      <!-- TAB 3: MATRIX -->
      <div class="tabpane panel" id="pane-matrix" role="tabpanel" aria-labelledby="tab-matrix" tabindex="0">
        <div class="card">
          <table class="mxtable" id="mxtable">
            <caption>Code behavior evidence by language — area × tier; cell shows count &amp; tier glyph; click to drill. Proven% over the area's real-code units.</caption>
            <thead><tr>
              <th scope="col">Code area</th>
              <th scope="col" class="cnum">Dynamic Proven</th>
              <th scope="col" class="cnum">Runtime</th>
              <th scope="col" class="cnum">Associated</th>
              <th scope="col" class="cnum">No&nbsp;link</th>
              <th scope="col" style="text-align:right">Proven&nbsp;%</th>
            </tr></thead>
            <tbody id="mxbody"></tbody>
          </table>
        </div>
        <div class="card" style="margin-top:12px">
          <h3>Area × language — tier split (test files excluded)</h3>
          <div class="langstrip" id="langstrip"></div>
        </div>
      </div>
    </div>

    <!-- SHARED DRILL PANEL -->
    <div class="panel">
      <div class="drill" id="drill">
        <div class="empty" id="drillEmpty">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <div>Click a code-area hub, a dot, a treemap tile, or a matrix cell to see that area's real uncovered symbols.</div>
        </div>
        <div id="drillContent" hidden>
          <div class="dh"><span class="sw" id="drillSw"></span><h2 id="drillTitle">—</h2></div>
          <div class="dsub" id="drillSub">—</div>
          <div class="dmini">
            <div class="seg proven"><div class="k">Dynamic Proven</div><div class="v num" id="dm-proven">0</div></div>
            <div class="seg runtime"><div class="k">Runtime</div><div class="v num" id="dm-runtime">0</div></div>
            <div class="seg assoc"><div class="k">Assoc</div><div class="v num" id="dm-assoc">0</div></div>
            <div class="seg none"><div class="k">No link</div><div class="v num" id="dm-none">0</div></div>
          </div>
          <h3 style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin:0 0 9px">Uncovered symbols — no proven test (sampled, worst first)</h3>
          <div class="gaplist" id="gaplist"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    <span class="whatcounts">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
      What counts: real code symbols only — <b>test files are excluded</b> from the denominator (they appear only as proof links).
    </span>
    <span class="sep" aria-hidden="true"></span>
    <span class="lock">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>
      Metadata only, generated locally
    </span>
    <span class="sep" aria-hidden="true"></span>
    <span>workspace <b id="ft-ws">__TITLE__</b></span>
    <span class="sep" aria-hidden="true"></span>
    <span>generated <b class="num" id="ft-date">—</b></span>
  </div>
</div>

<div class="tip" id="tip" role="tooltip" aria-hidden="true"></div>

<script>/*__D3__*/</script>
<script>
const DATA="__DATA__";
/*__VIZ_LOGIC__*/
</script>
</body>
</html>`;
