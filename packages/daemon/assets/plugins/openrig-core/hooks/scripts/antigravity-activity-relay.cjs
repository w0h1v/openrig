#!/usr/bin/env node
"use strict";

// Observational Antigravity hooks return neutral JSON. Never forward prompts,
// tool arguments, notification text, or model output to the daemon.
const fs = require("node:fs");
const { postHookPayload } = require("./activity-relay.cjs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


function buildPayload(input, env = process.env, event = process.argv[2]) {
  if (!input || typeof input !== "object" || !["PreInvocation", "PostInvocation", "PostToolUse", "Stop"].includes(event)) return null;
  if (!UUID.test(input.conversationId || "")) return null;
  if (!env.OPENRIG_SESSION_NAME || !env.OPENRIG_NODE_ID || !env.OPENRIG_ANTIGRAVITY_LAUNCH_ID || !env.OPENRIG_OCCUPANT_GENERATION) return null;
  return {
    runtime: "antigravity", launchId: env.OPENRIG_ANTIGRAVITY_LAUNCH_ID, nodeId: env.OPENRIG_NODE_ID, sessionName: env.OPENRIG_SESSION_NAME,
    generation: env.OPENRIG_OCCUPANT_GENERATION, sessionId: input.conversationId,
    hookEvent: event === "Stop" && input.fullyIdle === true ? "Stop" : "active",
    modelName: typeof input.modelName === "string" ? input.modelName.slice(0, 200) : null,
    occurredAt: new Date().toISOString(),
  };
}
function updateSidecar(payload, env = process.env) {
  if (!env.OPENRIG_ANTIGRAVITY_STATE_PATH || !env.OPENRIG_ANTIGRAVITY_MANIFEST_PATH) return false;
  const current = JSON.parse(fs.readFileSync(env.OPENRIG_ANTIGRAVITY_MANIFEST_PATH, "utf8"));
  if (current.launchId !== env.OPENRIG_ANTIGRAVITY_LAUNCH_ID || current.generation !== payload.generation || (current.expectedSessionId && current.expectedSessionId !== payload.sessionId)) return false;
  const state = JSON.parse(fs.readFileSync(env.OPENRIG_ANTIGRAVITY_STATE_PATH, "utf8"));
  if (state.launchId !== current.launchId || state.generation !== current.generation || (state.sessionId && state.sessionId !== payload.sessionId)) return false;
  const updated = { ...state, modelMismatch: !!payload.modelName && payload.modelName !== current.modelSlug, confirmed: true, sessionId: payload.sessionId, updatedAt: payload.occurredAt };
  const temp = `${env.OPENRIG_ANTIGRAVITY_STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(updated), { mode: 0o600 });
  fs.renameSync(temp, env.OPENRIG_ANTIGRAVITY_STATE_PATH);
  const latest = JSON.parse(fs.readFileSync(env.OPENRIG_ANTIGRAVITY_MANIFEST_PATH, "utf8"));
  return latest.launchId === current.launchId && latest.generation === current.generation;
}

async function readInput() {
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); process.stdin.pause(); resolve(value); } };
    const timer = setTimeout(() => finish(""), 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (done) return;
      if (text.length + chunk.length > 1024 * 1024) { finish(""); return; }
      text += chunk;
    });
    process.stdin.on("end", () => finish(text));
    process.stdin.on("error", () => finish(""));
  });
}

async function main() {
  // An outer deadline also bounds two sequential best-effort HTTP relays.
  const deadline = setTimeout(() => { process.stdout.write("{}\n", () => process.exit(0)); }, 2000);
  try {
    const payload = buildPayload(JSON.parse(await readInput()));
    if (payload && updateSidecar(payload)) {
      await postHookPayload({ ...payload, eventFamily: "session_identity" });
      await postHookPayload(payload);
    }
  } catch { /* Hooks are observational and never block native execution. */ }
  clearTimeout(deadline);
  process.stdout.write("{}\n");
}

if (require.main === module) main().catch(() => { process.stdout.write("{}\n"); });
module.exports = { buildPayload, updateSidecar };
