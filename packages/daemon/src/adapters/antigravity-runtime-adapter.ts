import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import type { TmuxAdapter } from "./tmux.js";
import type { RuntimeAdapter, NodeBinding, InstalledResource, ProjectionResult, ResolvedStartupFile, StartupDeliveryResult, HarnessLaunchResult, ReadinessResult, ForkSource } from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = ["PreInvocation", "PostInvocation", "PostToolUse", "Stop"];
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
type Json = Record<string, unknown>;
function record(value: unknown): value is Json { return !!value && typeof value === "object" && !Array.isArray(value); }
function parseNativeJson(text: string): unknown {
  // Preserve quoted URLs when reading JSON with comments.
  let result = ""; let inString = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') { inString = true; result += char; }
    else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      result += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated JSON comment in Antigravity settings");
      result += " "; index = end + 1;
    } else result += char;
  }
  return JSON.parse(result);
}

export interface AntigravityAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(path: string): string[];
}
export interface AntigravityRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: AntigravityAdapterFsOps;
  stateRoot: string;
  /** Bundled antigravity-activity-relay.cjs, adjacent to activity-relay.cjs. */
  activityRelayPath: string;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  readVersion?: () => string | Promise<string>;
  readModels?: () => string | Promise<string>;
  recordProjection?: (targetPath: string, content: string) => void;
}

export function antigravitySeatPaths(root: string, sessionName: string) {
  const seatDir = path.join(root, createHash("sha256").update(sessionName).digest("hex"));
  return { seatDir, statePath: path.join(seatDir, "session.json") };
}

/** Empty input must occupy the native bordered frame; any draft fails closed. */
export function classifyAntigravityPrompt(content: string): ReadinessResult {
  const pane = content.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = pane.trimEnd().split("\n");
  let footer = -1;
  for (let i = 0; i < lines.length; i++) if (/^\? for shortcuts\s+/.test(lines[i]!)) footer = i;
  const border = /^\s*─{12,}\s*$/;
  const emptyComposer = footer >= 3 && !lines.slice(footer + 1).some(line => line.trim())
    && border.test(lines[footer - 3]!) && /^>\s*$/.test(lines[footer - 2]!) && border.test(lines[footer - 1]!);
  // Require a native dialog heading plus its choices/navigation, not isolated
  // transcript phrases. Positive dialogs veto any composer still visible behind them.
  const navigation = /^\s*↑\/↓ Navigate · enter (?:Select|Confirm|Toggle)\s*$/m.test(pane);
  const trust = /^\s*Do you trust the contents of this project\?\s*$/m.test(pane)
    && /^\s*>?\s*Yes, I trust this folder\s*$/m.test(pane)
    && /^\s*>?\s*No, exit\s*$/m.test(pane);
  if (trust) return { ready: false, code: "trust_gate", reason: "Accept Antigravity workspace trust in the native terminal" };
  const login = /^\s*Select login method:\s*$/m.test(pane)
    && /^\s*>?\s*1\. Google OAuth\s*$/m.test(pane);
  const onboarding = /^\s*(?:Choose your color scheme:|Terms of Service & Data Use)(?:\s|$)/m.test(pane);
  if (navigation && (login || onboarding)) return { ready: false, code: "login_required", reason: "Complete Antigravity authentication and onboarding in its native terminal" };
  if (emptyComposer) return { ready: true };
  // Resume failure is independently verified against this launch's native log
  // by checkReady. Conversation text cannot establish a native error here.
  return { ready: false, reason: "Antigravity input has a draft, native dialog, or no verified empty frame" };
}

