/** Opt-in, non-billable native contract test. Never submits a model prompt. */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { verifyAdditionalNativePaneProcess } from "../src/domain/native-process-lineage.js";
import { classifyOpenCodePrompt, opencodeLaunchStatePath } from "../src/adapters/opencode-runner-protocol.js";
import { OpenCodeRuntimeAdapter } from "../src/adapters/opencode-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const enabled = process.env.OPENRIG_OPENCODE_NATIVE_SMOKE === "1";
describe.skipIf(!enabled)("OpenCode 1.18 native non-billable contract", () => {
  it("preserves explicit model and identity across native attach, resize, draft, stop, resume and fork", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-opencode-native-"));
    const socket = `openrig-oc-${process.pid}`;
    const binary = process.env.OPENRIG_OPENCODE_BINARY || execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
    const repo = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const runner = fileURLToPath(new URL("../src/adapters/opencode-runner.ts", import.meta.url));
    const model = "opencode/nemotron-3.5-lightning-free";
    const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "xdgstate"), PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, TERM: "xterm-256color", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
    const statePath = path.join(root, "state", "seat", "runner-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const state = () => {
      const pointer = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return JSON.parse(fs.readFileSync(opencodeLaunchStatePath(path.join(root, "state"), "seat", pointer.launchId), "utf8"));
    };
    const until = async (fn: () => boolean) => { for (let i = 0; i < 80; i++) { try { if (fn()) return; } catch { /* booting */ } await wait(250); } throw new Error("Native contract timed out: " + (fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "no sidecar")); };
    const waitForExit = () => until(() => { try { tmux("has-session", "-t", "seat"); return false; } catch { return true; } });
    const launch = (attempt: string, extra: string[] = []) => {
      fs.writeFileSync(statePath, JSON.stringify({ launchId: attempt, backendReady: false }));
      const command = ["env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, "--import", path.join(repo, "node_modules/tsx/dist/loader.mjs"), runner, "--state-root", path.join(root, "state"), "--session", "seat", "--launch-id", attempt, "--cwd", root, "--model", model, "--name", "OpenRig non-billable native fixture", "--executable", binary, ...extra].map(shellQuote).join(" ");
      tmux("new-session", "-d", "-s", "seat", "-x", "130", "-y", "35", command);
    };
    const stop = async () => { tmux("kill-session", "-t", "seat"); await until(() => state().exited === true); };
    try {
      launch("fresh");
      await until(() => state().backendReady && /Nemotron 3.5 Lightning Free/.test(tmux("capture-pane", "-p", "-t", "seat")));
      const id = state().sessionId;
      expect(id).toMatch(/^ses_/);
      expect(await verifyAdditionalNativePaneProcess({ target: "seat", expectedToken: id,
        tmux: { getPanePid: async () => Number(tmux("display-message", "-p", "-t", "seat", "#{pane_pid}").trim()) } }, "opencode")).not.toBeNull();
      const adapter = new OpenCodeRuntimeAdapter({ stateRoot: path.join(root, "state"), runnerEntryPath: runner, fsOps: { readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p, data) => fs.writeFileSync(p, data), mkdirp: p => { fs.mkdirSync(p, { recursive: true }); }, exists: fs.existsSync }, tmux: { hasSession: async () => true, getPaneCommand: async () => tmux("display-message", "-p", "-t", "seat", "#{pane_current_command}").trim(), capturePaneContent: async () => tmux("capture-pane", "-p", "-t", "seat") } as unknown as TmuxAdapter });
      expect((await adapter.checkReady({ tmuxSession: "seat" } as NodeBinding)).ready).toBe(true);
      for (const keys of [["C-p"], ["C-x", "m"], ["C-x", "l"]]) {
        tmux("send-keys", "-t", "seat", ...keys);
        await until(() => /(?:Commands|Select model|Sessions)\s+esc/.test(tmux("capture-pane", "-p", "-t", "seat")));
        expect(classifyOpenCodePrompt(tmux("capture-pane", "-p", "-t", "seat"))).toBe("unknown");
        expect((await adapter.checkReady({ tmuxSession: "seat" } as NodeBinding)).ready).toBe(false);
        tmux("send-keys", "-t", "seat", "Escape");
        await until(() => classifyOpenCodePrompt(tmux("capture-pane", "-p", "-t", "seat")) === "empty");
      }
      tmux("send-keys", "-t", "seat", "Tab");
      await until(() => /Plan · Nemotron 3.5 Lightning Free/.test(tmux("capture-pane", "-p", "-t", "seat")));
      tmux("resize-window", "-t", "seat", "-x", "90", "-y", "30");
      tmux("send-keys", "-t", "seat", "-l", "UNSUBMITTED OPENRIG DRAFT");
      await until(() => tmux("capture-pane", "-p", "-t", "seat").includes("UNSUBMITTED OPENRIG DRAFT"));
      expect(classifyOpenCodePrompt(tmux("capture-pane", "-p", "-t", "seat"))).toBe("draft");
      // Killing the terminal discards this draft; no Enter/model request is sent.
      await stop();
      launch("resume", ["--resume", id]);
      await until(() => state().launchId === "resume" && state().backendReady);
      expect(state().sessionId).toBe(id);
      await stop();
      launch("fork", ["--fork", id]);
      await until(() => state().launchId === "fork" && state().backendReady);
      expect(state().sessionId).not.toBe(id);
      await stop();
      const nativeConfig = path.join(root, "opencode.json");
      fs.writeFileSync(nativeConfig, JSON.stringify({ agent: { build: { model: "opencode/big-pickle" } } }));
      for (const [attempt, extra] of [["conflicting-fresh", []], ["conflicting-resume", ["--resume", id]], ["conflicting-fork", ["--fork", id]]] as Array<[string, string[]]>) {
        launch(attempt, extra);
        await until(() => state().exited === true);
        expect(state().error).toMatch(/agent "build" overrides the requested model/);
        expect(state().backendReady).toBe(false);
        expect(state().sessionId).toBeUndefined();
        await waitForExit();
      }
      fs.writeFileSync(nativeConfig, JSON.stringify({ default_agent: "custom", agent: { custom: { mode: "primary", model: "opencode/big-pickle" } } }));
      launch("conflicting-custom");
      await until(() => state().exited === true);
      expect(state().error).toMatch(/agent "custom" overrides the requested model/);
      await waitForExit();
      fs.writeFileSync(nativeConfig, JSON.stringify({ small_model: "opencode/big-pickle", agent: { explore: { model: "opencode/big-pickle" } } }));
      launch("auxiliary-preserved");
      await until(() => state().backendReady && /Nemotron 3.5 Lightning Free/.test(tmux("capture-pane", "-p", "-t", "seat")));
      await stop();
      fs.unlinkSync(nativeConfig);
      launch("invalid-model", ["--model", "opencode/not-a-real-model"]);
      await until(() => state().launchId === "invalid-model" && state().exited);
      expect(state().error).toMatch(/catalog.*refusing fallback/);
      expect(state().sessionId).toBeUndefined();
      await waitForExit();
      launch("missing-resume", ["--resume", "ses_missingOpenRigFixture"]);
      await until(() => state().launchId === "missing-resume" && state().exited);
      expect(state().error).toMatch(/returned 404/);
      expect(state().sessionId).toBeUndefined();
    } finally { try { tmux("kill-server"); } catch { /* already exited */ } fs.rmSync(root, { recursive: true, force: true }); }
  }, 90000);
});
