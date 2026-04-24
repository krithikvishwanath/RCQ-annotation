import crypto from "node:crypto";
import { ensureSchema } from "../../../lib/server/schema";
import { getSql } from "../../../lib/server/db";

export const runtime = "nodejs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isValidName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.length > 80) return false;
  return true;
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const nameRaw = payload?.name;
  const accessCode = payload?.accessCode;

  const name = normalizeName(nameRaw);
  if (!isValidName(name)) {
    return json(400, { error: "Name is required (max 80 chars)." });
  }

  const requiredCode = process.env.EVAL_ACCESS_CODE;
  if (requiredCode && String(accessCode || "") !== String(requiredCode)) {
    return json(401, { error: "Invalid access code." });
  }

  try {
    await ensureSchema();
    const sql = getSql();

    const result = await sql.begin(async (tx) => {
      // Prevent duplicate rows under concurrent logins for the same name.
      // (Uses PostgreSQL's transactional advisory locks.)
      await tx`SELECT pg_advisory_xact_lock(hashtext(${name.toLowerCase()}))`;

      // If this name already exists, reuse it (prefer the one with existing work if duplicates exist).
      const existing = await tx`
        SELECT
          r.id::text AS id,
          r.name,
          COUNT(e.rater_id)::int AS eval_count
        FROM raters r
        LEFT JOIN evaluations e ON e.rater_id = r.id
        WHERE lower(r.name) = lower(${name})
        GROUP BY r.id, r.name
        ORDER BY COUNT(e.rater_id) DESC, MAX(r.created_at) DESC
        LIMIT 1
      `;
      if (existing.length) {
        return { sessionId: existing[0].id, name: existing[0].name };
      }

      const sessionId = crypto.randomUUID();
      await tx`
        INSERT INTO raters (id, name)
        VALUES (${sessionId}::uuid, ${name})
      `;
      return { sessionId, name };
    });

    return json(200, result);
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to create session.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to create session." });
  }
}

