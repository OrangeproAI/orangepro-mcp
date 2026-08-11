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
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json() as Record<string, unknown>;

      // Validate required fields
      const { event, v, lang, files, os, node, ts } = body;
      if (!event || !v) {
        return new Response("Bad request", { status: 400 });
      }

      // Insert into D1 — intentionally NOT storing IP
      await env.DB.prepare(
        `INSERT INTO pings (event, version, lang, file_bucket, os, node_version, ts, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
        .bind(
          String(event),
          String(v || ""),
          String(lang || ""),
          String(files || ""),
          String(os || ""),
          String(node || ""),
          String(ts || "")
        )
        .run();

      return new Response("ok", {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    } catch {
      return new Response("Internal error", { status: 500 });
    }
  },
};
