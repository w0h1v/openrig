import type Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { runtimeRungInventory } from "../src/domain/activity-taxonomy.js";
import type { StructuralObservation } from "../src/domain/seat-structural-activity-service.js";

const empty = "  ┃\n  ┃\n  ┃  Build · Model\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀";
describe("native structural and needs-input arbitration", () => {
  it("passes runtime into the prompt classifier and rejects shell scrollback", async () => {
    let command = "opencode";
    let content = empty;
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content, getPaneCommand: async () => command });
    expect((await service.pollSeat("seat", "opencode"))?.state).toBe("agent_idle");
    content = "Permission required\nAllow once\n" + empty;
    expect((await service.pollSeat("seat", "opencode"))?.state).toBe("attention");
    command = "zsh";
    expect(await service.pollSeat("seat", "opencode")).toBeNull();
    expect(service.getStructuralActivity("seat")).toBeNull();
  });
  it("keeps Antigravity transcript mentions idle while real login dialogs need attention", async () => {
    const composer = "────────────────────────\n>\n────────────────────────\n? for shortcuts  model";
    let content = "Assistant: Explain Select login method and failed to resume.\n" + composer;
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content, getPaneCommand: async () => "agy" });
    expect((await service.pollSeat("seat", "antigravity"))?.state).toBe("agent_idle");
    content = "Select login method:\n> 1. Google OAuth\n↑/↓ Navigate · enter Select\n" + composer;
    expect((await service.pollSeat("seat", "antigravity"))?.state).toBe("attention");
  });
  it.each(["opencode", "antigravity"])("shows fenced %s permission hooks without promoting lifecycle activity", runtime => {
    let now = Date.parse("2026-09-30T12:00:00Z");
    let observation: StructuralObservation | null = null;
    const service = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(now), structuralReader: () => observation });
    service.declareRungInventory({ seatNodeId: "node", sessionName: "seat" }, runtimeRungInventory(runtime));
    service.reportEvidence({ seatNodeId: "node", sessionName: "seat", rung: "lifecycle-hooks", sourceId: `${runtime}:hooks`, seq: 1, observedAt: new Date(now).toISOString(), needsInput: { count: 1, reason: "permission_request" } });
    expect(service.getSeatState("node")?.needsInput.count).toBe(1);
    expect(service.getSeatState("node")?.activity).toBe("unknown");
    now += 1000;
    observation = { state: "agent_idle", reason: "native_empty_prompt", evidence: null, observedAt: new Date(now).toISOString() };
    expect(service.getSeatState("node")?.needsInput.count).toBe(0);
    observation = null;
    now += 6000;
    expect(service.getSeatState("node")?.needsInput.count).toBe(0);
    observation = { state: "attention", reason: "native_input_required", evidence: null, observedAt: new Date(now).toISOString() };
    expect(service.getSeatState("node")?.needsInput.count).toBe(1);
  });
  it("drops an in-flight pane capture when occupant generation changes", async () => {
    let generation = "old";
    const db = { prepare: () => ({ all: () => [{ session_name: "seat", node_id: "node", runtime: "opencode" }], get: () => ({ generation_uuid: generation }) }) } as unknown as Database.Database;
    const service = new SeatStructuralActivityService({ getPaneCommand: async () => "opencode", capturePaneContent: async () => { generation = "new"; return empty; } });
    await service.pollAllRunningTmuxSeats(db);
    expect(service.getStructuralActivity("seat")).toBeNull();
    await service.pollAllRunningTmuxSeats(db);
    expect(service.getStructuralActivity("seat")?.state).toBe("agent_idle");
  });
  it("fences native batched captures across a generation swap and retains their capture timestamp", async () => {
    let generation = "old";
    let changeGeneration = true;
    let fallbackCaptures = 0;
    const capturedAt = new Date("2026-10-01T12:00:00Z");
    const db = { prepare: () => ({ all: () => [{ session_name: "seat", node_id: "node", runtime: "opencode" }], get: () => ({ generation_uuid: generation }) }) } as unknown as Database.Database;
    const service = new SeatStructuralActivityService({
      getPaneCommand: async () => "opencode",
      capturePaneContent: async () => { fallbackCaptures++; return empty; },
      capturePanesContent: async () => {
        if (changeGeneration) generation = "new";
        return new Map([["seat", { text: empty, capturedAt }]]);
      },
    }, () => new Date(capturedAt.getTime() + 1000));
    await service.pollAllRunningTmuxSeats(db);
    expect(service.getStructuralActivity("seat")).toBeNull();
    changeGeneration = false;
    await service.pollAllRunningTmuxSeats(db);
    expect(service.getStructuralActivity("seat")).toMatchObject({ state: "agent_idle", observedAt: capturedAt.toISOString() });
    expect(fallbackCaptures).toBe(0);
  });
  it("never carries predecessor permission chrome across an occupant swap", () => {
    let now = Date.parse("2026-09-30T12:00:00Z");
    const observation: StructuralObservation = { state: "attention", reason: "permission", evidence: null, observedAt: new Date(now).toISOString() };
    const service = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(now), structuralReader: () => observation });
    const binding = { seatNodeId: "node", sessionName: "seat" };
    service.declareRungInventory(binding, runtimeRungInventory("opencode"));
    expect(service.getSeatState("node")?.needsInput.count).toBe(1);
    now += 1;
    service.declareOccupantSwap("node", "new-generation");
    service.declareRungInventory(binding, runtimeRungInventory("opencode"));
    expect(service.getSeatState("node")?.needsInput.count).toBe(0);
  });
  it("never derives native idle from timestamp silence without a visible empty prompt", () => {
    const time = "2026-09-30T12:00:00Z";
    const service = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(time) });
    service.declareRungInventory({ seatNodeId: "node", sessionName: "seat" }, runtimeRungInventory("opencode"));
    service.reportEvidence({ seatNodeId: "node", sessionName: "seat", rung: "window-sampling", sourceId: "sampling", seq: 1, observedAt: time, activity: "idle-at-prompt" });
    expect(service.getSeatState("node")?.activity).toBe("unknown");
  });
});
