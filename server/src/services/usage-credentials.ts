import { createPrivateKey } from 'node:crypto';
import { getDb } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';

// A second credential per key, for providers whose ACCOUNT usage the inference
// key cannot read. Stored encrypted like the key itself and never returned;
// the list carries only whether one is set and how the last read went.

export type UsageCredentialFields = Record<string, string>;

/** The fields each provider's usage credential needs, in display order. */
export const USAGE_CREDENTIAL_FIELDS = {
  // new-api's /api/user/self: the dashboard's System Access Token plus the
  // numeric user id it belongs to (the New-Api-User header is mandatory).
  unorouter: ['userId', 'accessToken'],
  // The usage endpoint answers only a signed-in console session; the rc- key
  // is refused with "Login required" (probed 2026-10-17).
  radeon: ['cookie'],
  // Cloud Quotas and Cloud Monitoring take OAuth, never an API key.
  google: ['serviceAccountJson'],
} as const satisfies Record<string, readonly string[]>;

export type UsageCredentialPlatform = keyof typeof USAGE_CREDENTIAL_FIELDS;

export function isUsageCredentialPlatform(platform: string): platform is UsageCredentialPlatform {
  return Object.hasOwn(USAGE_CREDENTIAL_FIELDS, platform);
}

export class UsageCredentialError extends Error {}

export interface GoogleServiceAccount { client_email: string; private_key: string; project_id: string }

export function parseServiceAccount(json: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new UsageCredentialError('The service account key is not valid JSON');
  }
  const sa = (parsed ?? {}) as Partial<Record<string, unknown>>;
  if (sa.type !== 'service_account') throw new UsageCredentialError('Expected a service account key file ("type": "service_account")');
  for (const field of ['client_email', 'private_key', 'project_id'] as const) {
    if (typeof sa[field] !== 'string' || !sa[field]) throw new UsageCredentialError(`The service account key has no ${field}`);
  }
  try {
    createPrivateKey(sa.private_key as string);
  } catch {
    throw new UsageCredentialError('The service account private_key does not parse');
  }
  return { client_email: sa.client_email as string, private_key: sa.private_key as string, project_id: sa.project_id as string };
}

/** Trim, drop pasted prefixes, and reject what the provider would refuse. */
export function normalizeUsageCredential(platform: UsageCredentialPlatform, input: UsageCredentialFields): UsageCredentialFields {
  const value = (name: string, max: number): string => {
    const v = typeof input[name] === 'string' ? input[name].trim() : '';
    if (!v) throw new UsageCredentialError(`${name} is required`);
    if (v.length > max) throw new UsageCredentialError(`${name} is too long`);
    return v;
  };
  switch (platform) {
    case 'unorouter': {
      const userId = value('userId', 20);
      if (!/^\d+$/.test(userId)) throw new UsageCredentialError('userId is the numeric user id');
      return { userId, accessToken: value('accessToken', 512).replace(/^Bearer\s+/i, '') };
    }
    case 'radeon':
      return { cookie: value('cookie', 16_384).replace(/^Cookie:\s*/i, '') };
    case 'google': {
      const json = value('serviceAccountJson', 16_384);
      parseServiceAccount(json);
      return { serviceAccountJson: json };
    }
  }
}

export interface UsageCredentialStatus {
  keyId: number;
  platform: string;
  setAt: string;
  lastReadAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastMessage: string | null;
}

interface StatusRow { key_id: number; platform: string; set_at: string; last_read_at: string | null; last_status: 'ok' | 'error' | null; last_message: string | null }

const toStatus = (r: StatusRow): UsageCredentialStatus => ({
  keyId: r.key_id, platform: r.platform, setAt: r.set_at,
  lastReadAt: r.last_read_at, lastStatus: r.last_status, lastMessage: r.last_message,
});

const STATUS_SQL = `
  SELECT c.key_id, k.platform, c.set_at, c.last_read_at, c.last_status, c.last_message
    FROM provider_usage_credentials c JOIN api_keys k ON k.id = c.key_id`;

export function listUsageCredentials(): UsageCredentialStatus[] {
  return (getDb().prepare(`${STATUS_SQL} ORDER BY c.key_id`).all() as StatusRow[]).map(toStatus);
}

export function getUsageCredentialStatus(keyId: number): UsageCredentialStatus | null {
  const row = getDb().prepare(`${STATUS_SQL} WHERE c.key_id = ?`).get(keyId) as StatusRow | undefined;
  return row ? toStatus(row) : null;
}

/** Replaces any earlier credential and forgets its read outcome. */
export function setUsageCredential(keyId: number, fields: UsageCredentialFields): void {
  const { encrypted, iv, authTag } = encrypt(JSON.stringify(fields));
  getDb().prepare(`
    INSERT INTO provider_usage_credentials (key_id, encrypted, iv, auth_tag)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key_id) DO UPDATE SET
      encrypted = excluded.encrypted, iv = excluded.iv, auth_tag = excluded.auth_tag,
      set_at = datetime('now'), last_read_at = NULL, last_status = NULL, last_message = NULL
  `).run(keyId, encrypted, iv, authTag);
}

export function clearUsageCredential(keyId: number): boolean {
  return getDb().prepare('DELETE FROM provider_usage_credentials WHERE key_id = ?').run(keyId).changes > 0;
}

/** The decrypted fields, or null when none is set or it no longer decrypts. */
export function readUsageCredential(keyId: number): UsageCredentialFields | null {
  const row = getDb().prepare('SELECT encrypted, iv, auth_tag FROM provider_usage_credentials WHERE key_id = ?')
    .get(keyId) as { encrypted: string; iv: string; auth_tag: string } | undefined;
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(decrypt(row.encrypted, row.iv, row.auth_tag));
    return parsed && typeof parsed === 'object' ? parsed as UsageCredentialFields : null;
  } catch {
    return null;
  }
}

export function recordUsageCredentialRead(keyId: number, status: 'ok' | 'error', message: string): void {
  getDb().prepare(`
    UPDATE provider_usage_credentials
       SET last_read_at = datetime('now'), last_status = ?, last_message = ?
     WHERE key_id = ?
  `).run(status, message.slice(0, 300), keyId);
}
