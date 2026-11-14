# Clinic Booking API

A small API that lets patients book appointment slots, plus a simple web page that uses it.
Built for the Koya Cohort 4 assessment (Task 1).

**Stack:** Node.js, Express, Postgres (hosted on Neon), deployed on Render.

## How it works

| Level | What it does | How |
|-------|--------------|-----|
| 1 | List slots, book one, look up a booking | `GET /slots`, `POST /bookings`, `GET /bookings/:id`, `POST /reset` |
| 2 | API key + validation | `X-API-Key` header checked on every API call (401). Missing/invalid fields return 400, unknown slot 404, started slot 400. Name/email are trimmed, email lower-cased. |
| 3 | Never double book; cancel | A **unique index** in Postgres allows only one `confirmed` booking per slot, so even simultaneous requests can't both win (409 for the loser). `DELETE /bookings/:id` cancels and frees the slot. |
| 4 | Safe retries; paging | `Idempotency-Key` header: same key + same body returns the saved response, different body returns 422. `GET /bookings` uses cursor pagination (`limit` 1-50, `next_cursor`). |
| 5 | Anti-spam | Max 5 booking attempts per email per minute (failed ones count). The 6th gets 429 with `Retry-After`. |

Every error looks like `{"error": "message"}`.

## Run it locally

```bash
npm install
cp .env.example .env   # then fill in API_KEY and DATABASE_URL
export $(grep -v '^#' .env | xargs)   # or set the variables however you prefer
npm start
```

Open http://localhost:3000 for the web page (type your API key in the box, or add `?key=YOUR_KEY` to the link).

## Environment variables

- `API_KEY` — the secret that clients send in the `X-API-Key` header
- `DATABASE_URL` — Postgres connection string (Neon gives you one)
- `PORT` — set automatically by Render

## Design notes

- Tables are created automatically on startup, so there are no migration steps.
- The database enforces "one confirmed booking per slot", not the application code, which is what makes it safe under simultaneous requests.
- Idempotency uses a Postgres advisory lock per key, so a retry that arrives while the first request is still running waits for it and gets the same answer.
- The rate limiter is in memory (fine for one server instance). With several instances it would move to the database or Redis.
- `POST /reset` also clears bookings, saved idempotency keys and rate-limit counters.
