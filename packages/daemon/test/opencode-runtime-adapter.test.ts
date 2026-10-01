import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { OpenCodeRuntimeAdapter } from "../src/adapters/opencode-runtime-adapter.js";
import { assertOpenCodePrimaryModels, createOpenCodeEventMapper, classifyOpenCodePrompt, parseOpenCodeConfig, validOpenCodeSessionId, opencodeLaunchStatePath, opencodeSeatPaths } from "../src/adapters/opencode-runner-protocol.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function fixture() {
  const files = new Map<string, string>();
  const binding = { tmuxSession: "seat", cwd: "/repo", model: "openrouter/vendor/exact" } as NodeBinding;
  const tmux = { sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })), hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), capturePaneContent: vi.fn(async () => "  ┃\n  ┃\n  ┃  Build · Explicit Model\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀") };
  const fsOps = { readFile: (p: string) => { if (!files.has(p)) throw Error("missing"); return files.get(p)!; }, writeFile: (p: string, s: string) => { files.set(p, s); }, exists: (p: string) => files.has(p), mkdirp: vi.fn() };
  const adapter = new OpenCodeRuntimeAdapter({ tmux: tmux as unknown as TmuxAdapter, fsOps, stateRoot: "/state", runnerEntryPath: "/runner.js", newLaunchId: () => "attempt", sleep: async () => {} });
  return { files, binding, tmux, adapter, state: opencodeSeatPaths("/state", "seat").runnerStatePath };
}
describe("OpenCode integration boundary", () => {
  it("filters child events and retains parallel permission blocks until all replies", () => {
    const map = createOpenCodeEventMapper("ses_bound");
    const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, properties: { sessionID: "ses_bound", ...extra } });
    expect(map(event("session.status", { sessionID: "ses_child", status: { type: "busy" } }))).toBeUndefined();
    expect(map(event("permission.asked", { id: "one" }))).toBe("PermissionRequest");
    expect(map(event("question.asked", { id: "two" }))).toBe("PermissionRequest");
    expect(map(event("permission.replied", { requestID: "one" }))).toBeUndefined();
    expect(map(event("session.status", { status: { type: "idle" } }))).toBeUndefined();
    expect(map(event("question.rejected", { requestID: "two" }))).toBe("UserPromptSubmit");
    expect(map(event("session.status", { status: { type: "idle" } }))).toBe("Stop");
  });
  it("classifies bounded native prompt content without trusting footer or sidebar", () => {
    const frame = "  ┃                               Sidebar\n  ┃                               tokens\n  ┃  Build · Model                other\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀";
    expect(classifyOpenCodePrompt(frame)).toBe("empty");
    expect(classifyOpenCodePrompt(frame.replace("  ┃                               tokens", "  ┃ draft                         tokens"))).toBe("draft");
    expect(classifyOpenCodePrompt("ctrl+p commands")).toBe("unknown");
  });
  it.each(["commands", "models", "sessions"])("refuses native %s overlays even though their empty composer stays visible", (kind) => {
    const pane = readFileSync(new URL(`./fixtures/opencode/${kind}.txt`, import.meta.url), "utf8");
    expect(classifyOpenCodePrompt(pane)).toBe("unknown");
    expect(classifyOpenCodePrompt(`Assistant: Commands and Select model dialogs display esc then Search.\n  ┃\n  ┃\n  ┃  Build · Model\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀`)).toBe("empty");
  });
  it("rejects narrow native question/permission overlays without rejecting transcript mentions", () => {
    const empty = "  ┃\n  ┃\n  ┃  Build · Model\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀";
    for (const label of ["Allow once enter", "Allow always ctrl+a", "Permission required — bash", "Sign in with provider enter", "Enter your API key >"]) expect(classifyOpenCodePrompt(`${label}\n${empty}`)).toBe("unknown");
    for (const title of ["Question", "Permission", "Select agent"]) expect(classifyOpenCodePrompt(`  ${title}         esc\n\n  Select an option\n${empty}`)).toBe("unknown");
    expect(classifyOpenCodePrompt(`Assistant: Select the Commands dialog and press esc.\n${empty}`)).toBe("empty");
  });
  it("validates all switchable primary agent models without changing auxiliary models", () => {
    const requested = "openrouter/vendor/exact";
    const primary = { name: "build", mode: "primary", model: { providerID: "openrouter", modelID: "vendor/exact" } };
    const wrong = { providerID: "openrouter", modelID: "vendor/other" };
    expect(() => assertOpenCodePrimaryModels([primary, {name:"title",mode:"primary",hidden:true,model:wrong}, {name:"explore",mode:"subagent",model:wrong}],requested)).not.toThrow();
    for (const agent of [{...primary,model:wrong},{...primary,name:"plan",model:wrong},{...primary,name:"custom",mode:"all",model:wrong}]) expect(() => assertOpenCodePrimaryModels([agent],requested)).toThrow(/overrides the requested model/);
    expect(() => assertOpenCodePrimaryModels([{...primary,hidden:true,model:wrong}],requested,"build")).toThrow(/overrides the requested model/);
    expect(() => assertOpenCodePrimaryModels([primary],requested,"missing")).toThrow(/unavailable/);
  });
  it("refuses implicit model and unsupported permission weakening before typing", async () => {
    const f = fixture();
    expect((await f.adapter.launchHarness({ ...f.binding, model: undefined }, { name: "a" })).ok).toBe(false);
    expect((await f.adapter.launchHarness({ ...f.binding, launchPosture: "full_bypass" }, { name: "a" })).ok).toBe(false);
    expect(f.tmux.sendText).not.toHaveBeenCalled();
  });
  it("launches an exact resumed identity and quotes model configuration", async () => {
    const f = fixture();
    f.tmux.sendKeys.mockImplementation(async () => { f.files.set(f.state, JSON.stringify({ launchId: "attempt", backendReady: true, sessionId: "ses_abc123" })); return { ok: true }; });
    expect(await f.adapter.launchHarness(f.binding, { name: "a's seat", resumeToken: "ses_abc123" })).toMatchObject({ ok: true, resumeType: "opencode_id", resumeToken: "ses_abc123" });
    expect(f.tmux.sendText.mock.calls[0]).toEqual(["seat", expect.stringContaining("openrouter/vendor/exact")]);
  });
  it("does not trust stale launch sidecars", async () => {
    const f = fixture();
    f.tmux.sendKeys.mockImplementation(async () => { f.files.set(f.state, JSON.stringify({ launchId: "old", backendReady: true, sessionId: "ses_old" })); return { ok: true }; });
    expect((await f.adapter.launchHarness(f.binding, { name: "a" })).ok).toBe(false);
  });
  it("requires a live terminal prompt as well as API readiness", async () => {
    const f = fixture(); f.files.set(f.state, JSON.stringify({ launchId: "attempt", backendReady: true, sessionId: "ses_abc" }));
    expect((await f.adapter.checkReady(f.binding)).ready).toBe(true);
    f.tmux.getPaneCommand.mockResolvedValue("zsh");
    expect((await f.adapter.checkReady(f.binding)).ready).toBe(false);
  });
  it("preserves operator modifications to projected config and refuses ambiguous config selection", async () => {
    const f = fixture();
    f.files.set("/source.json", '{"permission":{"bash":"ask"}}');
    const entry = { category: "runtime_resource", resourceType: "opencode_config", absolutePath: "/source.json", effectiveId: "native", classification: "safe_projection" };
    const plan = { entries: [entry] } as unknown as ProjectionPlan;
    expect((await f.adapter.project(plan, f.binding)).projected).toEqual(["native"]);
    const target = opencodeSeatPaths("/state", "seat").configPath;
    f.files.set(target, '{"permission":{"bash":"deny"}}');
    f.files.set("/source.json", '{"permission":{"bash":"allow"}}');
    expect((await f.adapter.project(plan, f.binding)).failed[0]?.error).toMatch(/operator-modified/);
    expect(f.files.get(target)).toContain("deny");
    expect((await f.adapter.project({ entries: [entry, entry] } as unknown as ProjectionPlan, f.binding)).failed[0]?.error).toMatch(/only one/);
  });
  it("resets removed config only for fresh projection and preserves selected no-op/exact resume config", async () => {
    const f = fixture();
    const entry = { category: "runtime_resource", resourceType: "opencode_config", absolutePath: "/source.json", effectiveId: "native", classification: "safe_projection" };
    f.files.set("/source.json", '{"permission":{"bash":"deny"}}');
    await f.adapter.project({ entries: [entry] } as unknown as ProjectionPlan, f.binding);
    const target = opencodeSeatPaths("/state", "seat").configPath;
    await f.adapter.project({ entries: [], preserveRuntimeSettings: true } as unknown as ProjectionPlan, f.binding);
    expect(f.files.get(target)).toContain("deny");
    await f.adapter.project({ entries: [{ ...entry, classification: "no_op" }] } as unknown as ProjectionPlan, f.binding);
    expect(f.files.get(target)).toContain("deny");
    const rejected = await f.adapter.project({ entries: [{ category: "guidance", effectiveId: "blocked", classification: "operator_conflict" }] } as unknown as ProjectionPlan, f.binding);
    expect(rejected.failed).toHaveLength(1);
    expect(f.files.get(target)).toContain("deny");
    await f.adapter.project({ entries: [] } as unknown as ProjectionPlan, f.binding);
    expect(f.files.get(target)).toBe("{}");
  });
  it("ignores a predecessor runner writing its isolated attempt after replacement", async () => {
    const f = fixture();
    f.files.set(f.state, JSON.stringify({ launchId: "current", backendReady: false }));
    f.files.set(opencodeLaunchStatePath("/state", "seat", "current"), JSON.stringify({ launchId: "current", backendReady: true, sessionId: "ses_current" }));
    f.files.set(opencodeLaunchStatePath("/state", "seat", "old"), JSON.stringify({ launchId: "old", backendReady: true, sessionId: "ses_old" }));
    expect(f.adapter.currentLaunchId("seat")).toBe("current");
    expect(f.adapter.currentLaunchId("missing")).toBeNull();
    expect(f.adapter.readSessionId("seat")).toEqual({ ok: true, sessionId: "ses_current" });
    f.files.set(opencodeLaunchStatePath("/state", "seat", "old"), JSON.stringify({ launchId: "old", backendReady: false, exited: true }));
    expect((await f.adapter.checkReady(f.binding)).ready).toBe(true);
  });
  it("does not capture or trust readiness from a previous occupant before the launch pointer is reset", async () => {
    const f = fixture();
    f.files.set(f.state, JSON.stringify({ launchId: "previous", generation: "old-generation", backendReady: false }));
    f.files.set(opencodeLaunchStatePath("/state", "seat", "previous"), JSON.stringify({ launchId: "previous", backendReady: true, sessionId: "ses_previous" }));
    expect(f.adapter.readSessionId("seat", "new-generation").ok).toBe(false);
    expect((await f.adapter.checkReady({ ...f.binding, launchGeneration: "new-generation" })).ready).toBe(false);
    expect((await f.adapter.checkReady({ ...f.binding, launchGeneration: "old-generation" })).ready).toBe(true);
    expect(f.adapter.readSessionId("seat", "old-generation")).toEqual({ ok: true, sessionId: "ses_previous" });
    expect(f.adapter.readSessionId("seat")).toEqual({ ok: true, sessionId: "ses_previous" });
  });
  it("refuses a fork sidecar that still identifies its parent", async () => {
    const f = fixture();
    f.tmux.sendKeys.mockImplementation(async () => { f.files.set(f.state, JSON.stringify({ launchId: "attempt", backendReady: true, sessionId: "ses_parent" })); return { ok: true }; });
    expect((await f.adapter.launchHarness(f.binding, { name: "fork", forkSource: { kind: "native_id", value: "ses_parent" } })).ok).toBe(false);
  });
  it("validates native identities and rejects raw credentials/config executable injection", () => {
    expect(validOpenCodeSessionId("ses_abc123")).toBe(true);
    expect(validOpenCodeSessionId("ses_abc; evil")).toBe(false);
    expect(() => parseOpenCodeConfig('{"provider":{"openrouter":{"options":{"apiKey":"secret"}}}}')).toThrow("credentials");
    expect(parseOpenCodeConfig('{"provider":{"openrouter":{"options":{"apiKey":"{env:OPENROUTER_API_KEY}"}}}}')).toBeTruthy();
    expect(() => parseOpenCodeConfig('{"plugin":["arbitrary-package"]}')).toThrow("Unsupported");
  });
});
