import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { HttpError } from "../utils/httpErrors.js";

interface EncryptedSecretPayload {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function parseMasterKey(input: string | undefined): Buffer {
  if (!input) {
    throw new HttpError(500, "missing_master_key", "AUTO_ROUTER_MASTER_KEY is required");
  }

  const trimmed = input.trim();
  const hex = /^[0-9a-fA-F]+$/;

  if (hex.test(trimmed) && trimmed.length === 64) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const base64Buffer = Buffer.from(trimmed, "base64");
    if (base64Buffer.length === 32) {
      return base64Buffer;
    }
  } catch {
    // ignore base64 parse failure
  }

  const utf8Buffer = Buffer.from(trimmed, "utf8");
  if (utf8Buffer.length === 32) {
    return utf8Buffer;
  }

  throw new HttpError(
    500,
    "invalid_master_key",
    "AUTO_ROUTER_MASTER_KEY must decode to a 32-byte key"
  );
}

export class SecretCipher {
  private readonly key: Buffer;

  public constructor(masterKey: string | undefined) {
    this.key = parseMasterKey(masterKey);
  }

  public encrypt(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload: EncryptedSecretPayload = {
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };

    return JSON.stringify(payload);
  }

  public decrypt(payloadText: string): string {
    let payload: EncryptedSecretPayload;

    try {
      payload = JSON.parse(payloadText) as EncryptedSecretPayload;
    } catch {
      throw new HttpError(500, "invalid_secret_payload", "Stored credential payload is invalid");
    }

    if (payload.v !== 1) {
      throw new HttpError(500, "unsupported_secret_payload", "Unsupported credential payload");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

    try {
      return Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new HttpError(500, "credential_decrypt_failed", "Failed to decrypt credential");
    }
  }
}
