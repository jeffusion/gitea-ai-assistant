import type { Database } from 'bun:sqlite';
import type { Migration } from '../database';

export const migration006DropLegacyAssignments: Migration = {
  version: 6,
  name: 'drop_model_role_assignments',

  up(db: Database): void {
    db.exec('DROP TABLE IF EXISTS model_role_assignments');
  },
};
