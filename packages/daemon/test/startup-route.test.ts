import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { startupRevision } from "../src/routes/startup.js";
import { defaultProbeRuntimes } from "../src/domain/kernel-boot.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { existsSync, readFileSync } from "node:fs";
vi.mock("../src/domain/kernel-boot.js", async (original) => ({ ...await original<typeof import("../src/domain/kernel-boot.js")>(), defaultProbeRuntimes: vi.fn(async () => ({ codex: "ok", claudeCode: "ok" })) }));

describe("startup consent and effect boundary", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "ok", claudeCode: "ok" }); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  function seat() {
    const rig = setup.rigRepo.createRig("selected");
    const node = setup.rigRepo.addNode(rig.id, "operator.agent", { runtime: "codex", model: "configured-model" });
    const session = setup.sessionRegistry.registerSession(node.id, "operator-agent@selected");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%1" });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    return { rig, node, session };
  }
  function post(rigId: string, revision: string, action = "fresh") {
    return setup.app.request(`/api/startup/${rigId}/operator.agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, revision }) });
  }
  it("prepares the installed kernel definition once without launching any occupant", async () => {
    setup = createTestApp(db, { podInstantiatorFsOps: { exists: existsSync, readFile: (path) => readFileSync(path, "utf8") } });
    const request = () => setup.app.request("/api/startup/kernel", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime: "codex" }) });
    const first = await request();
    const body = await first.json();
    expect(body).toMatchObject({ ok: true, rigId: expect.any(String) });
    expect(first.status).toBe(200);
    expect(setup.rigRepo.getRig(body.rigId)!.nodes.map((node) => node.logicalId).sort())
      .toEqual(["advisor.lead", "operator.agent", "operator.human", "queue.worker"]);
    expect(setup.sessionRegistry.getSessionsForRig(body.rigId)).toEqual([]);
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    const second = await request();
    expect(await second.json()).toMatchObject({ ok: true, rigId: body.rigId, reused: true });
  });
  it.each([["opencode", "openrouter/vendor/model"], ["antigravity", "antigravity-test-model"]])("materializes an explicit %s kernel without Claude or Codex", async (runtime, model) => {
    setup = createTestApp(db, { podInstantiatorFsOps: { exists: existsSync, readFile: (path) => readFileSync(path, "utf8") } });
    vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "unavailable", claudeCode: "unavailable", opencode: "ok", antigravity: "ok" });
    const request = (model?: string) => setup.app.request("/api/startup/kernel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime, model }) });
    expect((await request()).status).toBe(400);
    expect(setup.rigRepo.findRigsByName("kernel")).toEqual([]);
    const response = await request(model); const body = await response.json();
    expect(body).toMatchObject({ ok: true, rigId: expect.any(String) });
    const agents = setup.rigRepo.getRig(body.rigId)!.nodes.filter(node => node.runtime !== "terminal");
    expect(agents).toHaveLength(3);
    expect(agents.every(node => node.runtime === runtime && node.model === model)).toBe(true);
    expect(setup.sessionRegistry.getSessionsForRig(body.rigId)).toEqual([]);
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
  });
  it("rejects a changed occupant or model before invoking fresh launch", async () => {
    const { rig, node } = seat(); const revision = startupRevision(db, node);
    db.prepare("UPDATE nodes SET model = ? WHERE id = ?").run("changed-model", node.id);
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, revision);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "selection_changed" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("does not replace an unprobeable pane", async () => {
    const { rig, node } = seat();
    vi.mocked(setup.tmuxAdapter.probeSession).mockRejectedValue(new Error("tmux unavailable"));
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, startupRevision(db, node));
    expect(await response.json()).toMatchObject({ ok: false, code: "unverified" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("checks provider prerequisite before fresh and keeps stored model/history", async () => {
    const { rig, node, session } = seat();
    vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "unavailable", claudeCode: "ok" });
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, startupRevision(db, node));
    expect(await response.json()).toMatchObject({ code: "provider_prerequisite", freshAllowed: false });
    expect(launch).not.toHaveBeenCalled();
    expect(setup.rigRepo.getRig(rig.id)!.nodes[0]!.model).toBe("configured-model");
    expect(setup.sessionRegistry.getSessionsForRig(rig.id).map((s) => s.id)).toEqual([session.id]);
    const readback = await setup.app.request(`/api/startup/${rig.id}`);
    expect((await readback.json()).seats[0]).toMatchObject({ freshAllowed: false, prerequisite: expect.stringContaining("unauthenticated") });
  });
  it("reports unavailable transport without authorizing fresh replacement", async () => {
    const { rig, node } = seat();
    vi.mocked(setup.tmuxAdapter.probeSession).mockResolvedValue({ state: "transport_unavailable", cause: "no server" });
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, startupRevision(db, node));
    expect(await response.json()).toMatchObject({ ok: false, code: "transport_unavailable" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("serializes repeated fresh requests and passes exact scope to the existing lifecycle", async () => {
    const { rig, node } = seat(); const revision = startupRevision(db, node);
    let finish!: (value: never) => void;
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = post(rig.id, revision);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const second = await post(rig.id, revision);
    expect(await second.json()).toMatchObject({ code: "operation_in_progress" });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ seatRef: "operator-agent@selected", fresh: true, stop: false, reason: expect.stringContaining(revision) }));
    finish({ ok: false, code: "startup_context_missing", message: "fixture refuses launch" } as never);
    await first;
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
