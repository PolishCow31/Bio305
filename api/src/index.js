/* Bio 305 API — Cloudflare Worker.
   - Cross-device sync: whole-blob LWW, server-clock-ordered (kills client-clock skew).
   - Deep-grade queue: frontend enqueues a Problem answer; the local `claude -p` relay
     drains /jobs and posts results; frontend polls /grade/:id.
   Auth: x-app-secret == APP_SECRET for client routes; x-relay-secret == RELAY_SECRET for relay routes.
   CORS: allows the GitHub Pages origin + localhost dev. */

const ALLOWED_ORIGINS = [
  "https://polishcow.github.io",
  "http://localhost:8456",
  "http://127.0.0.1:8456",
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-app-secret,x-relay-secret",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", ...cors(origin) },
  });

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const appOK = () => env.APP_SECRET && req.headers.get("x-app-secret") === env.APP_SECRET;
    const relayOK = () => env.RELAY_SECRET && req.headers.get("x-relay-secret") === env.RELAY_SECRET;

    try {
      if (path === "/" || path === "/health") return json({ ok: true, service: "bio305-api" }, 200, origin);

      // ---- SYNC ----
      if (path === "/sync" && req.method === "GET") {
        if (!appOK()) return json({ error: "unauthorized" }, 401, origin);
        const account = url.searchParams.get("account") || "default";
        const row = await env.DB.prepare("SELECT blob, updated_at FROM profiles WHERE account=?")
          .bind(account).first();
        return json(row ? { blob: row.blob, updatedAt: row.updated_at } : { blob: null, updatedAt: 0 }, 200, origin);
      }
      if (path === "/sync" && req.method === "POST") {
        if (!appOK()) return json({ error: "unauthorized" }, 401, origin);
        const body = await req.json();
        const account = body.account || "default";
        const blob = typeof body.blob === "string" ? body.blob : JSON.stringify(body.blob || {});
        const now = Date.now(); // SERVER clock = the LWW key
        await env.DB.prepare(
          "INSERT INTO profiles(account,blob,updated_at) VALUES(?,?,?) " +
          "ON CONFLICT(account) DO UPDATE SET blob=excluded.blob, updated_at=excluded.updated_at"
        ).bind(account, blob, now).run();
        return json({ ok: true, updatedAt: now }, 200, origin);
      }

      // ---- DEEP GRADE (enqueue + poll) ----
      if (path === "/grade" && req.method === "POST") {
        if (!appOK()) return json({ error: "unauthorized" }, 401, origin);
        const b = await req.json();
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO grade_jobs(id,account,card_id,question,model_answer,student_answer,status,created_at) " +
          "VALUES(?,?,?,?,?,?, 'pending', ?)"
        ).bind(id, b.account || "default", b.card_id || "", b.question || "",
               b.model_answer || "", b.student_answer || "", Date.now()).run();
        return json({ id, status: "pending" }, 200, origin);
      }
      if (path.startsWith("/grade/") && req.method === "GET") {
        if (!appOK()) return json({ error: "unauthorized" }, 401, origin);
        const id = path.split("/")[2];
        const row = await env.DB.prepare(
          "SELECT status,verdict,score,note FROM grade_jobs WHERE id=?").bind(id).first();
        return json(row || { status: "unknown" }, 200, origin);
      }

      // ---- RELAY (drained by the local claude -p job) ----
      if (path === "/jobs" && req.method === "GET") {
        if (!relayOK()) return json({ error: "unauthorized" }, 401, origin);
        const { results } = await env.DB.prepare(
          "SELECT id,card_id,question,model_answer,student_answer FROM grade_jobs " +
          "WHERE status='pending' ORDER BY created_at LIMIT 10").all();
        return json({ jobs: results || [] }, 200, origin);
      }
      if (path.match(/^\/jobs\/[^/]+\/result$/) && req.method === "POST") {
        if (!relayOK()) return json({ error: "unauthorized" }, 401, origin);
        const id = path.split("/")[2];
        const b = await req.json();
        await env.DB.prepare(
          "UPDATE grade_jobs SET status=?, verdict=?, score=?, note=?, graded_at=? WHERE id=?"
        ).bind(b.error ? "error" : "done", b.verdict || null,
               b.score != null ? b.score : null, b.note || null, Date.now(), id).run();
        return json({ ok: true }, 200, origin);
      }

      return json({ error: "not found", path }, 404, origin);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, origin);
    }
  },
};
