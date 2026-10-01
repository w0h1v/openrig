import { describe, expect, it, vi } from "vitest";
import { ClaimService } from "../src/domain/claim-service.js";
import { verifyAdditionalNativePaneProcess } from "../src/domain/native-process-lineage.js";

vi.mock("../src/domain/native-process-lineage.js", () => ({ verifyAdditionalNativePaneProcess: vi.fn() }));

type CaptureInput = { rigId: string; nodeId: string; sessionId: string; sessionName: string; runtime: string };
type ClaimCaptureBoundary = {
  captureResumeTokenOnAdoption(input: CaptureInput): Promise<void>;
  verifyAdditionalNativeAdoption(runtime: string, session: string, pane: { ok: true; pane: string }): Promise<boolean>;
};
describe.each([
  { runtime: "opencode", token: "ses_currentGeneration", resumeType: "opencode_id" },
  { runtime: "antigravity", token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", resumeType: "antigravity_id" },
])("$runtime claim generation boundary", ({ runtime, token, resumeType }) => {
  function setup() {
    const db = {};
    const live: { generation: string | null } = { generation: "current" };
    const updateResumeToken = vi.fn(() => true);
    const readSessionId = vi.fn(() => ({ ok: true as const, sessionId: token }));
    const emit = vi.fn();
    const deps = { db, rigRepo: { db }, discoveryRepo: { db }, eventBus: { db, emit },
      sessionRegistry: { db, currentOccupantGenerationForSession: () => live.generation, updateResumeToken },
      tmuxAdapter: {}, nativeSessionStores: { [runtime]: { readSessionId } } };
    // Exercise the two async boundaries directly, independently of adoption's SQL transaction.
    const service = new ClaimService(deps as unknown as ConstructorParameters<typeof ClaimService>[0]) as unknown as ClaimCaptureBoundary;
    const input = { rigId: "rig", nodeId: "node", sessionId: "row", sessionName: "seat", runtime };
    vi.mocked(verifyAdditionalNativePaneProcess).mockReset().mockResolvedValue({} as never);
    return { live, readSessionId, updateResumeToken, emit, service, input,
      verify: () => service.verifyAdditionalNativeAdoption(runtime, "seat", { ok: true, pane: "%1" }) };
  }
  it("captures and verifies with one stable generation", async () => {
    const f = setup();
    expect(await f.verify()).toBe(true);
    expect(verifyAdditionalNativePaneProcess).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: "current", expectedToken: token }), runtime);
    await f.service.captureResumeTokenOnAdoption(f.input);
    expect(f.readSessionId).toHaveBeenCalledWith("seat", "current");
    expect(f.updateResumeToken).toHaveBeenCalledWith("row", resumeType, token, "adoption");
  });
  it("refuses unowned sidecars without a managed generation", async () => {
    const f = setup(); f.live.generation = null;
    expect(await f.verify()).toBe(false);
    await f.service.captureResumeTokenOnAdoption(f.input);
    expect(f.readSessionId).not.toHaveBeenCalled();
    expect(verifyAdditionalNativePaneProcess).not.toHaveBeenCalled();
    expect(f.updateResumeToken).not.toHaveBeenCalled();
  });
  it("drops predecessor identity when derivation crosses an occupant change", async () => {
    const f = setup();
    f.readSessionId.mockImplementation(() => { f.live.generation = "replacement"; return { ok: true, sessionId: token }; });
    expect(await f.verify()).toBe(false);
    expect(verifyAdditionalNativePaneProcess).not.toHaveBeenCalled();
    f.live.generation = "current";
    await f.service.captureResumeTokenOnAdoption(f.input);
    expect(f.updateResumeToken).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "skipped", redacted: true }));
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain(token);
  });
  it("rejects process proof completed after an occupant change", async () => {
    const f = setup();
    vi.mocked(verifyAdditionalNativePaneProcess).mockImplementation(async () => { f.live.generation = "replacement"; return {} as never; });
    expect(await f.verify()).toBe(false);
  });
});
