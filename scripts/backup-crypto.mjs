import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";

// Versioned authenticated format: header, salt(16), IV(12), tag(16), ciphertext.
const header = Buffer.from("MEALD1v1");
const [mode, source, target] = process.argv.slice(2);
const password = process.env.D1_BACKUP_KEY;
if (!password || password.length < 32)
  throw new Error("D1_BACKUP_KEY must have at least 32 characters");
const input = readFileSync(source);
if (mode === "encrypt") {
  if (!input.length) throw new Error("Cannot back up an empty export");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    scryptSync(password, salt, 32),
    iv,
  );
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  writeFileSync(
    target,
    Buffer.concat([header, salt, iv, cipher.getAuthTag(), ciphertext]),
    { mode: 0o600 },
  );
} else if (mode === "decrypt") {
  if (input.length <= 52 || !input.subarray(0, 8).equals(header))
    throw new Error("Invalid backup format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    scryptSync(password, input.subarray(8, 24), 32),
    input.subarray(24, 36),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(input.subarray(36, 52));
  // Authentication must succeed before any plaintext file is written.
  const plaintext = Buffer.concat([
    decipher.update(input.subarray(52)),
    decipher.final(),
  ]);
  writeFileSync(target, plaintext, { mode: 0o600 });
} else {
  throw new Error(
    "Usage: node scripts/backup-crypto.mjs encrypt|decrypt source target",
  );
}
