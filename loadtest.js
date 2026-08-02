// Load-test harness for bujo-sync-server.
//
// Drives realistic concurrent sync traffic against a RUNNING server and reports
// throughput + latency percentiles. The point is to answer one question with
// data instead of a hunch: where is this server's ceiling, and is it the SQLite
// storage engine or the synchronous driver blocking Node's event loop?
//
// It runs a separate low-rate /api/health probe alongside the load. better-sqlite3
// is synchronous, so a heavy query blocks the WHOLE event loop — when that happens
// the health probe's latency spikes even though it touches no data. Watch the
// probe p99: if it climbs under load, you're event-loop-bound (more Node processes
// help), not disk-bound (Postgres would help). That distinction decides the migration.
//
// Usage:
//   1. Start the server in another terminal:  npm start
//   2. Run:                                   npm run loadtest
//
// Tunables (env vars, with defaults):
//   URL=http://localhost:4100   server base URL
//   DURATION_MS=15000           how long to sustain load
//   CONCURRENCY=50              number of in-flight virtual clients
//   ACCOUNTS=50                 distinct accounts to spread load across.
//                               Set ACCOUNTS=1 to simulate the WORST case:
//                               every client hammering a single account's write lock.
//   READ_RATIO=0.5              fraction of ops that are pulls vs pushes
//   PUSH_RECORDS=5              records per POST /api/sync
//   PAYLOAD_BYTES=2048          ciphertext blob size per record (cap is 512KB)
//
// ENROLLMENT_SECRET is read from .env (same file the server uses).

require("dotenv").config();
const crypto = require("crypto");

const URL           = process.env.URL || "http://localhost:4100";
const DURATION_MS   = Number(process.env.DURATION_MS) || 15000;
const CONCURRENCY   = Number(process.env.CONCURRENCY) || 50;
const ACCOUNTS      = Number(process.env.ACCOUNTS) || 50;
const READ_RATIO    = process.env.READ_RATIO != null ? Number(process.env.READ_RATIO) : 0.5;
const PUSH_RECORDS  = Number(process.env.PUSH_RECORDS) || 5;
const PAYLOAD_BYTES = Number(process.env.PAYLOAD_BYTES) || 2048;
const ENROLLMENT    = process.env.ENROLLMENT_SECRET || "";

const KINDS = ["daily", "monthly", "future", "collection", "collection_entry"];
const randId   = (n = 24) => crypto.randomBytes(n).toString("base64url").slice(0, n);
const payload  = Buffer.alloc(PAYLOAD_BYTES, "x").toString("base64"); // reused; size is what matters

if (!ENROLLMENT) {
  console.error("FATAL: ENROLLMENT_SECRET must be set (read from .env). The server needs it to enroll accounts.");
  process.exit(1);
}

