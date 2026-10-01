import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { validateNativePermissionSelection } from "../src/domain/native-permission-selection.js";
import { activityRoutes } from "../src/routes/activity.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { classifyPaneActivity } from "../src/domain/session-transport.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { runtimeRungInventory } from "../src/domain/activity-taxonomy.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const identities = { opencode: "ses_1234567890abcdef", "antigravity": "12345678-1234-4234-8234-123456789abc" };
function fixture(runtime: keyof typeof identities) {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
  const repo = new RigRepository(db); const rig = repo.createRig("native-providers");
  const node = repo.addNode(rig.id, "worker", { runtime, cwd: "/test/project" });
  const registry = new SessionRegistry(db); const session = registry.registerSession(node.id, "worker@native-providers");
  const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus,
    resolveOccupantGeneration: (id) => registry.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, gen) => registry.isOccupantGenerationRegistered(id, gen),
  });
  let launchId = "current-launch";
  const runtimeAdapters = { [runtime]: { currentLaunchId: () => launchId } };
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ runtimeAdapters, agentActivityStore: store, sessionRegistry: registry, eventBus, activityHookToken: "test-token" })) c.set(key as never, value as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const base = { launchId, runtime, nodeId: node.id, sessionName: session.sessionName, generation, sessionId: identities[runtime], hookEvent: "SessionStart" };
  const post = (changes: Record<string, unknown> = {}) => app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-token" }, body: JSON.stringify({ ...base, ...changes }) });
  const token = () => (db.prepare("SELECT resume_token, resume_type FROM sessions WHERE id = ?").get(session.id) as { resume_token: string | null; resume_type: string | null });
  return { db, repo, node, registry, session, generation, post, token, store, replaceLaunch: () => { launchId = "successor-launch"; } };
}

describe.each(["opencode", "antigravity"] as const)("%s real activity route and persistence", (runtime) => {
  it("requires confirmed exact identity before accepting activity", async () => {
    const f = fixture(runtime);
    expect((await f.post({ hookEvent: runtime === "opencode" ? "busy" : "active" })).status).toBe(409);
    expect((await f.post({ eventFamily: "session_identity" })).status).toBe(200);
    expect(f.token()).toEqual({ resume_token: identities[runtime], resume_type: runtime === "opencode" ? "opencode_id" : "antigravity_id" });
    expect((await f.post({ hookEvent: runtime === "opencode" ? "busy" : "active" })).status).toBe(200);
    expect(f.store.getLatestForNode({ nodeId: f.node.id, sessionName: f.session.sessionName })?.generation).toBe(f.generation);
  });
  it("refuses an in-flight predecessor callback after a retry within the same generation", async () => {
    const f = fixture(runtime);
    f.replaceLaunch();
    expect((await f.post({ eventFamily: "session_identity" })).status).toBe(409);
    expect(f.token().resume_token).toBeNull();
    expect((await f.post({ eventFamily: "session_identity", launchId: "successor-launch" })).status).toBe(200);
    expect((await f.post({ hookEvent: "active" })).status).toBe(409);
    expect((await f.post({ hookEvent: "active", launchId: "successor-launch" })).status).toBe(200);
  });
  it("fences retired generations on both identity and activity", async () => {
    const f = fixture(runtime);
    await f.post({ eventFamily: "session_identity" });
    const before = f.token();
    f.registry.mintOccupantTenure(f.node.id, "handover");
    expect((await f.post({ eventFamily: "session_identity" })).status).toBe(409);
    expect((await f.post({ hookEvent: "active" })).status).toBe(409);
    expect(f.token()).toEqual(before);
    expect((await f.post({ eventFamily: "session_identity", generation: null })).status).toBe(409);
  });
  it("rejects malformed IDs, unrelated seats and runtime spoofing without replacing history", async () => {
    const f = fixture(runtime); await f.post({ eventFamily: "session_identity" }); const before = f.token();
    expect((await f.post({ eventFamily: "session_identity", sessionId: "latest" })).status).toBe(400);
    expect((await f.post({ eventFamily: "session_identity", sessionName: "other-seat" })).status).toBe(409);
    expect((await f.post({ runtime: runtime === "opencode" ? "antigravity" : "opencode", eventFamily: "session_identity" })).status).toBe(409);
    expect((await f.post({ sessionId: runtime === "opencode" ? "ses_different123" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", hookEvent: "active" })).status).toBe(409);
    expect((await f.post({ eventFamily: "session_identity", sessionId: runtime === "opencode" ? "ses_different123" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).status).toBe(409);
    expect(f.token()).toEqual(before);
  });
});

describe("additional runtime permission migration", () => {
  it("keeps Antigravity cancellation coverage partial and requires empty input for shared transport/resume", () => {
    expect(runtimeRungInventory("antigravity").rungs.find((rung) => rung.rung === "lifecycle-hooks")).toMatchObject({ lifecycleCoverage: "partial", initialTrust: "trial" });
    const empty = "─────────────────────────────────────────────────\n>\n─────────────────────────────────────────────────\n? for shortcuts                   Gemini 3.1 Pro · low";
    expect(classifyPaneActivity(empty, "antigravity").state).toBe("agent_idle");
    expect(assessNativeResumeProbe({ runtime: "antigravity", paneCommand: "node", paneContent: empty }).status).toBe("resumed");
    for (const paneContent of ["> unfinished draft", `${empty}\nAllow once?`, `${empty}\nesc to cancel`, `${empty}\n${"old history\n".repeat(15)}`]) {
      expect(classifyPaneActivity(paneContent, "antigravity").state).not.toBe("agent_idle");
      expect(assessNativeResumeProbe({ runtime: "antigravity", paneCommand: "node", paneContent }).status).not.toBe("resumed");
    }
  });
  it("preserves previous selections, identities and tenure history while widening admitted runtimes", () => {
    const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys = ON");
    migrate(db, ALL_MIGRATIONS.filter((migration) => !migration.name.startsWith("090_")));
    const repo = new RigRepository(db); const rig = repo.createRig("upgrade");
    const old = repo.addNode(rig.id, "old", { runtime: "codex", cwd: "/test" });
    const registry = new SessionRegistry(db); const session = registry.registerSession(old.id, "old@upgrade");
    registry.updateResumeToken(session.id, "codex_id", "retained-history", "hook");
    const store = new NativePermissionStore(db);
    store.write(old.id, validateNativePermissionSelection("codex", "floor"), "operator", "retained reason");
    const snapshot = () => JSON.stringify(["sessions", "occupant_tenures", "node_permission_selections"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot(); migrate(db, ALL_MIGRATIONS); migrate(db, ALL_MIGRATIONS);
    expect(snapshot()).toBe(before);
    for (const runtime of ["opencode", "antigravity"] as const) {
      const node = repo.addNode(rig.id, runtime, { runtime, cwd: "/test" });
      const mode = runtime === "opencode" ? "native" : "accept-edits";
      store.write(node.id, validateNativePermissionSelection(runtime, mode), "operator", "explicit choice");
      expect(store.read(node.id)).toMatchObject({ runtime, mode });
      expect(store.apply({ nodeId: node.id } as NodeBinding, runtime).permissionMode).toBe(mode);
      expect(() => store.apply({ nodeId: node.id } as NodeBinding, "codex")).toThrow(/runtime changed/);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => validateNativePermissionSelection("opencode", "full_bypass")).toThrow(/unsupported/);
  });
});