export class AntigravityRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "antigravity";
  private readonly fs: AntigravityAdapterFsOps;
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly deps: AntigravityRuntimeAdapterDeps) {
    this.fs = deps.fsOps;
    this.env = deps.env ?? process.env;
  }

  readSessionId(sessionName: string, expectedGeneration?: string): { ok: true; sessionId: string } | { ok: false; reason: string } {
    try {
      const paths = antigravitySeatPaths(this.deps.stateRoot, sessionName);
      const manifest = JSON.parse(this.fs.readFile(paths.statePath));
      if (!UUID.test(manifest.launchId) || typeof manifest.generation !== "string" || !manifest.generation || (expectedGeneration && manifest.generation !== expectedGeneration)) return { ok: false, reason: "launch_mismatch" };
      const state = JSON.parse(this.fs.readFile(path.join(paths.seatDir, `session-${manifest.launchId}.json`)));
      if (state.launchId === manifest.launchId && state.generation === manifest.generation && state.confirmed === true && UUID.test(state.sessionId) && (!manifest.expectedSessionId || state.sessionId === manifest.expectedSessionId)) return { ok: true, sessionId: state.sessionId };
      // Verified 1.2.14 restores render the exact ID before the first hook fires.
      const expectedLog = path.join(paths.seatDir, `native-${manifest.launchId}.log`);
      if (UUID.test(manifest.expectedSessionId ?? "") && manifest.logPath === expectedLog && this.fs.exists(expectedLog)) {
        const log = this.fs.readFile(expectedLog);
        const resumed = [...log.matchAll(/common\.go:\d+\] Resuming conversation ([0-9a-f-]{36})(?:\r?\n|$)/g)].at(-1)?.[1];
        const rendered = [...log.matchAll(/manager\.go:\d+\] Full redraw completed \(rerenderAll\) for conversation ([0-9a-f-]{36}) \(epoch /g)].at(-1)?.[1];
        if (resumed === manifest.expectedSessionId && rendered === resumed && !/not found, ignoring --conversation flag/.test(log)) return { ok: true, sessionId: resumed! };
      }
      return { ok: false, reason: "identity_unconfirmed" };
    } catch { return { ok: false, reason: "missing_sidecar" }; }
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const dir = path.join(binding.cwd, ".agents", "skills");
    return this.fs.exists(dir) && this.fs.listFiles ? this.fs.listFiles(dir).map((file) => ({ effectiveId: file, category: "skill", installedPath: path.join(dir, file) })) : [];
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const result: ProjectionResult = { projected: [], skipped: [], failed: [] };
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") { result.skipped.push(entry.effectiveId); continue; }
      try {
        if (entry.classification === "hash_conflict" || entry.classification === "operator_conflict") throw new Error("User-owned resource conflicts with projection");
        if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
          if (entry.effectiveId === "rig-role") { result.skipped.push(entry.effectiveId); continue; }
          mergeManagedBlock(this.fs, path.join(binding.cwd, "AGENTS.md"), entry.effectiveId, this.fs.readFile(entry.absolutePath));
          this.recordProjection(path.join(binding.cwd, "AGENTS.md"));
        } else if (entry.category === "skill") {
          this.installSkill(entry.absolutePath, entry.effectiveId, binding);
        } else if (entry.category === "runtime_resource" && entry.resourceType === "antigravity_settings") {
          throw new Error("Antigravity has no verified per-seat settings override; configure native settings and use member.model / permission mode");
        } else { result.skipped.push(entry.effectiveId); continue; }
        result.projected.push(entry.effectiveId);
      } catch (error) { result.failed.push({ effectiveId: entry.effectiveId, error: (error as Error).message }); }
    }
    return result;
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const result: StartupDeliveryResult = { delivered: 0, failed: [] };
    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        if (hint === "guidance_merge") {
          if (file.path === "rig-role") continue;
          mergeManagedBlock(this.fs, path.join(binding.cwd, "AGENTS.md"), file.path, content);
          this.recordProjection(path.join(binding.cwd, "AGENTS.md"));
        } else if (hint === "skill_install") {
          this.installSkill(file.absolutePath, path.basename(path.dirname(file.absolutePath)), binding);
        } else {
          if (!binding.tmuxSession) throw new Error("No tmux session bound");
          const sent = await this.deps.tmux.sendText(binding.tmuxSession, content);
          if (!sent.ok) throw new Error(sent.message);
          await this.sleep(200);
          const submitted = await this.deps.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
          if (!submitted.ok) throw new Error(submitted.message);
        }
        result.delivered++;
      } catch (error) { if (file.required) result.failed.push({ path: file.path, error: (error as Error).message }); }
    }
    return result;
  }

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound" };
    if (opts.forkSource) return { ok: false, error: "Antigravity CLI native fork is not supported; use an explicit fresh start or exact-session resume" };
    if (opts.resumeToken !== undefined && !UUID.test(opts.resumeToken)) return { ok: false, error: "Antigravity resume requires an exact session UUID; latest and indexes are not supported" };
    if (!binding.model?.trim() || /[\x00-\x1f]/.test(binding.model)) return { ok: false, error: "Antigravity CLI requires an explicit member.model" };
    const mode = binding.permissionMode ?? (binding.launchPosture === "full_bypass" ? "full_bypass" : "native");
    if (!["native", "floor", "full_bypass", "accept-edits", "plan"].includes(mode)) return { ok: false, error: `Unsupported Antigravity permission mode: ${mode}` };
    try {
      const version = (await (this.deps.readVersion ?? (async () => (await execFileAsync("agy", ["--version"], { encoding: "utf8", timeout: 5000 })).stdout))()).trim();
      if (!/^1\.2\.\d+$/.test(version)) throw new Error("Managed Antigravity integration requires the tested 1.2.x release family");
      const models = await (this.deps.readModels ?? (async () => (await execFileAsync("agy", ["models"], { encoding: "utf8", timeout: 10000 })).stdout))();
      const selected = models.split("\n").map(line => line.split("\t")).find(([slug]) => slug === binding.model);
      if (!selected?.[1]) throw new Error("Antigravity model must be an exact slug listed by agy models");
      if (!this.fs.exists(this.deps.activityRelayPath)) throw new Error("Antigravity activity relay asset is missing");
      this.prepareHooks(binding);
      const paths = this.paths(binding);
      this.fs.mkdirp(paths.seatDir);
      const launchId = randomUUID();
      const generation = binding.launchGeneration ?? this.env.OPENRIG_OCCUPANT_GENERATION;
      if (!generation) throw new Error("Antigravity launch requires an occupant generation");
      const launchStatePath = path.join(paths.seatDir, `session-${launchId}.json`);
      const logPath = path.join(paths.seatDir, `native-${launchId}.log`);
      const pending = { launchId, generation, expectedSessionId: opts.resumeToken ?? null, modelSlug: binding.model, modelLabel: selected[1], logPath, confirmed: false };
      this.fs.writeFile(launchStatePath, JSON.stringify(pending));
      this.fs.writeFile(paths.statePath, JSON.stringify(pending));
      const env = {
        OPENRIG_ANTIGRAVITY_STATE_PATH: launchStatePath,
        OPENRIG_ANTIGRAVITY_MANIFEST_PATH: paths.statePath,
        OPENRIG_ANTIGRAVITY_LAUNCH_ID: launchId,
        OPENRIG_SESSION_NAME: binding.tmuxSession,
        OPENRIG_NODE_ID: binding.nodeId,
        OPENRIG_RUNTIME: this.runtime,
        OPENRIG_OCCUPANT_GENERATION: generation,
      };
      const permission = mode === "full_bypass" ? " --dangerously-skip-permissions" : ["accept-edits", "plan"].includes(mode) ? ` --mode ${quote(mode)}` : "";
      const command = `cd ${quote(binding.cwd)} && env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} agy --model ${quote(binding.model)} --log-file ${quote(logPath)}${permission}${opts.resumeToken ? ` --conversation ${quote(opts.resumeToken)}` : ""}`;
      const sent = await this.deps.tmux.sendText(binding.tmuxSession, command);
      if (!sent.ok) return { ok: false, error: sent.message };
      const submitted = await this.deps.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
      if (!submitted.ok) return { ok: false, error: submitted.message };
      // A native input frame and effective model prove fresh readiness; resume also requires identity.
      for (let attempt = 0; attempt < 60; attempt++) {
        const ready = await this.checkReady(binding);
        if (ready.ready) {
          const identity = this.readSessionId(binding.tmuxSession, generation);
          if (identity.ok && (!opts.resumeToken || identity.sessionId === opts.resumeToken)) return { ok: true, resumeToken: identity.sessionId, resumeType: "antigravity_id" };
          if (!opts.resumeToken) return { ok: true };
        }
        if (["trust_gate", "login_required", "hook_trust_gate"].includes(ready.code ?? "")) return { ok: false, error: ready.reason ?? "Antigravity requires attention", recovery: "attention_required" };
        if (ready.code === "native_error") return { ok: false, error: ready.reason ?? "Antigravity launch failed", recovery: "attention_required" };
        await this.sleep(250);
      }
      return { ok: false, error: "Antigravity did not confirm this session and expose its input prompt; inspect the native terminal", recovery: "attention_required" };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const session = binding.tmuxSession;
    if (!session || !await this.deps.tmux.hasSession(session)) return { ready: false, reason: "tmux session not responsive" };
    const pane = await this.deps.tmux.capturePaneContent(session, 35) ?? "";
    const prompt = classifyAntigravityPrompt(pane);
    if (!prompt.ready) return prompt;
    const command = await this.deps.tmux.getPaneCommand(session);
    if (!command || ["sh", "bash", "zsh", "fish", "tmux"].includes(command)) return { ready: false, reason: "Antigravity process is not running" };
    try {
      const manifest = JSON.parse(this.fs.readFile(this.paths(binding).statePath));
      if (manifest.generation !== binding.launchGeneration) return { ready: false, reason: "Antigravity launch generation changed" };
      const state = JSON.parse(this.fs.readFile(path.join(this.paths(binding).seatDir, `session-${manifest.launchId}.json`)));
      if (state.modelMismatch) return { ready: false, code: "native_error", reason: "Antigravity changed the selected model" };
      const log = this.fs.readFile(manifest.logPath);
      if (/not found, ignoring --conversation flag/.test(log)) return { ready: false, code: "native_error", reason: "Antigravity resumed a fresh conversation instead of the requested ID" };
      const labels = [...log.matchAll(/Propagating selected model override to backend: label="([^"]+)"/g)];
      if (labels.at(-1)?.[1] !== manifest.modelLabel) return { ready: false, reason: "Antigravity effective model is not confirmed" };
      if (manifest.expectedSessionId && !this.readSessionId(session, binding.launchGeneration).ok) return { ready: false, reason: "Antigravity resume identity is not confirmed by native evidence" };
    } catch { return { ready: false, reason: "Antigravity launch evidence is unavailable" }; }
    return { ready: true };
  }

  private paths(binding: NodeBinding) {
    if (!binding.tmuxSession) throw new Error("No tmux session bound");
    return antigravitySeatPaths(this.deps.stateRoot, binding.tmuxSession);
  }
  private sleep(ms: number) { return (this.deps.sleep ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay))))(ms); }
  private readSettings(file: string): Json {
    if (!this.fs.exists(file)) return {};
    const value: unknown = parseNativeJson(this.fs.readFile(file));
    if (!record(value)) throw new Error(`Antigravity settings must contain a JSON object: ${file}`);
    return value;
  }
  currentLaunchId(sessionName: string): string | null {
    try { const value = JSON.parse(this.fs.readFile(antigravitySeatPaths(this.deps.stateRoot, sessionName).statePath)).launchId; return typeof value === "string" && UUID.test(value) ? value : null; } catch { return null; }
  }
  readLaunchIdentity(sessionName: string, expectedGeneration?: string): { logPath: string; generation: string; sessionId?: string } | null {
    try {
      const manifest = JSON.parse(this.fs.readFile(antigravitySeatPaths(this.deps.stateRoot, sessionName).statePath));
      if (!UUID.test(manifest.launchId) || !manifest.generation || (expectedGeneration && manifest.generation !== expectedGeneration)) return null;
      const expectedLog = path.join(antigravitySeatPaths(this.deps.stateRoot, sessionName).seatDir, `native-${manifest.launchId}.log`);
      if (manifest.logPath !== expectedLog) return null;
      const identity = this.readSessionId(sessionName, expectedGeneration);
      return { logPath: expectedLog, generation: manifest.generation, ...(identity.ok ? { sessionId: identity.sessionId } : {}) };
    } catch { return null; }
  }
  private prepareHooks(binding: NodeBinding): void {
    const hooksPath = path.join(binding.cwd, ".agents", "hooks.json");
    const existing = this.readSettings(hooksPath);
    const name = "openrig-antigravity-activity";
    const hooks = Object.fromEntries(EVENTS.map(event => [event, event === "PostToolUse"
      ? [{ matcher: "*", hooks: [{ type: "command", command: `node ${quote(this.deps.activityRelayPath)} ${event}`, timeout: 2 }] }]
      : [{ type: "command", command: `node ${quote(this.deps.activityRelayPath)} ${event}`, timeout: 2 }]]));
    if (existing[name] && JSON.stringify(existing[name]) !== JSON.stringify(hooks)) throw new Error("OpenRig Antigravity hook block conflicts with existing workspace hooks");
    this.fs.mkdirp(path.dirname(hooksPath));
    this.fs.writeFile(hooksPath, JSON.stringify({ ...existing, [name]: hooks }, null, 2) + "\n");
    this.recordProjection(hooksPath);
  }
  private installSkill(source: string, alias: string, binding: NodeBinding) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(alias) || alias === "." || alias === "..") throw new Error("Unsafe Antigravity skill alias");
    const target = path.join(binding.cwd, ".agents", "skills", alias);
    let files: string[] = [];
    try { files = this.fs.listFiles?.(source) ?? []; } catch { /* File-shaped skill. */ }
    const copies = files.length ? files.map((file) => ({ source: path.join(source, file), target: path.resolve(target, file) })) : [{ source, target: path.join(target, path.basename(source)) }];
    const paths = this.paths(binding);
    const manifestPath = path.join(paths.seatDir, "projection-hashes.json");
    const hashes: Record<string, string> = this.fs.exists(manifestPath) ? JSON.parse(this.fs.readFile(manifestPath)) : {};
    const hash = (content: string) => createHash("sha256").update(content).digest("hex");
    for (const copy of copies) {
      if (!copy.target.startsWith(target + path.sep)) throw new Error("Skill path escapes its target directory");
      const content = this.fs.readFile(copy.source);
      if (this.fs.exists(copy.target)) {
        const existing = this.fs.readFile(copy.target);
        if (existing !== content && hashes[copy.target] !== hash(existing)) throw new Error("Antigravity skill conflicts with an existing file; resolve the shared-workspace skill collision first");
      }
    }
    for (const copy of copies) {
      const content = this.fs.readFile(copy.source);
      this.fs.mkdirp(path.dirname(copy.target)); this.fs.writeFile(copy.target, content);
      hashes[copy.target] = hash(content); this.recordProjection(copy.target);
    }
    this.fs.mkdirp(paths.seatDir);
    this.fs.writeFile(manifestPath, JSON.stringify(hashes));
  }
  private recordProjection(target: string) { this.deps.recordProjection?.(target, this.fs.readFile(target)); }
}