async function post(path, body, token) {
  const res = await fetch(URL + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function enrollAccount() {
  const accountId = randId(32);
  const accountSecret = crypto.randomBytes(24).toString("base64url"); // 16..512 chars
  const out = await post("/api/enroll", { accountId, accountSecret, enrollmentCode: ENROLLMENT });
  return { accountId, token: out.token, watermark: "" };
}

// ── latency bookkeeping ──────────────────────────────────────────────────────
function stats(samples) {
  if (!samples.length) return null;
  const s = samples.slice().sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, min: s[0], p50: pct(50), p95: pct(95), p99: pct(99), max: s[s.length - 1], mean: sum / s.length };
}
const fmt = (st) => st
  ? `n=${st.n}  min=${st.min.toFixed(1)}  p50=${st.p50.toFixed(1)}  p95=${st.p95.toFixed(1)}  p99=${st.p99.toFixed(1)}  max=${st.max.toFixed(1)}  (ms)`
  : "no samples";

// ── workload ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Enrolling ${ACCOUNTS} account(s)...`);
  const accounts = [];
  for (let i = 0; i < ACCOUNTS; i++) {
    try {
      accounts.push(await enrollAccount());
    } catch (e) {
      // The server rate-limits /api/enroll to 20 per 15min per IP (server.js authLimiter).
      // That window is shared across runs, so back-to-back tests can hit it. Run with
      // whatever enrolled and tell the user how to get more headroom.
      console.warn(`\n  Enroll stopped at ${accounts.length}/${ACCOUNTS}: ${e.message}`);
      console.warn(`  (likely the /api/enroll rate limit: 20 per 15min per IP).`);
      console.warn(`  Options: lower ACCOUNTS, wait 15min, or raise the authLimiter cap on a local test server.\n`);
      break;
    }
  }
  if (!accounts.length) { console.error("FATAL: no accounts enrolled; cannot run."); process.exit(1); }

  console.log(`\nConfig:`);
  console.log(`  ${URL}  duration=${DURATION_MS}ms  concurrency=${CONCURRENCY}`);
  console.log(`  accounts=${ACCOUNTS}${ACCOUNTS === 1 ? "  (MAX write-lock contention)" : ""}  read_ratio=${READ_RATIO}`);
  console.log(`  push_records=${PUSH_RECORDS}  payload=${PAYLOAD_BYTES}B\n`);
  console.log(`Running...`);

  const pushLat = [], pullLat = [], probeLat = [];
  let pushOk = 0, pullOk = 0, errors = 0;
  const deadline = Date.now() + DURATION_MS;

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  async function doPush(acct) {
    const ts = new Date().toISOString();
    const records = Array.from({ length: PUSH_RECORDS }, () => ({
      kind: pick(KINDS), id: randId(16), updated_at: ts, deleted: false, payload,
    }));
    const t0 = performance.now();
    await post("/api/sync", { records }, acct.token);
    pushLat.push(performance.now() - t0);
    pushOk++;
  }

  async function doPull(acct) {
    const t0 = performance.now();
    const res = await fetch(`${URL}/api/sync?since=${encodeURIComponent(acct.watermark)}`, {
      headers: { authorization: `Bearer ${acct.token}` },
    });
    if (!res.ok) throw new Error(`/api/sync GET -> ${res.status}`);
    const out = await res.json();
    acct.watermark = out.serverTime; // advance watermark like a real client
    pullLat.push(performance.now() - t0);
    pullOk++;
  }

  // virtual client: loop until the deadline
  async function client() {
    while (Date.now() < deadline) {
      const acct = pick(accounts);
      try {
        if (Math.random() < READ_RATIO) await doPull(acct);
        else await doPush(acct);
      } catch { errors++; }
    }
  }

  // independent event-loop-lag probe: one cheap /api/health every ~150ms
  async function probe() {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try { await fetch(`${URL}/api/health`); probeLat.push(performance.now() - t0); } catch { /* counted via load */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const started = performance.now();
  await Promise.all([...Array.from({ length: CONCURRENCY }, client), probe()]);
  const elapsed = (performance.now() - started) / 1000;

  // ── report ─────────────────────────────────────────────────────────────────
  const totalOps = pushOk + pullOk;
  console.log(`\n── Results ──────────────────────────────────────────────────`);
  console.log(`Duration:    ${elapsed.toFixed(1)}s`);
  console.log(`Throughput:  ${(totalOps / elapsed).toFixed(0)} ops/s  (${pushOk} pushes, ${pullOk} pulls)`);
  console.log(`Errors:      ${errors}`);
  console.log(`\nPush  latency: ${fmt(stats(pushLat))}`);
  console.log(`Pull  latency: ${fmt(stats(pullLat))}`);
  console.log(`Probe latency: ${fmt(stats(probeLat))}   <- /api/health; spikes here = event-loop lag (Node-bound, not disk-bound)`);
  console.log(`─────────────────────────────────────────────────────────────`);
}

main().catch((e) => { console.error(e); process.exit(1); });
