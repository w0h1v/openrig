import type { Migration } from "../migrate.js";

export const additionalRuntimePermissionsSchema: Migration = {
  name: "090_additional_runtime_permissions.sql",
  sql: `
    CREATE TABLE node_permission_selections_next (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'claude-code', 'opencode', 'antigravity')),
      mode TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO node_permission_selections_next SELECT * FROM node_permission_selections;
    DROP TABLE node_permission_selections;
    ALTER TABLE node_permission_selections_next RENAME TO node_permission_selections;
  `,
};
