import { neon } from "@neondatabase/serverless";
import { createHash, timingSafeEqual } from "node:crypto";

// Must match the ids in public/index.html, in official order.
const KID_IDS = ["nathan", "jordan", "avery", "carter", "david"];
const DEFAULT_SATISFACTION = 5.0;
const MAX_NEWS_TEXT = 140;

const sql = neon(process.env.DATABASE_URL);
const PASSCODE = process.env.ADMIN_PASSCODE || "";

let ready;
function init() {
  ready ??= sql.transaction([
    sql`CREATE TABLE IF NOT EXISTS kids (
          id text PRIMARY KEY,
          position int NOT NULL,
          satisfaction numeric(3,1) NOT NULL DEFAULT 5.0
        )`,
    sql`CREATE TABLE IF NOT EXISTS news (
          id serial PRIMARY KEY,
          kid text NOT NULL REFERENCES kids(id),
          kind text NOT NULL CHECK (kind IN ('good', 'bad')),
          text text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`,
    sql`INSERT INTO kids (id, position, satisfaction)
        SELECT id, pos - 1, ${DEFAULT_SATISFACTION}
        FROM unnest(${KID_IDS}::text[]) WITH ORDINALITY AS t(id, pos)
        ON CONFLICT (id) DO NOTHING`,
  ]).catch(err => { ready = undefined; throw err; });
  return ready;
}

async function readState() {
  const [kids, news] = await sql.transaction([
    sql`SELECT id, satisfaction FROM kids ORDER BY position, id`,
    sql`SELECT id, kid, kind, text, created_at FROM news ORDER BY created_at DESC, id DESC LIMIT 100`,
  ]);
  return {
    order: kids.map(k => k.id),
    satisfaction: Object.fromEntries(kids.map(k => [k.id, Number(k.satisfaction)])),
    news: news.map(n => ({ id: n.id, kid: n.kid, kind: n.kind, text: n.text, at: new Date(n.created_at).getTime() })),
    locked: Boolean(PASSCODE),
  };
}

function authorized(req) {
  if (!PASSCODE) return true;
  const hash = s => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(hash(req.headers["x-passcode"] || ""), hash(PASSCODE));
}

class BadRequest extends Error {}

async function applyAction(body) {
  switch (body.action) {
    case "check":
      return;

    case "order": {
      const order = body.order;
      const valid = Array.isArray(order) && order.length === KID_IDS.length
        && new Set(order).size === KID_IDS.length && order.every(id => KID_IDS.includes(id));
      if (!valid) throw new BadRequest("Invalid order");
      await sql`UPDATE kids k SET position = v.pos - 1
                FROM unnest(${order}::text[]) WITH ORDINALITY AS v(id, pos)
                WHERE k.id = v.id`;
      return;
    }

    case "satisfaction": {
      const value = Math.round(Number(body.value) * 10) / 10;
      if (!KID_IDS.includes(body.id) || !(value >= 1 && value <= 10)) throw new BadRequest("Invalid satisfaction");
      await sql`UPDATE kids SET satisfaction = ${value} WHERE id = ${body.id}`;
      return;
    }

    case "addNews": {
      const text = String(body.text || "").trim().slice(0, MAX_NEWS_TEXT);
      if (!KID_IDS.includes(body.kid) || !["good", "bad"].includes(body.kind) || !text) throw new BadRequest("Invalid news item");
      await sql`INSERT INTO news (kid, kind, text) VALUES (${body.kid}, ${body.kind}, ${text})`;
      return;
    }

    case "deleteNews": {
      if (!Number.isInteger(body.id)) throw new BadRequest("Invalid news id");
      await sql`DELETE FROM news WHERE id = ${body.id}`;
      return;
    }

    case "reset":
      await sql`UPDATE kids SET satisfaction = ${DEFAULT_SATISFACTION},
                  position = array_position(${KID_IDS}::text[], id) - 1`;
      return;

    default:
      throw new BadRequest("Unknown action");
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    await init();
    if (req.method === "GET") return res.status(200).json(await readState());
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!authorized(req)) return res.status(401).json({ error: "Wrong passcode" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    await applyAction(body);
    return res.status(200).json(await readState());
  } catch (err) {
    if (err instanceof BadRequest || err instanceof SyntaxError) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
