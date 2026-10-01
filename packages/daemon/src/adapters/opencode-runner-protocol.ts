import path from "node:path";

export interface OpenCodeRunnerState {
  launchId: string;
  generation?: string;
  sessionId?: string;
  backendReady: boolean;
  exited?: boolean;
  error?: string;
}
export function opencodeSeatPaths(root: string, session: string) {
  const seatRoot = path.join(root, encodeURIComponent(session));
  return { seatRoot, runnerStatePath: path.join(seatRoot, "runner-state.json"), configPath: path.join(seatRoot, "config.json"), skillsDir: path.join(seatRoot, "skills") };
}
export function opencodeLaunchStatePath(root: string, session: string, launchId: string): string {
  return path.join(opencodeSeatPaths(root, session).seatRoot, `launch-${encodeURIComponent(launchId)}.json`);
}
export function parseOpenCodeState(raw: string): OpenCodeRunnerState | null {
  try {
    const value = JSON.parse(raw);
    return typeof value.launchId === "string" && typeof value.backendReady === "boolean" ? value : null;
  } catch { return null; }
}
export function validOpenCodeSessionId(id: string): boolean { return /^ses_[a-zA-Z0-9]+$/.test(id); }
/** Deliberately bounded config surface; authentication stays in native stores/env. */
export function parseOpenCodeConfig(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("opencode_config must be a JSON object");
  const allowed = new Set(["$schema", "provider", "permission", "instructions", "small_model"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported opencode_config key: ${key}`);
  const inspect = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    for (const [key, val] of Object.entries(item)) {
      if (/api.?key|authorization|password|secret|token/i.test(key) && !(typeof val === "string" && /^\{env:[A-Z_][A-Z0-9_]*\}$/.test(val))) throw new Error("OpenCode credentials must use {env:NAME} references");
      inspect(val);
    }
  };
  inspect(value);
  return value;
}

/** Native /agent includes markdown/config overrides absent from config.model. */
export function assertOpenCodePrimaryModels(agents: unknown, requested: string, defaultAgent?: string): void {
  if (!Array.isArray(agents) || !agents.length) throw new Error("Unable to verify native OpenCode agents");
  if (defaultAgent && !agents.some(agent => agent?.name === defaultAgent)) throw new Error("Configured OpenCode default agent is unavailable");
  for (const agent of agents) {
    if (!agent || typeof agent.name !== "string" || !["primary", "subagent", "all"].includes(agent.mode)) throw new Error("Invalid native OpenCode agent metadata");
    const selectable = agent.name === defaultAgent || (agent.mode !== "subagent" && agent.hidden !== true);
    if (!selectable || !agent.model) continue;
    if (`${agent.model.providerID}/${agent.model.modelID}` !== requested) throw new Error(`Native OpenCode agent "${agent.name}" overrides the requested model; remove its model override or match member.model before launching this seat`);
  }
}

/** 1.18 native prompt frame. Sidebar text is outside the bottom border width. */
export function classifyOpenCodePrompt(screen: string): "empty" | "draft" | "unknown" {
  // Retain established permission/auth/busy refusals until native round-trip fixtures
  // prove a narrower replacement; menu detection below is additional evidence.
  if (/permission required|allow once|allow always|connect a provider|sign in|log in|enter (?:your )?api key|esc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel)/i.test(screen)) return "unknown";
  const lines = screen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  // Native overlays preserve the underlying composer. Their centered title and
  // right-aligned esc chrome identify an input owner other than that composer.
  // Require the blank separator and aligned body; transcript mentions alone do not match.
  for (let row = 0; row + 2 < lines.length; row++) {
    const heading = /^( +)(\S.*?) {4,}esc(?:\s.*)?$/.exec(lines[row]!);
    if (heading && !lines[row + 1]!.trim() && lines[row + 2]!.startsWith(heading[1]!) && lines[row + 2]!.trim()) return "unknown";
  }
  for (let index = lines.length - 1; index > 1; index--) {
    const border = /╹[▀━─]{8,}/.exec(lines[index]!);
    if (!border) continue;
    const left = border.index;
    const right = left + border[0].length;
    const model = lines[index - 1]!;
    if (model[left] !== "┃" || !/^\s*(?:Build|Plan)\s*·\s*\S/.test(model.slice(left + 1, right))) continue;
    let rows = 0;
    let draft = false;
    for (let row = index - 2; row >= 0; row--) {
      const line = lines[row]!;
      if (line[left] !== "┃") break;
      rows++;
      if (line.slice(left + 1, right).trim()) draft = true;
    }
    return rows > 0 ? draft ? "draft" : "empty" : "unknown";
  }
  return "unknown";
}

/** Session-scoped SSE mapping; parallel requests keep the seat blocked until all reply. */
export function createOpenCodeEventMapper(sessionId: string): (event: unknown) => string | undefined {
  const pending = new Set<string>();
  return (value: unknown) => {
    if (!value || typeof value !== "object") return undefined;
    const event = value as { type?: string; properties?: { sessionID?: string; info?: { sessionID?: string }; id?: string; requestID?: string; status?: { type?: string } } };
    const props = event.properties;
    if (!props || (props.sessionID !== sessionId && props.info?.sessionID !== sessionId)) return undefined;
    const category = event.type?.split(".")[0];
    if (event.type === "permission.asked" || event.type === "question.asked") {
      pending.add(`${category}:${props.id ?? "unknown"}`);
      return "PermissionRequest";
    }
    if (event.type === "permission.replied" || event.type === "question.replied" || event.type === "question.rejected") {
      pending.delete(`${category}:${props.requestID ?? props.id ?? "unknown"}`);
      return pending.size === 0 ? "UserPromptSubmit" : undefined;
    }
    if (event.type === "session.status" && pending.size === 0) {
      if (props.status?.type === "idle") return "Stop";
      if (props.status?.type === "busy" || props.status?.type === "retry") return "UserPromptSubmit";
    }
    return undefined;
  };
}
