import { Hono } from "hono";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { discoverResumeToken } from "../src/domain/agent-images/resume-token-discovery.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const dbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture(runtime: "opencode" | "antigravity") {
  const token = runtime === "opencode" ? "ses_nativeIdentity123" : "00000000-0000-7000-8000-000000000001";
  const db = createFullTestDb(); dbs.push(db);
  const rigRepo = new RigRepository(db); const sessionRegistry = new SessionRegistry(db);
  const rig = rigRepo.createRig("native-identity"); const node = rigRepo.addNode(rig.id, "worker", { runtime });
  const session = sessionRegistry.registerSession(node.id, "worker@native-identity");
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateResumeToken(session.id, runtime === "opencode" ? "opencode_id" : "antigravity_id", token, "operator");
  const command = runtime === "opencode" ? `opencode attach http://127.0.0.1:4096 --session ${token}` : `agy --conversation ${token} --log-file /tmp/native-test.log`;
  const rows = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: runtime === "opencode" ? "opencode" : "agy", startedAt: "Sat Jan 1 12:00:00 2000", command }];
  const tmux = { listPanes: async () => [{ id: "%1", active: true }], getPanePid: async () => 10, getPaneCommand: async () => "node", hasSession: async () => true } as unknown as TmuxAdapter;
  const readAntigravityLaunchIdentity = () => ({ logPath: "/tmp/native-test.log", generation: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid, sessionId: token });
  return { readAntigravityLaunchIdentity, db, rigRepo, sessionRegistry, node, rig, rows, tmux, session, token };
}

