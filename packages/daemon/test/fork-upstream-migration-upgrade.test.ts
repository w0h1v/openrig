import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";

const forkMigration = "090_additional_runtime_permissions.sql";
const upstreamMigrations = ["090_human_reply_to.sql", "091_human_questions.sql"];

describe("fork/upstream migration reconciliation", () => {
  it.each(["fork", "upstream", "common"])("upgrades %s data without renaming or replaying applied migrations", source => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      const prior = ALL_MIGRATIONS.filter(m => source === "fork"
        ? !upstreamMigrations.includes(m.name)
        : source === "upstream" ? m.name !== forkMigration
          : m.name !== forkMigration && !upstreamMigrations.includes(m.name));
      migrate(db, prior);
      const repo = new RigRepository(db);
      const rig = repo.createRig("upgrade");
      const node = repo.addNode(rig.id, "worker", { runtime: source === "fork" ? "opencode" : "codex" });
      db.prepare("INSERT INTO node_permission_selections(node_id,runtime,mode,actor,reason) VALUES (?,?,?,?,?)")
        .run(node.id, source === "fork" ? "opencode" : "codex", "floor", "operator", "retain selection");
      db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body) VALUES ('retained',datetime('now'),datetime('now'),'source','destination','pending','retain work')").run();
      if (source === "upstream") {
        db.prepare("UPDATE queue_items SET reply_to='prior-thread', human_questions='[]', human_answers='{}' WHERE qitem_id='retained'").run();
      }
      const selection = db.prepare("SELECT * FROM node_permission_selections").get();
      const recorded = db.prepare("SELECT * FROM schema_migrations ORDER BY name").all();
      migrate(db, ALL_MIGRATIONS);
      migrate(db, ALL_MIGRATIONS);
      expect(db.prepare("SELECT * FROM node_permission_selections").get()).toEqual(selection);
      expect(db.prepare("SELECT name FROM schema_migrations ORDER BY name").all()).toHaveLength(ALL_MIGRATIONS.length);
      for (const row of recorded as { name: string; applied_at: string }[]) {
        expect(db.prepare("SELECT * FROM schema_migrations WHERE name=?").get(row.name)).toEqual(row);
      }
      expect(db.prepare("SELECT body,reply_to,human_questions,human_answers FROM queue_items WHERE qitem_id='retained'").get()).toEqual({
        body: "retain work", reply_to: source === "upstream" ? "prior-thread" : null,
        human_questions: source === "upstream" ? "[]" : null, human_answers: source === "upstream" ? "{}" : null,
      });
      db.prepare("UPDATE node_permission_selections SET runtime='antigravity', mode='plan' WHERE node_id=?").run(node.id);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });
});
