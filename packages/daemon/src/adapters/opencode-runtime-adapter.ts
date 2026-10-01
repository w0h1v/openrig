import nodePath from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { RuntimeAdapter, NodeBinding, InstalledResource, ProjectionResult, StartupDeliveryResult, ResolvedStartupFile, ReadinessResult, HarnessLaunchResult, ForkSource } from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { shellQuote } from "./shell-quote.js";
import { classifyOpenCodePrompt, opencodeLaunchStatePath, opencodeSeatPaths, parseOpenCodeState, parseOpenCodeConfig, validOpenCodeSessionId } from "./opencode-runner-protocol.js";
export interface OpenCodeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(path: string): string[];
}
export interface OpenCodeRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: OpenCodeAdapterFsOps;
  stateRoot: string;
  runnerEntryPath: string;
  executable?: string;
  recordProjection?: (path: string, content: string) => void;
  sleep?: (ms: number) => Promise<void>;
  newLaunchId?: () => string;
}
export class OpenCodeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "opencode";
  private tmux: TmuxAdapter;
  private fs: OpenCodeAdapterFsOps;
  private stateRoot: string;
  private sleep: (ms: number) => Promise<void>;
  constructor(private deps: OpenCodeRuntimeAdapterDeps) {
    this.tmux = deps.tmux; this.fs = deps.fsOps; this.stateRoot = deps.stateRoot;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  currentLaunchId(session: string): string | null {
    try {
      return parseOpenCodeState(this.fs.readFile(opencodeSeatPaths(this.stateRoot, session).runnerStatePath))?.launchId ?? null;
    } catch { return null; }
  }
  private readState(session: string, expectedGeneration?: string) {
    try {
      const pointer = parseOpenCodeState(this.fs.readFile(opencodeSeatPaths(this.stateRoot, session).runnerStatePath));
      if (!pointer || (expectedGeneration !== undefined && pointer.generation !== expectedGeneration)) return null;
      const attemptPath = opencodeLaunchStatePath(this.stateRoot, session, pointer.launchId);
      if (!this.fs.exists(attemptPath)) return pointer;
      const state = parseOpenCodeState(this.fs.readFile(attemptPath));
      return state?.launchId === pointer.launchId ? state : null;
    } catch { return null; }
  }
  readSessionId(session: string, expectedGeneration?: string): { ok: true; sessionId: string } | { ok: false; reason: string } {
    const state = this.readState(session, expectedGeneration);
    return state?.sessionId && validOpenCodeSessionId(state.sessionId) ? { ok: true, sessionId: state.sessionId } : { ok: false, reason: "missing_sidecar" };
  }
  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound" };
    if (!binding.model || !/^[^/\s]+\/[^\s]+$/.test(binding.model)) return { ok: false, error: "OpenCode requires an explicit provider/model ID" };
    if (binding.launchPosture === "full_bypass" || (binding.permissionMode && binding.permissionMode !== "native")) return { ok: false, error: "OpenCode managed attachment supports native permissions only; full_bypass and auto are unsupported" };
    if (opts.resumeToken && opts.forkSource) return { ok: false, error: "resumeToken and forkSource are mutually exclusive" };
    if (opts.forkSource && opts.forkSource.kind !== "native_id") return { ok: false, error: "OpenCode fork requires native_id" };
    const token = opts.resumeToken ?? opts.forkSource?.value;
    if ((opts.forkSource && !token) || (token && !validOpenCodeSessionId(token))) return { ok: false, error: "Invalid OpenCode native session ID" };
    const paths = opencodeSeatPaths(this.stateRoot, binding.tmuxSession);
    this.fs.mkdirp(paths.seatRoot);
    const launchId = this.deps.newLaunchId?.() ?? randomUUID();
    this.fs.writeFile(paths.runnerStatePath, JSON.stringify({ launchId, generation: binding.launchGeneration, backendReady: false }));
    const args = ["node", this.deps.runnerEntryPath, "--state-root", this.stateRoot, "--session", binding.tmuxSession, "--launch-id", launchId, "--cwd", binding.cwd, "--model", binding.model, "--name", opts.name];
    if (this.deps.executable) args.push("--executable", this.deps.executable);
    if (binding.launchGeneration) args.push("--generation", binding.launchGeneration);
    if (token) args.push(opts.resumeToken ? "--resume" : "--fork", token);
    const sent = await this.tmux.sendText(binding.tmuxSession, args.map(shellQuote).join(" "));
    if (!sent.ok) return { ok: false, error: sent.message };
    const entered = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!entered.ok) return { ok: false, error: entered.message };
    for (let i = 0; i < 80; i++) {
      const state = this.readState(binding.tmuxSession, binding.launchGeneration);
      if (state?.launchId === launchId) {
        if (state.error || state.exited) return { ok: false, error: state.error || "OpenCode exited", recovery: "attention_required" };
        if (state.backendReady && state.sessionId && ((opts.resumeToken && state.sessionId !== opts.resumeToken) || (opts.forkSource && state.sessionId === token))) return { ok: false, error: "OpenCode returned the wrong native session identity" };
        if (state.backendReady && state.sessionId && validOpenCodeSessionId(state.sessionId)) return { ok: true, resumeToken: state.sessionId, resumeType: "opencode_id" };
      }
      await this.sleep(250);
    }
    return { ok: false, error: "OpenCode backend did not report session identity", recovery: "attention_required" };
  }
  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession || !await this.tmux.hasSession(binding.tmuxSession)) return { ready: false, reason: "tmux session unavailable" };
    const state = this.readState(binding.tmuxSession, binding.launchGeneration);
    if (!state?.backendReady || state.exited || state.error) return { ready: false, reason: state?.error || "OpenCode backend not ready" };
    const command = await this.tmux.getPaneCommand(binding.tmuxSession);
    if (!command || ["sh", "bash", "zsh", "fish", "tmux"].includes(command)) return { ready: false, reason: "OpenCode terminal is not running" };
    const pane = await this.tmux.capturePaneContent(binding.tmuxSession, 40) ?? "";
    if (/permission required|allow once|allow always/i.test(pane)) return { ready: false, reason: "OpenCode requires permission", code: "trust_gate" };
    if (/connect a provider|sign in|log in/i.test(pane)) return { ready: false, reason: "OpenCode requires provider authentication", code: "login_required" };
    return classifyOpenCodePrompt(pane) === "empty" ? { ready: true } : { ready: false, reason: "Waiting for native OpenCode prompt", code: "awaiting_runtime" };
  }
  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const sessionName = binding.tmuxSession;
    if (!sessionName) return results;
    const { seatRoot } = opencodeSeatPaths(this.stateRoot, sessionName);
    const skillsDir = nodePath.join(seatRoot, "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    if (plan.entries.filter(entry => entry.category === "runtime_resource" && entry.resourceType === "opencode_config").length > 1) {
      return { projected: [], skipped: [], failed: [{ effectiveId: "opencode_config", error: "Select only one OpenCode config resource per seat" }] };
    }
    const conflicts = plan.entries.filter(entry => entry.classification === "operator_conflict" || entry.classification === "hash_conflict");
    if (conflicts.length) return { projected, skipped, failed: conflicts.map(entry => ({ effectiveId: entry.effectiveId, error: "Projection would overwrite user-owned content" })) };
    if (!plan.preserveRuntimeSettings && !plan.entries.some(entry => entry.category === "runtime_resource" && entry.resourceType === "opencode_config")) {
      try {
        if (!binding.tmuxSession) throw new Error("No tmux session bound");
        this.writeOwned(binding, opencodeSeatPaths(this.stateRoot, binding.tmuxSession).configPath, "{}");
      } catch (error) { return { projected, skipped, failed: [{ effectiveId: "opencode_config", error: (error as Error).message }] }; }
    }
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      if (entry.classification === "operator_conflict" || entry.classification === "hash_conflict") {
        failed.push({ effectiveId: entry.effectiveId, error: "Projection would overwrite user-owned content" });
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            if (!binding.tmuxSession) throw new Error("No tmux session bound — cannot resolve the OpenCode seat state dir");
            const { seatRoot } = opencodeSeatPaths(this.stateRoot, binding.tmuxSession);
            const targetDir = nodePath.join(seatRoot, "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.writeOwned(binding, nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "runtime_resource" && entry.resourceType === "opencode_config") {
      if (!binding.tmuxSession) throw new Error("No tmux session bound");
      const paths = opencodeSeatPaths(this.stateRoot, binding.tmuxSession);
      const config = parseOpenCodeConfig(this.fs.readFile(entry.absolutePath));
      this.fs.mkdirp(paths.seatRoot);
      this.writeOwned(binding, paths.configPath, JSON.stringify(config));
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    if (entry.category === "skill") {
      if (!binding.tmuxSession) return false;
      const { seatRoot } = opencodeSeatPaths(this.stateRoot, binding.tmuxSession);
      if (!/^[a-zA-Z0-9_.-]+$/.test(entry.effectiveId) || entry.effectiveId === "." || entry.effectiveId === "..") throw new Error("Invalid OpenCode skill alias");
      const targetDir = nodePath.join(seatRoot, "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      let isDir = false;
      if (this.fs.listFiles) {
        try {
          isDir = this.fs.listFiles(entry.absolutePath).length > 0;
        } catch {
          // File-shaped sources make the production listFiles (recursive
          // fs.readdirSync walk) throw ENOTDIR — treat the entry as file-shaped.
          isDir = false;
        }
      }
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.writeOwned(binding, dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.writeOwned(binding,
          nodePath.join(targetDir, nodePath.basename(entry.absolutePath)),
          this.fs.readFile(entry.absolutePath),
        );
      }
      return true;
    }

    // Other native resource formats are not interchangeable with OpenCode.
    return false;
  }

  private writeOwned(binding: NodeBinding, target: string, content: string): void {
    if (!binding.tmuxSession) throw new Error("No tmux session bound");
    const paths = opencodeSeatPaths(this.stateRoot, binding.tmuxSession);
    const manifestPath = nodePath.join(paths.seatRoot, "projection-hashes.json");
    const hashes: Record<string, string> = this.fs.exists(manifestPath) ? JSON.parse(this.fs.readFile(manifestPath)) : {};
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    if (this.fs.exists(target)) {
      const existing = this.fs.readFile(target);
      if (existing !== content && hashes[target] !== hash(existing)) throw new Error(`Refusing to overwrite operator-modified OpenCode resource: ${target}`);
    }
    this.fs.mkdirp(nodePath.dirname(target));
    this.fs.writeFile(target, content);
    hashes[target] = hash(content);
    this.fs.writeFile(manifestPath, JSON.stringify(hashes));
    this.deps.recordProjection?.(target, content);
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors the Claude/Codex adapters: per-seat `rig-role` content collides
    // across pod-mates when merged into a shared cwd file; it is delivered via
    // send_text instead. See ADR-0006.
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    this.deps.recordProjection?.(targetPath, this.fs.readFile(targetPath));
    return true;
  }
}
