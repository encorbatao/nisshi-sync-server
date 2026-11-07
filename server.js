// Entry point: load config, wire dependencies, listen. All routing lives in app.js;
// the DB in db.js.
require("dotenv").config();

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
const path = require("path");
const { initDb } = require("./db.js");
const { createApp } = require("./app.js");
const { loadRecordKinds } = require("./record-kinds.js");

const PORT              = Number(process.env.PORT) || 4100;
// Loopback by default: put a reverse proxy/tunnel in front. Set HOST=0.0.0.0 only if
// clients must reach the port directly (then X-Forwarded-For can be spoofed).
const HOST              = process.env.HOST || "127.0.0.1";
const DB_PATH           = process.env.DB_PATH || path.join(__dirname, "vault.db");
const RECORD_KINDS_FILE = process.env.RECORD_KINDS_FILE || path.join(__dirname, "record-kinds.txt");
const ENROLLMENT_SECRET = process.env.ENROLLMENT_SECRET || "";
const TOKEN_SECRET      = process.env.TOKEN_SECRET || "";
const TOKEN_TTL_MS      = 30 * 24 * 60 * 60 * 1000;                       // 30 days

if (!ENROLLMENT_SECRET || !TOKEN_SECRET) {
  console.error("FATAL: ENROLLMENT_SECRET and TOKEN_SECRET must be set (see .env.example).");
  process.exit(1);
}

let validKinds;
try {
  validKinds = loadRecordKinds(RECORD_KINDS_FILE);
} catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}

const { db, stmts } = initDb(DB_PATH);
const app = createApp({
  db, stmts,
  config: {
    tokenSecret: TOKEN_SECRET, enrollmentSecret: ENROLLMENT_SECRET,
    tokenTtlMs: TOKEN_TTL_MS, validKinds,
  },
});

app.listen(PORT, HOST, () => {
  console.log(`Nisshi Sync Server listening on ${HOST}:${PORT}`);
  console.log(`[db] ${DB_PATH}`);
  console.log(`[record-kinds] ${validKinds.size} kinds from ${RECORD_KINDS_FILE}`);
});
