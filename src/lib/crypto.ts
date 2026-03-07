import crypto from "crypto";
import os from "os";
import path from "path";
import fs from "fs";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Derives a stable encryption key from machine-specific identifiers.
 * Falls back to a key file in the data directory if machine ID is unavailable.
 */
function deriveKey(): Buffer {
  const hostname = os.hostname();
  const dataDir = path.resolve("data");

  // Try to read a persisted key salt; create one if missing
  const saltPath = path.join(dataDir, ".key-salt");
  let salt: string;
  if (fs.existsSync(saltPath)) {
    salt = fs.readFileSync(saltPath, "utf-8").trim();
  } else {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    salt = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(saltPath, salt, { mode: 0o600 });
  }

  return crypto.pbkdf2Sync(
    hostname + salt,
    salt,
    100_000,
    KEY_LENGTH,
    "sha256",
  );
}

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (!cachedKey) {
    cachedKey = deriveKey();
  }
  return cachedKey;
}

/**
 * Encrypts a plaintext string. Returns a hex-encoded string:
 * "enc:v1:<iv>:<authTag>:<ciphertext>"
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `enc:v1:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a string produced by encrypt(). If the input doesn't have
 * the "enc:v1:" prefix, returns it as-is (plaintext passthrough for migration).
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith("enc:v1:")) {
    return ciphertext;
  }

  const parts = ciphertext.split(":");
  if (parts.length !== 5) {
    throw new Error("Malformed encrypted value");
  }

  const iv = Buffer.from(parts[2], "hex");
  const authTag = Buffer.from(parts[3], "hex");
  const encrypted = Buffer.from(parts[4], "hex");
  const key = getKey();

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf-8");
}

/**
 * Returns true if the value is already encrypted.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith("enc:v1:");
}
