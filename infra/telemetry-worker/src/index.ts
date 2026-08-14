/**
 * Cloudflare Worker: telemetry.orangepro.ai (v3)
 *
 * 1. POST /v1/ping — stores telemetry in D1
 * 2. Cron triggers:
 *    - Every hour: one-liner if new pings
 *    - Every 12h (0:00, 12:00 UTC): summary table
 *    - Daily at 9:00 UTC: full 24h entry table
 */

export interface Env {
  DB: D1Database;
}

const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1537387505614331964/rOFeOVa1fFho3xxqS5pEKiDPzSSKS0mjaws4wurxgzFHjMKQZEWsvNguqNU7iaLoYHhL";

async function sendDiscord(content: string): Promise<void> {
  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

function fmtDuration(ms: number | null): string {
  if (!ms) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

// ─── Hourly: compact one-liner ───────────────────────────────────────────────
async function hourlyNotification(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM pings WHERE ts > datetime('now', '-1 hour')"
  ).first<{ c: number }>();

  if (!row || row.c === 0) return;

  const langs = await env.DB.prepare(
    `SELECT lang, COUNT(*) as n, MAX(file_bucket) as largest_repo
     FROM pings WHERE ts > datetime('now', '-1 hour')
     GROUP BY lang ORDER BY n DESC`
  ).all();

  const langParts = (langs.results || []).map(
    (r: any) => `${r.n} ${r.lang}`
  );

  const largest = (langs.results || []).reduce(
    (max: string, r: any) => {
      const order = ["1-49", "50-199", "200-499", "500-4999", "5000+"];
      return order.indexOf(r.largest_repo) > order.indexOf(max) ? r.largest_repo : max;
    }, "1-49"
  );

  const byok = await env.DB.prepare(
    "SELECT SUM(has_byok) as k FROM pings WHERE ts > datetime('now', '-1 hour')"
  ).first<{ k: number }>();

  let msg = `🟠 **${row.c} scan(s)** in the last hour: ${langParts.join(", ")}. Largest repo: ${largest} files.`;
  if (byok && byok.k > 0) msg += ` ${byok.k} with BYOK.`;

  await sendDiscord(msg);
}

// ─── 12-hour summary table ──────────────────────────────────────────────────
async function twelveHourSummary(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM pings WHERE ts > datetime('now', '-12 hours')"
  ).first<{ c: number }>();

  if (!row || row.c === 0) return;

  const summary = await env.DB.prepare(
    `SELECT
       lang,
       COUNT(*) as runs,
       SUM(has_byok) as byok_count,
       ROUND(AVG(duration_ms)) as avg_ms,
       MAX(file_bucket) as largest_repo,
       MAX(behaviors) as max_behaviors,
       COUNT(DISTINCT version) as versions_seen
     FROM pings
     WHERE ts > datetime('now', '-12 hours')
     GROUP BY lang
     ORDER BY runs DESC`
  ).all();

  let table = "```\n";
  table += "Lang        | Runs | BYOK | Avg Time | Largest | Behaviors\n";
  table += "------------|------|------|----------|---------|----------\n";

  for (const r of (summary.results || []) as any[]) {
    const lang = (r.lang || "unknown").padEnd(11);
    const runs = String(r.runs).padEnd(4);
    const byok = String(r.byok_count || 0).padEnd(4);
    const avgTime = fmtDuration(r.avg_ms).padEnd(8);
    const largest = (r.largest_repo || "n/a").padEnd(7);
    const behaviors = (r.max_behaviors || "n/a").padEnd(9);
    table += `${lang} | ${runs} | ${byok} | ${avgTime} | ${largest} | ${behaviors}\n`;
  }
  table += "```";

  await sendDiscord(`📊 **12-hour summary** (${row.c} total scans):\n${table}`);
}

// ─── Daily full table (24h entries) ─────────────────────────────────────────
async function dailyFullTable(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT ts, version, lang, file_bucket, behaviors, has_byok, duration_ms, os
     FROM pings
     WHERE ts > datetime('now', '-24 hours')
     ORDER BY ts DESC
     LIMIT 50`
  ).all();

  if (!rows.results || rows.results.length === 0) {
    await sendDiscord("📋 **Daily report**: No scans in the last 24 hours.");
    return;
  }

  let table = "```\n";
  table += "Time  | Ver    | Lang       | Files   | Behav   | BYOK | Duration | OS\n";
  table += "------|--------|------------|---------|---------|------|----------|------\n";

  for (const r of rows.results as any[]) {
    const time = r.ts ? String(r.ts).slice(11, 16) : "??:??";
    const ver = (r.version || "?").slice(0, 6).padEnd(6);
    const lang = (r.lang || "?").slice(0, 10).padEnd(10);
    const files = (r.file_bucket || "?").padEnd(7);
    const behav = (r.behaviors || "n/a").slice(0, 7).padEnd(7);
    const byok = r.has_byok ? "Y" : "N";
    const dur = fmtDuration(r.duration_ms).padEnd(8);
    const os = (r.os || "?").slice(0, 6);
    table += `${time} | ${ver} | ${lang} | ${files} | ${behav} | ${byok}    | ${dur} | ${os}\n`;
  }
  table += "```";

  const total = rows.results.length;
  const byokTotal = rows.results.filter((r: any) => r.has_byok).length;
  const header = `📋 **Daily report** — ${total} scans in 24h, ${byokTotal} with BYOK (${Math.round(byokTotal / total * 100)}% conversion potential):`;

  await sendDiscord(`${header}\n${table}`);
}

// ─── Main exports ───────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/v1/ping") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const body = (await request.json()) as Record<string, unknown>;

      const event = String(body.event || "run");
      const v = String(body.v || "unknown");
      const lang = String(body.lang || "unknown");
      const files = String(body.files || "unknown");
      const os = String(body.os || "unknown");
      const node = String(body.node || "unknown");
      const behaviors = body.behaviors != null ? String(body.behaviors) : null;
      const has_byok = body.has_byok != null ? Number(body.has_byok) : 0;
      const report = body.report != null ? Number(body.report) : 1;
      const duration_ms = body.duration_ms != null ? Number(body.duration_ms) : null;

      await env.DB.prepare(
        `INSERT INTO pings (event, version, lang, file_bucket, os, node_version, ts, received_at, behaviors, has_byok, report, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)`
      )
        .bind(event, v, lang, files, os, node, behaviors, has_byok, report, duration_ms)
        .run();

      return new Response("ok", {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    } catch (e) {
      return new Response("error", { status: 500 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const hour = new Date(event.scheduledTime).getUTCHours();

      // Daily full table at 9:00 UTC (2:00 AM PDT)
      if (hour === 9) {
        await dailyFullTable(env);
        return;
      }

      // 12-hour summary at 0:00 and 12:00 UTC
      if (hour === 0 || hour === 12) {
        await twelveHourSummary(env);
        return;
      }

      // All other hours: compact one-liner
      await hourlyNotification(env);
    } catch {
      // cron must never throw
    }
  },
};
