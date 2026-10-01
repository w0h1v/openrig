import { describe, it, expect, vi } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const fixtures = [
  { runtime: "opencode", token: "ses_generationBound", resumeType: "opencode_id" },
  { runtime: "antigravity", token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", resumeType: "antigravity_id" },
];
describe.each(fixtures)("$runtime resume-generation capture", ({ runtime, token, resumeType }) => {
  function setup() {
    const live: { generation: string | null } = { generation: "current" };
    const updateResumeToken = vi.fn();
    const readSessionId = vi.fn((_session: string, expectedGeneration?: string): { ok: true; sessionId: string } | { ok: false; reason: string } => expectedGeneration === "current"
      ? { ok: true, sessionId: token } : { ok: false, reason: "generation_mismatch" });
    const registry = { currentOccupantGenerationForSession: () => live.generation, updateResumeToken } as unknown as SessionRegistry;
    const stores = { [runtime]: { readSessionId } };
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: registry, tmuxAdapter: {} as TmuxAdapter, nativeSessionStores: stores });
    const session = { sessionId: "row", sessionName: "seat", runtime, resumeType: null, resumeToken: null };
    return { live, updateResumeToken, readSessionId, stores, refresher, session };
  }
  it("passes the expected generation through derivation and rejects an old pointer", async () => {
    const f = setup();
    expect(await deriveResumeToken({ runtime, sessionName: "seat", generation: "replacement" }, { nativeSessionStores: f.stores })).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
    expect(f.readSessionId).toHaveBeenCalledWith("seat", "replacement");
  });
  it("refreshes only an identity derived from the current generation", async () => {
    const f = setup();
    await f.refresher.refresh([f.session], { fillNullOnly: true });
    expect(f.readSessionId).toHaveBeenCalledWith("seat", "current");
    expect(f.updateResumeToken).toHaveBeenCalledWith("row", resumeType, token, "scrape");
    f.live.generation = "replacement";
    f.updateResumeToken.mockClear();
    await f.refresher.refresh([f.session], { fillNullOnly: true });
    expect(f.updateResumeToken).not.toHaveBeenCalled();
  });
  it("drops a capture when the occupant swaps before persistence", async () => {
    const f = setup();
    f.readSessionId.mockImplementation(() => { f.live.generation = "replacement"; return { ok: true, sessionId: token }; });
    await f.refresher.refresh([f.session], { fillNullOnly: true });
    expect(f.updateResumeToken).not.toHaveBeenCalled();
  });
  it("never falls back to ungated capture when generation is unavailable", async () => {
    const f = setup();
    f.live.generation = null;
    await f.refresher.refresh([f.session], { fillNullOnly: true });
    expect(f.readSessionId).not.toHaveBeenCalled();
    expect(f.updateResumeToken).not.toHaveBeenCalled();
  });
});
