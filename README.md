# Nisshi Sync Server

Zero-knowledge, multi-tenant sync/backup server. Stores only **opaque
ciphertext** plus the routing metadata sync needs (`account_id`, `kind`, `id`,
`updated_at`, `deleted`) — it never holds the content key, so it **cannot read
your data**. Multiple apps and people can share one server with fully isolated
data. Example client: the **Nisshi** iOS app.

Everyone joins with the same shared enrollment code — free, no expiry, no payment
processor involved.

For details about Nisshi, see [www.nisshi.app](https://www.nisshi.app).

## How it works

- **Identity-derived accounts.** Each user's `accountId` and `accountSecret` are
  derived on-device from their Master Key (HKDF). The server stores only a hash of
  the secret. Losing the server reveals nothing; a server compromise can't decrypt.
- **One join path.** A shared `ENROLLMENT_SECRET` you hand to the people who should
  have accounts. Data is always keyed by `account_id`, which the server never links
  to any real-world identity.
- **Last-write-wins** by `updated_at`, with soft-delete tombstones and a hard
  `purge` (emptied trash), all scoped to the authenticated account.
- **Sync is gated by a 30-day session token** issued at enroll or login. The server
  makes no outbound network calls at all — it talks to nothing but its clients.

## Architecture

The server is split into focused, independently testable modules:

| File | Responsibility |
|---|---|
| `server.js` | Entry point — loads config, wires dependencies, listens. |
| `app.js` | `createApp({db, stmts, config})` → the Express app (all routes + token sign/verify). No `listen`, so tests boot it on an ephemeral port. |
| `db.js` | `initDb(dbPath)` → `{db, stmts}`. Schema, in-place migration, prepared statements. |
| `record-kinds.js` | `loadRecordKinds(filePath)` → `Set` of accepted record kinds; parses the newline-delimited allowlist, ignoring comments/blanks. |
| `test/*.test.js` | `node:test` suite (no external test deps). |

## Setup

```sh
npm install
cp .env.example .env      # then set ENROLLMENT_SECRET and TOKEN_SECRET to long random values
npm start
```

Check it: `curl localhost:4100/api/health` → `{"ok":true}`.

`record-kinds.txt` ships with a default set of accepted record kinds; its path is
set via `RECORD_KINDS_FILE` (default `./record-kinds.txt`). The server refuses to
start if the file is missing or empty.

Generate secrets, e.g.: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Requires **Node ≥ 20**. Put it behind an HTTPS reverse proxy in production.

Run the tests with `npm test` (uses the built-in `node:test` runner — no extra
dependencies).

### Backup

The whole vault is the SQLite file at `DB_PATH`. It runs in WAL mode, so recent
writes may still live in the `-wal` sidecar — copying `vault.db` on its own can
miss them. Take a consistent snapshot while the server is running with:

```sh
sqlite3 vault.db ".backup 'vault-backup.db'"
```

Or stop the server and copy `vault.db`, `vault.db-wal`, and `vault.db-shm`
together. Restore by putting the file back at `DB_PATH` with the server stopped.
The contents stay encrypted either way — a backup is as unreadable to you as it
is to the server.

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `4100` | |
| `HOST` | no | `127.0.0.1` | Bind address. Keep loopback behind a reverse proxy/tunnel; `0.0.0.0` exposes the port directly. |
| `DB_PATH` | no | `./vault.db` | SQLite file |
| `ENROLLMENT_SECRET` | **yes** | — | Shared join code |
| `TOKEN_SECRET` | **yes** | — | HMAC signing key for session tokens |
| `RECORD_KINDS_FILE` | no | `./record-kinds.txt` | Allowlist of accepted record kinds |

## API

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| POST | `/api/enroll` | code | `{accountId, accountSecret, enrollmentCode}` | Join with the shared code; returns `{token, created}` |
| POST | `/api/login` | — | `{accountId, accountSecret}` | Get a token for an existing account |
| GET  | `/api/sync?since=` | Bearer | — | Records changed since the cursor |
| POST | `/api/sync` | Bearer | `{records:[EncryptedRecord]}` | Upsert (LWW) |
| POST | `/api/sync/purge` | Bearer | `{records:[{kind,id}]}` | Hard-delete |
| DELETE | `/api/account` | Bearer | — | Hard-delete the account and all its records; returns `{deleted, records}` |
| GET  | `/api/health` | — | — | Liveness |

`EncryptedRecord = {kind, id, updated_at, deleted, payload, v}` — `payload` is a
base64 AES-256-GCM blob the server treats as opaque.

### Enroll

`enrollmentCode` is compared against `ENROLLMENT_SECRET` in constant time; anything
else returns `403 {error:"Invalid enrollment code"}`. Enroll is idempotent:
re-enrolling the same account with the same secret returns a token with
`created:false`. Re-enrolling an existing account id with a *different* secret is
`409 {error:"Account exists with a different secret"}`.

### Sync cursor

`since` is the server-assigned `seq` — a monotonic counter, not a timestamp — so a
device with a lagging clock can't silently miss records. A non-integer `since` (or
an empty one) returns a full snapshot, which lets an older client self-heal on its
next sync.

## Security notes

- The server makes no outbound requests, so there is no third party to leak to.
- Auth endpoints (`/api/enroll`, `/api/login`) are rate-limited. Secret and token
  comparisons are constant-time.
- The server never holds the content key and cannot decrypt any `payload`.

## License

Copyright 2026, Antonio Borras Alomar

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
