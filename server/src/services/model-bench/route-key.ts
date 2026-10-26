import type { Db } from '../../db/types.js';

// Which credential calls one route. Shared by the bench CLI and the scheduled
// route probe so the two can never test a route through different keys.

export interface RouteModelRow {
  platform: string;
  model_id: string;
  key_id: number | null;
}

export interface RouteKeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  model_scope_json: string | null;
  proxy_encrypted: string | null;
  proxy_iv: string | null;
  proxy_auth_tag: string | null;
}

export function pickRouteKey(db: Db, model: RouteModelRow, keyId?: number): RouteKeyRow {
  // Every custom relay shares platform 'custom', so "first usable custom key"
  // can be a different relay that does not serve this id. A custom route is
  // tested only through the key its catalogue row belongs to.
  if (model.platform === 'custom') {
    if (model.key_id == null) throw new Error(`custom/${model.model_id}: catalogue row names no key; cannot tell which relay serves it`);
    if (keyId != null && keyId !== model.key_id) throw new Error(`custom/${model.model_id} belongs to key ${model.key_id}, not ${keyId}`);
    keyId = model.key_id;
  }
  const keys = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag, base_url, model_scope_json, proxy_encrypted, proxy_iv, proxy_auth_tag FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ${keyId != null ? 'AND id = ?' : ''} ORDER BY id
  `).all(...(keyId != null ? [model.platform, keyId] : [model.platform])) as RouteKeyRow[];
  const usable = keys.filter(k => {
    if (!k.model_scope_json) return true;
    try { return (JSON.parse(k.model_scope_json) as string[]).includes(model.model_id); } catch { return false; }
  });
  if (usable.length === 0) throw new Error(`no enabled, healthy key on ${model.platform} whose scope covers ${model.model_id}`);
  return usable[0];
}
