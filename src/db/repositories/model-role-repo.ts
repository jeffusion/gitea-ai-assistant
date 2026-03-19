/**
 * Repository for model_role_assignments table.
 * Maps business roles (planner, specialist, judge, embedding)
 * to specific provider + model combinations.
 */

import { getDatabase } from '../database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRole = 'planner' | 'specialist' | 'judge' | 'embedding';

export interface RoleAssignmentRow {
  role: ModelRole;
  provider_id: string;
  model: string;
  updated_at: string;
}

/** Enriched role assignment with provider metadata (for API responses). */
export interface RoleAssignmentWithProvider extends RoleAssignmentRow {
  provider_name: string;
  provider_type: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const modelRoleRepo = {
  /**
   * List all role assignments with provider info.
   */
  list(): RoleAssignmentWithProvider[] {
    const db = getDatabase();
    return db
      .query(
        `SELECT
           r.role,
           r.provider_id,
           r.model,
           r.updated_at,
           p.name AS provider_name,
           p.type AS provider_type
         FROM model_role_assignments r
         JOIN llm_providers p ON r.provider_id = p.id
         ORDER BY r.role`
      )
      .all() as RoleAssignmentWithProvider[];
  },

  /**
   * Get the assignment for a specific role.
   */
  getByRole(role: ModelRole): RoleAssignmentRow | null {
    const db = getDatabase();
    return (
      (db
        .query('SELECT * FROM model_role_assignments WHERE role = ?')
        .get(role) as RoleAssignmentRow) || null
    );
  },

  /**
   * Set (upsert) a role → provider+model mapping.
   */
  set(role: ModelRole, providerId: string, model: string): void {
    const db = getDatabase();
    db.query(
      `INSERT INTO model_role_assignments (role, provider_id, model, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(role) DO UPDATE SET
         provider_id = excluded.provider_id,
         model = excluded.model,
         updated_at = datetime('now')`
    ).run(role, providerId, model);
  },

  /**
   * Remove a role assignment.
   */
  delete(role: ModelRole): boolean {
    const db = getDatabase();
    const result = db.query('DELETE FROM model_role_assignments WHERE role = ?').run(role);
    return result.changes > 0;
  },

  /**
   * Get all roles assigned to a specific provider (used when disabling/deleting a provider).
   */
  getRolesByProvider(providerId: string): ModelRole[] {
    const db = getDatabase();
    return db
      .query('SELECT role FROM model_role_assignments WHERE provider_id = ?')
      .all(providerId)
      .map((row: any) => row.role as ModelRole);
  },
};
