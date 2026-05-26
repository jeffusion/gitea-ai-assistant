import type { Migration } from '../database';

export const migration002RemoveLegacyReviewMode: Migration = {
  version: 2,
  name: 'remove_legacy_review_mode',

  up(db): void {
    db.exec(
      "UPDATE system_settings SET value = 'agent' WHERE key = 'REVIEW_ENGINE' AND value NOT IN ('agent','codex')"
    );
  },
};
