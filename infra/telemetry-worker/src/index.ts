/**
 * Cloudflare Worker: telemetry.orangepro.ai (v2)
 *
 * Accepts POST /v1/ping with expanded payload.
 * Stores in D1 database orangepro-telemetry.
 */

export interface Env {
  DB: D1Database;
}

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
};
