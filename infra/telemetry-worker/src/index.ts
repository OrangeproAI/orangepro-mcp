/**
 * Cloudflare Worker: telemetry.orangepro.ai (v2)
 *
 * 1. Accepts POST /v1/ping — stores in D1
 * 2. Cron (hourly) — sends Discord notification if new pings landed
 */

export interface Env {
  DB: D1Database;
}

const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1537387505614331964/rOFeOVa1fFho3xxqS5pEKiDPzSSKS0mjaws4wurxgzFHjMKQZEWsvNguqNU7iaLoYHhL"; // ← paste yours

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
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
      const row = await env.DB.prepare(
        "SELECT COUNT(*) as c, COUNT(DISTINCT lang) as langs FROM pings WHERE ts > datetime('now', '-1 hour')"
      ).first<{ c: number; langs: number }>();

      if (row && row.c > 0) {
        const detail = await env.DB.prepare(
          "SELECT lang, COUNT(*) as n, AVG(duration_ms) as avg_ms FROM pings WHERE ts > datetime('now', '-1 hour') GROUP BY lang"
        ).all();

        const lines = (detail.results || []).map(
          (r: any) => `• ${r.lang}: ${r.n} run(s), avg ${r.avg_ms ? Math.round(r.avg_ms / 1000) + "s" : "n/a"}`
        );

        await fetch(DISCORD_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🟠 ${row.c} OrangePro MCP scan(s) in the last hour (${row.langs} language(s)):\n${lines.join("\n")}`
          })
        });
      }
    } catch {
      // cron must never throw
    }
  }
};