describe("additional native recovery identity", () => {
  it.each(["opencode", "antigravity"] as const)("requires exact %s lineage before clearing identity", async runtime => {
    const f = fixture(runtime);
    const input = { db: f.db, sessionRegistry: f.sessionRegistry, tmux: f.tmux, nodeId: f.node.id, sessionName: f.session.sessionName, runtime, expectedResumeToken: f.token, requireExactResumeLineage: true, listProcesses: () => f.rows, readAntigravityLaunchIdentity: f.readAntigravityLaunchIdentity };
    expect((await rebindAndVerifyPaneIdentity(input)).ok).toBe(true);
    expect((await rebindAndVerifyPaneIdentity({ ...input, expectedResumeToken: undefined })).ok).toBe(true);
    expect((await rebindAndVerifyPaneIdentity({ ...input, expectedResumeToken: "wrong" })).ok).toBe(false);
    expect((await rebindAndVerifyPaneIdentity({ ...input, listProcesses: () => [{ ...f.rows[0]!, executableName: "node", command: "node worker.js" }] })).ok).toBe(false);
  });
  it.each(["opencode", "antigravity"] as const)("periodically downranks %s when its native process disappears", async runtime => {
    const f = fixture(runtime);
    f.sessionRegistry.updateBinding(f.node.id, { tmuxSession: f.session.sessionName, tmuxPane: "%1" });
    let rows = f.rows;
    const reconciler = new SeatIdentityReconciler({ db: f.db, tmux: { ...f.tmux, listSessions: async () => [{ name: f.session.sessionName }] } as unknown as TmuxAdapter, listProcesses: () => rows, readAntigravityLaunchIdentity: f.readAntigravityLaunchIdentity });
    const store = new SeatIdentityStore(f.db);
    await reconciler.reconcileAll();
    expect(store.getForNode(f.node.id)?.verdict).toBe("verified");
    rows = [{ ...f.rows[0]!, command: "node worker.js", executableName: "node" }];
    await reconciler.reconcileAll();
    expect(store.getForNode(f.node.id)?.verdict).toBe("mismatch");
  });
  it.each(["opencode", "antigravity"] as const)("retains exact %s identity with upstream batched pane observations", async runtime => {
    const f = fixture(runtime);
    f.sessionRegistry.updateBinding(f.node.id, { tmuxSession: f.session.sessionName, tmuxPane: "%1" });
    let batchReads = 0;
    let individualReads = 0;
    let rows = f.rows;
    const tmux = { ...f.tmux, listSessions: async () => [{ name: f.session.sessionName }],
      readAllPaneProcesses: async () => { batchReads++; return new Map([["%1", { pid: 10, command: runtime === "opencode" ? "opencode" : "agy" }]]); },
      getPanePid: async () => { individualReads++; return 10; },
      getPaneCommand: async () => { individualReads++; return "node"; },
    } as unknown as TmuxAdapter;
    const reconciler = new SeatIdentityReconciler({ db: f.db, tmux, listProcesses: () => rows, readAntigravityLaunchIdentity: f.readAntigravityLaunchIdentity });
    await reconciler.reconcileAll();
    expect(new SeatIdentityStore(f.db).getForNode(f.node.id)?.verdict).toBe("verified");
    expect(batchReads).toBe(3);
    expect(individualReads).toBe(0);
    rows = [{ ...rows[0]!, executableName: "zsh", command: "zsh" }];
    await reconciler.reconcileAll();
    expect(new SeatIdentityStore(f.db).getForNode(f.node.id)?.verdict).toBe("mismatch");
  });
  it("keeps fresh Antigravity live without claiming a resumable conversation", async () => {
    const f = fixture("antigravity");
    f.db.prepare("UPDATE sessions SET resume_token = NULL WHERE id = ?").run(f.session.id);
    f.sessionRegistry.updateBinding(f.node.id, { tmuxSession: f.session.sessionName, tmuxPane: "%1" });
    const rows = f.rows.map(row => ({ ...row, command: "agy --model selected --log-file /tmp/native-test.log" }));
    const launch = { ...f.readAntigravityLaunchIdentity(), sessionId: undefined };
    const reader = () => launch;
    const reconciler = new SeatIdentityReconciler({ db: f.db, tmux: { ...f.tmux, listSessions: async () => [{ name: f.session.sessionName }] } as unknown as TmuxAdapter, listProcesses: () => rows, readAntigravityLaunchIdentity: reader });
    await reconciler.reconcileAll();
    expect(new SeatIdentityStore(f.db).getForNode(f.node.id)?.verdict).toBe("verified");
    const input = { db: f.db, sessionRegistry: f.sessionRegistry, tmux: f.tmux, nodeId: f.node.id, sessionName: f.session.sessionName, runtime: "antigravity", listProcesses: () => rows, readAntigravityLaunchIdentity: reader };
    expect((await rebindAndVerifyPaneIdentity(input)).ok).toBe(true);
    expect((await rebindAndVerifyPaneIdentity({ ...input, requireExactResumeLineage: true })).ok).toBe(false);
    launch.generation = "stale";
    await reconciler.reconcileAll();
    expect(new SeatIdentityStore(f.db).getForNode(f.node.id)?.verdict).toBe("mismatch");
  });
  it("uses only the named OpenCode seat's stored token and refuses Antigravity forks", () => {
    const f = fixture("opencode");
    expect(discoverResumeToken(f.db, f.session.sessionName)).toMatchObject({ ok: true, result: { runtime: "opencode", nativeId: f.token } });
    f.db.prepare("UPDATE sessions SET resume_token = NULL WHERE id = ?").run(f.session.id);
    expect(discoverResumeToken(f.db, f.session.sessionName)).toMatchObject({ ok: true, result: { nativeId: null } });
    const g = fixture("antigravity");
    expect(discoverResumeToken(g.db, g.session.sessionName)).toMatchObject({ ok: false, failure: { code: "runtime_unsupported" } });
  });
  it.each(["opencode", "antigravity"] as const)("reconciles %s without invalidating its live producer generation", async runtime => {
    const f = fixture(runtime);
    const generation = f.sessionRegistry.currentOccupantTenure(f.node.id)!.generationUuid;
    const proof = { ...f.readAntigravityLaunchIdentity() };
    const nativeSessionStores = { [runtime]: { readSessionId: (_name: string, expected?: string) => expected && expected !== generation
      ? { ok: false as const, reason: "launch_mismatch" } : { ok: true as const, sessionId: f.token } } };
    const deps = { db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: new EventBus(f.db), discoveryRepo: new DiscoveryRepository(f.db), tmuxAdapter: f.tmux,
      nativeSessionStores, listProcesses: () => f.rows, readAntigravityLaunchIdentity: () => proof };
    const service = new ClaimService(deps);
    expect(await service.reconcileSession({ sessionName: f.session.sessionName })).toMatchObject({ ok: true });
    expect(f.sessionRegistry.currentOccupantTenure(f.node.id)!.generationUuid).toBe(generation);
    expect(f.db.prepare("SELECT id, resume_token, status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.node.id)).toMatchObject({ id: f.session.id, resume_token: f.token, status: "running" });
    const app = new Hono();
    const activityStore = new AgentActivityStore({ db: f.db, eventBus: deps.eventBus, resolveOccupantGeneration: id => f.sessionRegistry.currentOccupantTenure(id)?.generationUuid ?? null, isRegisteredOccupantGeneration: (id, gen) => f.sessionRegistry.isOccupantGenerationRegistered(id, gen) });
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ agentActivityStore: activityStore, eventBus: deps.eventBus, sessionRegistry: f.sessionRegistry, activityHookToken: "test-token", runtimeAdapters: { [runtime]: { currentLaunchId: () => "current-launch" } } })) c.set(key as never, value as never);
      await next();
    });
    app.route("/activity", activityRoutes);
    const activityResponse = await app.request("/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-token" }, body: JSON.stringify({ runtime, nodeId: f.node.id, sessionName: f.session.sessionName, generation, launchId: "current-launch", sessionId: f.token, hookEvent: runtime === "opencode" ? "busy" : "active" }) });
    expect(activityResponse.status).toBe(200);
    const reconciler = new SeatIdentityReconciler({ db: f.db, tmux: { ...f.tmux, listSessions: async () => [{ name: f.session.sessionName }] } as unknown as TmuxAdapter, listProcesses: () => f.rows, readAntigravityLaunchIdentity: () => proof });
    await reconciler.reconcileAll();
    expect(new SeatIdentityStore(f.db).getForNode(f.node.id)?.verdict).toBe("verified");
    f.db.prepare("UPDATE sessions SET resume_token = NULL, resume_provenance = NULL WHERE id = ?").run(f.session.id);
    await new ResumeMetadataRefresher({ ...deps }).refresh([{ sessionId: f.session.id, sessionName: f.session.sessionName, runtime, resumeType: null, resumeToken: null }]);
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(f.session.id)).toEqual({ resume_token: f.token });
  });

  it.each(["opencode", "antigravity"] as const)("refuses unsupported discovered %s handover before changing the incumbent", async runtime => {
    const f = fixture(runtime);
    f.sessionRegistry.updateBinding(f.node.id, { tmuxSession: f.session.sessionName, tmuxPane: "%1" });
    const discoveryRepo = new DiscoveryRepository(f.db);
    const discovered = discoveryRepo.upsertDiscoveredSession({ tmuxSession: "unmanaged-shell", tmuxPane: "%2", runtimeHint: runtime, confidence: "high" });
    const before = ["sessions", "bindings", "occupant_tenures"].map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    const service = new SeatHandoverService({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, discoveryRepo, eventBus: new EventBus(f.db), tmuxAdapter: f.tmux });
    expect(await service.handover({ seatRef: f.session.sessionName, source: `discovered:${discovered.id}`, reason: "review regression" })).toMatchObject({ ok: false, code: "source_not_supported" });
    expect(["sessions", "bindings", "occupant_tenures"].map(table => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("active");
    expect(await service.handover({ seatRef: f.session.sessionName, source: `discovered:${discovered.id}`, dryRun: true, reason: "review regression" })).toMatchObject({ ok: false, code: "source_not_supported" });
    const claim = new ClaimService({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, discoveryRepo, eventBus: new EventBus(f.db), tmuxAdapter: f.tmux });
    const target = f.rigRepo.addNode(f.rig.id, "unbound", { runtime });
    const nodeCount = (f.db.prepare("SELECT COUNT(*) as count FROM nodes").get() as { count: number }).count;
    expect(await claim.bind({ discoveredId: discovered.id, rigId: f.rig.id, logicalId: target.logicalId })).toMatchObject({ ok: false, code: "runtime_unverified" });
    expect(await claim.createAndBindToPod({ discoveredId: discovered.id, rigId: f.rig.id, podId: "irrelevant", podNamespace: "pod", memberName: "new" })).toMatchObject({ ok: false, code: "runtime_unverified" });
    expect((f.db.prepare("SELECT COUNT(*) as count FROM nodes").get() as { count: number }).count).toBe(nodeCount);
    expect(["sessions", "bindings", "occupant_tenures"].map(table => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);

  });
  it.each(["opencode", "antigravity"] as const)("refuses %s adoption with unverified native process before mutation", async runtime => {
    const f = fixture(runtime);
    const service = new ClaimService({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: new EventBus(f.db), discoveryRepo: new DiscoveryRepository(f.db), tmuxAdapter: f.tmux,
      nativeSessionStores: { [runtime]: { readSessionId: () => ({ ok: true, sessionId: f.token }) } }, listProcesses: () => [] });
    const before = f.db.prepare("SELECT * FROM sessions").all();
    expect(await service.reconcileSession({ sessionName: f.session.sessionName })).toMatchObject({ ok: false, code: "reconcile_error" });
    expect(f.db.prepare("SELECT * FROM sessions").all()).toEqual(before);
  });
});
