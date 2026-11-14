// Clinic booking API — Koya Cohort 4 assessment, Task 1.
// Express + Postgres. One file on purpose, so it is easy to read top to bottom.
//
// Level 1  list slots, book one, look up a booking
// Level 2  API key, input validation
// Level 3  a slot can never be double booked (database rule), cancel a booking
// Level 4  Idempotency-Key header, cursor pagination
// Level 5  rate limit: 5 attempts per email per minute

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!API_KEY || !DATABASE_URL) {
  console.error("API_KEY and DATABASE_URL environment variables are required.");
  process.exit(1);
}

// Hosted Postgres (Neon etc.) needs SSL; a local one does not.
const isLocalDb = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: 10,
});
pool.on("error", (err) => console.error("Idle database client error:", err.message));

// ---------------------------------------------------------------------------
// Database tables
// ---------------------------------------------------------------------------
async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id         TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      start_text TEXT NOT NULL,          -- exactly as the client sent it
      end_text   TEXT NOT NULL,
      start_ts   TIMESTAMPTZ NOT NULL    -- used for sorting and "has it started?"
    );
    CREATE TABLE IF NOT EXISTS bookings (
      seq        BIGSERIAL PRIMARY KEY,  -- gives a stable "oldest first" order
      id         TEXT NOT NULL UNIQUE,
      slot_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      status     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- Level 3: the database itself refuses a second confirmed booking for a slot.
    -- This is what keeps us safe even when requests arrive at the same moment.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);
    -- Level 4: remembers the answer we gave for each Idempotency-Key.
    CREATE TABLE IF NOT EXISTS idempotency (
      key      TEXT PRIMARY KEY,
      body     TEXT NOT NULL,
      status   INT  NOT NULL,
      response TEXT NOT NULL
    );
  `);
}

// A few demo slots so the web page is not empty before anyone calls /reset.
async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM slots");
  if (rows[0].n > 0) return;
  const ids = [], providers = [], starts = [], ends = [], stamps = [];
  const base = new Date();
  base.setUTCHours(9, 0, 0, 0);
  for (let day = 1; day <= 3; day++) {
    for (const provider of ["Dr Ade", "Dr Bisi"]) {
      for (let k = 0; k < 4; k++) {
        const start = new Date(base.getTime() + day * 86400000 + k * 1800000);
        const end = new Date(start.getTime() + 1800000);
        ids.push(`demo-${provider === "Dr Ade" ? "ade" : "bisi"}-${day}-${k + 1}`);
        providers.push(provider);
        const s = start.toISOString().replace(".000Z", "Z");
        const e = end.toISOString().replace(".000Z", "Z");
        starts.push(s);
        ends.push(e);
        stamps.push(start.toISOString());
      }
    }
  }
  await pool.query(
    `INSERT INTO slots (id, provider, start_text, end_text, start_ts)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])
     ON CONFLICT DO NOTHING`,
    [ids, providers, starts, ends, stamps]
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const fail = (status, message) => ({ status, payload: { error: message } });

// Same body = same JSON, whatever order the keys came in.
function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const toBooking = (row) => ({
  id: row.id,
  slot_id: row.slot_id,
  name: row.name,
  email: row.email,
  status: row.status,
  created_at: row.created_at,
});

// ---------------------------------------------------------------------------
// Level 5: rate limit — 5 attempts per email per rolling minute.
// Kept in memory. Node handles one request at a time up to the first "await",
// so the check-and-count below can never be split by another request.
// ---------------------------------------------------------------------------
const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map(); // email -> [timestamps]

// Returns 0 if allowed (and counts the attempt), or the seconds to wait.
function checkRateLimit(email) {
  const now = Date.now();
  const recent = (attempts.get(email) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(email, recent);
    return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  attempts.set(email, recent);
  return 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [email, times] of attempts) {
    if (times.every((t) => now - t >= WINDOW_MS)) attempts.delete(email);
  }
}, WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// App + API key check (level 2). The web page itself is public; the API is not.
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

app.use(["/reset", "/slots", "/bookings"], (req, res, next) => {
  const key = req.get("X-API-Key");
  if (!key || !sameSecret(key, API_KEY)) {
    return res.status(401).json({ error: "missing or invalid API key" });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// POST /reset — delete every booking and replace all slots
// ---------------------------------------------------------------------------
app.post("/reset", async (req, res, next) => {
  try {
    const slots = asObject(req.body).slots;
    if (!Array.isArray(slots)) return res.status(400).json({ error: "slots must be an array" });

    const ids = [], providers = [], starts = [], ends = [], stamps = [];
    const seen = new Set();
    for (const slot of slots) {
      const s = asObject(slot);
      if (![s.id, s.provider, s.start, s.end].every(isNonEmptyString)) {
        return res.status(400).json({ error: "every slot needs id, provider, start and end" });
      }
      const startMs = Date.parse(s.start);
      if (Number.isNaN(startMs) || Number.isNaN(Date.parse(s.end))) {
        return res.status(400).json({ error: "slot start and end must be valid dates" });
      }
      if (seen.has(s.id)) return res.status(400).json({ error: `duplicate slot id: ${s.id}` });
      seen.add(s.id);
      ids.push(s.id);
      providers.push(s.provider);
      starts.push(s.start);
      ends.push(s.end);
      stamps.push(new Date(startMs).toISOString());
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM bookings");
      await client.query("DELETE FROM idempotency");
      await client.query("DELETE FROM slots");
      if (ids.length > 0) {
        await client.query(
          `INSERT INTO slots (id, provider, start_text, end_text, start_ts)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
          [ids, providers, starts, ends, stamps]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    attempts.clear(); // a fresh start also clears the rate-limit counters
    res.json({ ok: true, slots: ids.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /slots — every slot, earliest first, optional ?provider=
// ---------------------------------------------------------------------------
app.get("/slots", async (req, res, next) => {
  try {
    const params = [];
    let where = "";
    if (req.query.provider !== undefined) {
      if (typeof req.query.provider !== "string") {
        return res.status(400).json({ error: "provider must be a single value" });
      }
      params.push(req.query.provider);
      where = "WHERE s.provider = $1";
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_text, s.end_text,
              NOT EXISTS (SELECT 1 FROM bookings b
                          WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
         FROM slots s ${where}
        ORDER BY s.start_ts, s.id`,
      params
    );
    res.json({
      slots: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        start: r.start_text,
        end: r.end_text,
        available: r.available,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings — the main endpoint (levels 1-5)
// ---------------------------------------------------------------------------

// Level 1-3: validate, find the slot, and try to take it.
async function createBooking(client, body) {
  const slotId = body.slot_id;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  // Level 2: missing / empty / invalid details
  if (!isNonEmptyString(slotId)) return fail(400, "slot_id is required");
  if (!name) return fail(400, "name is required");
  if (!email) return fail(400, "email is required");
  if (!EMAIL_PATTERN.test(email)) return fail(400, "email is not valid");

  const slot = await client.query("SELECT id, start_ts FROM slots WHERE id = $1", [slotId]);
  if (slot.rowCount === 0) return fail(404, "slot not found");
  if (new Date(slot.rows[0].start_ts).getTime() <= Date.now()) {
    return fail(400, "slot has already started");
  }

  // Level 3: try to insert. If someone already holds this slot, the unique
  // index makes the insert do nothing, and we answer 409.
  const inserted = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
     VALUES ($1, $2, $3, $4, 'confirmed', $5)
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slotId, name, email, new Date().toISOString()]
  );
  if (inserted.rowCount === 0) return fail(409, "slot already booked");
  return { status: 201, payload: toBooking(inserted.rows[0]) };
}

app.post("/bookings", async (req, res, next) => {
  const body = asObject(req.body);
  const idempotencyKey = req.get("Idempotency-Key");
  const emailForLimit = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const client = await pool.connect().catch(next);
  if (!client) return;
  try {
    await client.query("BEGIN");

    // Level 4: have we already answered this Idempotency-Key?
    // The advisory lock makes two requests with the same key take turns,
    // so a retry that arrives while the first is still running waits for it.
    let bodyFingerprint = null;
    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      bodyFingerprint = stableStringify(body);
      const saved = await client.query(
        "SELECT body, status, response FROM idempotency WHERE key = $1",
        [idempotencyKey]
      );
      if (saved.rowCount > 0) {
        await client.query("ROLLBACK");
        const row = saved.rows[0];
        if (row.body !== bodyFingerprint) {
          return res.status(422).json({ error: "Idempotency-Key was already used with a different body" });
        }
        return res.status(row.status).json(JSON.parse(row.response));
      }
    }

    // Level 5: at most 5 attempts per email per minute (failed attempts count too).
    if (emailForLimit) {
      const wait = checkRateLimit(emailForLimit);
      if (wait > 0) {
        await client.query("ROLLBACK");
        res.set("Retry-After", String(wait));
        return res.status(429).json({ error: "too many booking attempts, try again later" });
      }
    }

    const result = await createBooking(client, body);

    if (idempotencyKey) {
      await client.query(
        "INSERT INTO idempotency (key, body, status, response) VALUES ($1, $2, $3, $4)",
        [idempotencyKey, bodyFingerprint, result.status, JSON.stringify(result.payload)]
      );
    }
    await client.query("COMMIT");
    res.status(result.status).json(result.payload);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /bookings?email=&limit=&cursor= — a person's bookings, oldest first
// ---------------------------------------------------------------------------
app.get("/bookings", async (req, res, next) => {
  try {
    const { email: rawEmail, limit: rawLimit, cursor: rawCursor } = req.query;

    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (!email) return res.status(400).json({ error: "email is required" });

    let limit = 10;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) {
        return res.status(400).json({ error: "limit must be a whole number from 1 to 50" });
      }
      limit = parseInt(rawLimit, 10);
      if (limit < 1 || limit > 50) {
        return res.status(400).json({ error: "limit must be a whole number from 1 to 50" });
      }
    }

    // The cursor is just "the last booking number you saw", dressed up so it looks opaque.
    let after = 0;
    if (rawCursor !== undefined) {
      const decoded = typeof rawCursor === "string"
        ? Buffer.from(rawCursor, "base64url").toString("utf8") : "";
      if (!/^\d+$/.test(decoded)) return res.status(400).json({ error: "invalid cursor" });
      after = parseInt(decoded, 10);
    }

    const { rows } = await pool.query(
      `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [email, after, limit + 1] // one extra row tells us whether another page exists
    );
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit
      ? Buffer.from(String(page[page.length - 1].seq)).toString("base64url")
      : null;

    res.json({ bookings: page.map(toBooking), next_cursor: nextCursor });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /bookings/:id and DELETE /bookings/:id
// ---------------------------------------------------------------------------
app.get("/bookings/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "booking not found" });
    res.json(toBooking(rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete("/bookings/:id", async (req, res, next) => {
  try {
    // One atomic statement: only a confirmed booking can be cancelled, so two
    // cancel requests at once cannot both succeed.
    const cancelled = await pool.query(
      "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
      [req.params.id]
    );
    if (cancelled.rowCount > 0) return res.json(toBooking(cancelled.rows[0]));

    const existing = await pool.query("SELECT id FROM bookings WHERE id = $1", [req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: "booking not found" });
    res.status(409).json({ error: "booking is already cancelled" });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Errors: always {"error": "..."}
// ---------------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: "not found" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "request body is not valid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ---------------------------------------------------------------------------
setupDatabase()
  .then(seedIfEmpty)
  .then(() => app.listen(PORT, () => console.log(`Clinic booking API listening on port ${PORT}`)))
  .catch((err) => {
    console.error("Could not start:", err.message);
    process.exit(1);
  });
