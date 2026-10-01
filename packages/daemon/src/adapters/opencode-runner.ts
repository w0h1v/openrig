/** Managed loopback backend + native attach. No prompts or credentials enter the sidecar. */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assertOpenCodePrimaryModels, createOpenCodeEventMapper, opencodeLaunchStatePath, opencodeSeatPaths, validOpenCodeSessionId, type OpenCodeRunnerState } from "./opencode-runner-protocol.js";

export async function runOpenCode(args: Record<string, string>): Promise<void> {
  const required = (key: string): string => { const value = args[key]; if (!value) throw new Error(`Missing OpenCode runner argument: ${key}`); return value; };
  const cwd = required("cwd"), sessionName = required("session"), launchId = required("launch-id"), stateRoot = required("state-root");
  const executable = args.executable || "opencode";
  const paths = opencodeSeatPaths(stateRoot, sessionName);
  const attemptPath = opencodeLaunchStatePath(stateRoot, sessionName, launchId);
  const state: OpenCodeRunnerState = { launchId, backendReady: false };
  const save = () => { fs.writeFileSync(attemptPath + ".tmp", JSON.stringify(state), { mode: 0o600 }); fs.renameSync(attemptPath + ".tmp", attemptPath); };
  save();
  try {
    const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    if (!/^1\.18\./.test(version)) throw new Error(`OpenCode ${version} is unsupported; tested release family is 1.18.x`);
  } catch (error) {
    state.error = (error as Error).message; state.exited = true; save(); throw error;
  }
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate loopback port");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const password = randomBytes(32).toString("hex");
  const config = fs.existsSync(paths.configPath) ? JSON.parse(fs.readFileSync(paths.configPath, "utf8")) : {};
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, model: args.model, enabled_providers: [required("model").split("/")[0]], skills: { paths: [paths.skillsDir] } }) };
  const backend = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let terminal: ChildProcess | undefined;
  let closing = false;
  const cleanup = () => {
    if (closing) return;
    closing = true;
    const children = [terminal, backend].filter((child): child is ChildProcess => !!child);
    for (const child of children) child.kill("SIGTERM");
    const escalation = setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    escalation.unref();
    state.exited = true; state.backendReady = false; save();
  };
  process.once("SIGTERM", cleanup); process.once("SIGINT", cleanup); process.once("SIGHUP", cleanup);
  backend.once("exit", () => { if (!closing) { state.error = "OpenCode backend exited"; cleanup(); } });
  backend.on("error", () => { state.error = "OpenCode backend could not start"; cleanup(); });
  // Drain native diagnostics without leaking potentially sensitive config to OpenRig state.
  backend.stdout?.resume(); backend.stderr?.resume();
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json" };
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(base + url, { headers, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`OpenCode API ${url.split("?")[0]} returned ${response.status}`);
    return await response.json() as { id: string; healthy?: boolean; model?: string; default_agent?: string; all?: Array<{ id: string; models: Record<string, unknown> }>; connected?: string[] };
  };
  const relay = async (extra: Record<string, unknown>) => {
    try {
      if (JSON.parse(fs.readFileSync(paths.runnerStatePath, "utf8")).launchId !== launchId) return;
    } catch { return; }
    if (!process.env.OPENRIG_URL || !process.env.OPENRIG_ACTIVITY_HOOK_TOKEN) return;
    try { await fetch(process.env.OPENRIG_URL.replace(/\/$/, "") + "/api/activity/hooks", { method: "POST", headers: { "Content-Type": "application/json", "x-openrig-activity-token": process.env.OPENRIG_ACTIVITY_HOOK_TOKEN }, body: JSON.stringify({ runtime: "opencode", sessionName, launchId, nodeId: process.env.OPENRIG_NODE_ID, generation: args.generation || process.env.OPENRIG_OCCUPANT_GENERATION, sessionId: state.sessionId, ...extra }), signal: AbortSignal.timeout(1500) }); } catch { /* Native loop must survive daemon loss. */ }
  };
  try {
    let healthy = false;
    for (let i = 0; i < 60 && !closing; i++) {
      try { const health = await request("/global/health"); healthy = health.healthy === true; if (healthy) break; } catch { /* booting */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!healthy) throw new Error("OpenCode backend health timed out");
    const catalog = await request("/provider");
    const slash = required("model").indexOf("/");
    const providerID = required("model").slice(0, slash), modelID = required("model").slice(slash + 1);
    const provider = catalog.all?.find(item => item.id === providerID);
    if (!provider?.models[modelID]) throw new Error("Configured OpenCode model is absent from the native provider catalog; refusing fallback");
    if (!catalog.connected?.includes(providerID)) throw new Error("Configured OpenCode provider is not connected; authenticate with the native CLI first");
    const query = `?directory=${encodeURIComponent(cwd)}`;
    const effectiveConfig = await request("/config" + query);
    if (effectiveConfig.model !== args.model) throw new Error("OpenCode native config did not preserve the requested model");
    assertOpenCodePrimaryModels(await request("/agent" + query), required("model"), effectiveConfig.default_agent);
    const session = args.resume ? await request(`/session/${args.resume}${query}`) : args.fork ? await request(`/session/${args.fork}/fork${query}`, {}) : await request(`/session${query}`, { title: args.name });
    if (!validOpenCodeSessionId(session.id) || (args.resume && session.id !== args.resume) || (args.fork && session.id === args.fork)) throw new Error("OpenCode returned an unexpected session identity");
    if (args.resume || args.fork) {
      const response = await fetch(base + `/session/${session.id}/message${query}`, { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Unable to verify resumed OpenCode model history");
      const messages = await response.json() as Array<{ info?: { role?: string; model?: { providerID?: string; modelID?: string } } }>;
      const last = [...messages].reverse().find(message => message.info?.role === "user" && message.info.model)?.info?.model;
      if (last && `${last.providerID}/${last.modelID}` !== args.model) throw new Error("Resumed OpenCode conversation uses a different model; native attach cannot override it safely");
    }
    state.sessionId = session.id; state.backendReady = true; save();
    await relay({ eventFamily: "session_identity" });
    const abort = new AbortController();
    const mapEvent = createOpenCodeEventMapper(session.id);
    void (async () => {
      try {
        const response = await fetch(base + "/event" + query, { headers, signal: abort.signal });
        if (!response.ok || !response.body) return;
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += new TextDecoder().decode(chunk);
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const line = frame.split("\n").find(value => value.startsWith("data:"));
            if (!line) continue;
            const hook = mapEvent(JSON.parse(line.slice(5)));
            if (hook) await relay({ hookEvent: hook });
          }
        }
      } catch { /* Observation loss never blocks the terminal. */ }
      finally { await relay({ hookEvent: "Notification", subtype: "observation_disconnected" }); }
    })();
    terminal = spawn(executable, ["attach", base, "--dir", cwd, "--session", session.id], { cwd: cwd, env, stdio: "inherit" });
    await new Promise<void>((resolve, reject) => { terminal!.once("exit", () => resolve()); terminal!.once("error", reject); });
    abort.abort();
  } catch (error) { state.error = (error as Error).message; throw error; }
  finally { cleanup(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]!.replace(/^--/, "")] = process.argv[i + 1]!;
  runOpenCode(args).catch(error => { console.error(`[openrig-opencode] ${error.message}`); process.exitCode = 1; });
}
