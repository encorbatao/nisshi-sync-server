const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const MAX_PAYLOAD = 8 * 1024 * 1024;

const nowISO = () => new Date().toISOString();
const sha256hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const isValidAccountId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(s);
const isValidSecret    = (s) => typeof s === "string" && s.length >= 16 && s.length <= 512;
const isValidId        = (s) => typeof s === "string" && s.length > 0 && s.length <= 200;

// Build the Express app from injected dependencies. No `listen`, so tests boot it
// on an ephemeral port.
function createApp({ db, stmts, config }) {
  const { tokenSecret, enrollmentSecret, tokenTtlMs } = config;

  const signToken = (accountId, ttlMs = tokenTtlMs) => {
    const payload = b64url(JSON.stringify({ aid: accountId, exp: Date.now() + ttlMs }));
    const sig = b64url(crypto.createHmac("sha256", tokenSecret).update(payload).digest());
    return `${payload}.${sig}`;
  };
  const verifyToken = (token) => {
    if (typeof token !== "string" || !token.includes(".")) return null;
    const [payload, sig] = token.split(".");
    const expected = b64url(crypto.createHmac("sha256", tokenSecret).update(payload).digest());
    if (!sig || !constantTimeEqual(sig, expected)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
    if (!data || typeof data.aid !== "string" || typeof data.exp !== "number") return null;
    if (Date.now() > data.exp) return null;
    return data.aid;
  };

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "8mb" }));
  if (!config.quiet) app.use((req, _res, next) => { console.log(`${nowISO()} ${req.method} ${req.path}`); next(); });

  const authLimiter = config.disableRateLimit
    ? (_req, _res, next) => next()
    : rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
        message: { error: "Too many attempts, try again later" } });

  // ── Enroll ────────────────────────────────────────────────────────────────
  // Join with the shared enrollment code. Idempotent: re-enrolling an existing
  // account with the same secret returns a fresh token and `created:false`.
  app.post("/api/enroll", authLimiter, (req, res) => {
    const { accountId, accountSecret, enrollmentCode } = req.body || {};
    if (!isValidAccountId(accountId) || !isValidSecret(accountSecret))
      return res.status(400).json({ error: "Invalid account credentials" });

    if (!constantTimeEqual(enrollmentCode || "", enrollmentSecret))
      return res.status(403).json({ error: "Invalid enrollment code" });

    const existing = stmts.getAccount.get(accountId);
    let created = false;
    if (existing) {
      if (!constantTimeEqual(existing.secret_hash, sha256hex(accountSecret)))
        return res.status(409).json({ error: "Account exists with a different secret" });
    } else {
      stmts.createAccount.run({
        account_id: accountId, secret_hash: sha256hex(accountSecret), created_at: nowISO(),
      });
      created = true;
    }
    res.json({ token: signToken(accountId), created, serverTime: nowISO() });
  });

  // ── Login ─────────────────────────────────────────────────────────────────
  app.post("/api/login", authLimiter, (req, res) => {
    const { accountId, accountSecret } = req.body || {};
    if (!isValidAccountId(accountId) || !isValidSecret(accountSecret))
      return res.status(400).json({ error: "Invalid account credentials" });
    const acct = stmts.getAccount.get(accountId);
    if (!acct || !constantTimeEqual(acct.secret_hash, sha256hex(accountSecret)))
      return res.status(401).json({ error: "Unknown account or wrong secret" });

    res.json({ token: signToken(accountId), serverTime: nowISO() });
  });

  // ── Auth middleware ─────────────────────────────────────────────────────────
  function requireAuth(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const aid = verifyToken(token);
    if (!aid) return res.status(401).json({ error: "Unauthorized" });
    req.accountId = aid;
    next();
  }

  // ── Sync (token-gated, scoped to the authenticated account) ─────────────────
  app.get("/api/sync", requireAuth, (req, res) => {
    // `since` is the server-assigned seq cursor. A non-integer value (an existing
    // client's legacy ISO-timestamp watermark, or empty) means "full snapshot" so
    // every device self-heals on its next sync.
    const raw = typeof req.query.since === "string" ? req.query.since : "";
    const since = /^\d+$/.test(raw) ? Number(raw) : 0;
    // Read the high-water mark before selecting; any record written after it gets
    // a greater seq and is delivered on the next pull.
    const cursor = stmts.getSeq.get().v;
    const records = stmts.pull.all(req.accountId, since).map((r) => ({
      kind: r.kind, id: r.id, updated_at: r.updated_at, deleted: r.deleted === 1, payload: r.payload, v: 1,
    }));
    res.json({ serverTime: String(cursor), records });
  });

  app.post("/api/sync", requireAuth, (req, res) => {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    let applied = 0, skipped = 0, rejected = 0;
    const lww = (existing, incomingUpdatedAt) => !existing || incomingUpdatedAt > existing.updated_at;
    const tx = db.transaction(() => {
      for (const r of records) {
        if (!r || !config.validKinds.has(r.kind) || !isValidId(r.id) || typeof r.updated_at !== "string") { rejected++; continue; }
        if (r.payload != null && (typeof r.payload !== "string" || r.payload.length > MAX_PAYLOAD)) { rejected++; continue; }
        if (!lww(stmts.getRecord.get(req.accountId, r.kind, r.id), r.updated_at)) { skipped++; continue; }
        stmts.bumpSeq.run();
        const seq = stmts.getSeq.get().v;
        stmts.upsert.run({
          account_id: req.accountId, kind: r.kind, id: r.id,
          updated_at: r.updated_at, deleted: r.deleted ? 1 : 0, payload: r.payload ?? null, seq,
        });
        applied++;
      }
    });
    tx();
    res.json({ serverTime: String(stmts.getSeq.get().v), applied, skipped, rejected });
  });

  app.post("/api/sync/purge", requireAuth, (req, res) => {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    let purged = 0;
    const tx = db.transaction(() => {
      for (const r of records) {
        if (!r || !config.validKinds.has(r.kind) || !isValidId(r.id)) continue;
        purged += stmts.purge.run(req.accountId, r.kind, r.id).changes;
      }
    });
    tx();
    res.json({ serverTime: nowISO(), purged });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Last-resort handler: a thrown route error returns 500 instead of hanging the client.
  app.use((err, _req, res, _next) => {
    if (!config.quiet) console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  });

  return app;
}

module.exports = { createApp };
