const fs = require("fs");

const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;

// Parse a newline-delimited allowlist file into a Set of record kinds.
// Blank lines and #-comment lines are ignored. Throws on a missing/unreadable
// file, an empty allowlist, or any line that is not a valid kind.
function loadRecordKinds(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read record kinds file at ${filePath}: ${err.message}`);
  }

  const kinds = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!KIND_RE.test(trimmed)) {
      throw new Error(`Invalid record kind "${trimmed}" in ${filePath} (must match ${KIND_RE}).`);
    }
    kinds.add(trimmed);
  }

  if (kinds.size === 0) {
    throw new Error(`No record kinds found in ${filePath}; the allowlist must not be empty.`);
  }
  return kinds;
}

module.exports = { loadRecordKinds };
