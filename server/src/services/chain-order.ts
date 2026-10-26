// chain-order — the one writer of a chain's stored order.
//
// profile_models.priority is 1-based and dense over the ENABLED rows: the
// router walks it top down and skips what is unavailable. Chains built by
// different paths have produced duplicates (two models at priority 3 in
// Coding), and a duplicate makes "which runs first" a coin toss, so every
// writer goes through here: the caller supplies the full enabled order and
// this renumbers it 1..n in one transaction. Disabled rows are not in the
// list, so they keep their numbers — re-enabling a model returns it to where
// it sat rather than to the end.

import type { Db } from '../db/types.js';

/** Renumber one chain's enabled rows 1..n in the given order. Disabled rows
 *  keep the numbers they hold. */
export function renumberChain(db: Db, profileId: number, orderedModelDbIds: number[]): void {
  const write = db.prepare('UPDATE profile_models SET priority = ? WHERE profile_id = ? AND model_db_id = ?');
  db.transaction(() => {
    orderedModelDbIds.forEach((modelDbId, i) => write.run(i + 1, profileId, modelDbId));
  })();
}
