// Migration: account_blocked -> access_denied in provider_diagnosis_history.
// Created: 2026-09-20
//
// The verdict was misnamed. `account_blocked` reads as "the provider banned
// you", and on 2026-09-20 OpenCode Zen produced a 403 that is nothing of the
// sort: the key is valid, the account is in good standing, and the refusal is
// about WHERE the call came from —
//
//   "OpenCode's free tier can only be used from within OpenCode"
//
// Confirmed by calling https://opencode.ai/zen/v1/chat/completions directly
// with a freshly issued key: 403 FreeTierError. The same key works through the
// OpenCode client. So 403 covers plan limits, ended promos, region blocks AND
// caller rules, and only `access_denied` is true of all four.
//
// The history table stores the verdict as text, so rows written before the
// rename would keep a name no code produces any more — a reader grepping for
// `access_denied` would find the feature and miss its entire history. Rewrite
// them, since the verdict they recorded is unchanged; only its name is.
//
// DOWN restores the old name so the migration is reversible, even though the
// name it restores is the wrong one.
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(
    `UPDATE provider_diagnosis_history SET verdict = 'access_denied' WHERE verdict = 'account_blocked'`,
  ).run();
}

export function down(db: Db): void {
  db.prepare(
    `UPDATE provider_diagnosis_history SET verdict = 'account_blocked' WHERE verdict = 'access_denied'`,
  ).run();
}
