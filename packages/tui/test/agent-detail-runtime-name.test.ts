// a4c9548a — S19 FOLLOW-ON FOUNDER RULING (binding, bounds the S19 marks ruling):
// icons are DECORATIVE or for no-room contexts; where there is ROOM, WRITE THE NAME —
// an icon NEVER replaces text as the value. The agent-DETAIL page has room, so its
// runtime field must render the runtime NAME as text (claude-code / codex / ...); a
// mark MAY accompany decoratively but never substitutes for the value. Topology cards
// (space-constrained) KEEP their marks — the ruling is BOUNDED, not reversed (see
// topology-view / navigator-reskin suites, untouched by this fix). (qitem a4c9548a)
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";

function renderAgentDetail(name: string, runtime?: string, cols = 140): string {
  const snap = demoSnapshot();
  if (runtime) {
    for (const host of snap.hosts) for (const rig of host.rigs) for (const pod of rig.pods) for (const agent of pod.agents) if (agent.name === name) { agent.runtime = runtime; agent.model = "openrouter/vendor/a-long-concrete-model-name"; agent.context = null; }
  }
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch({
    type: "drill",
    resource: "agent",
    name,
    target: { host: "vm-host", rig: "openrig-build", pod: "dev50" },
  });
  return renderScreen(view.get(), snap, { cols, rows: 48 }).lines.join("\n");
}

describe("agent-detail runtime field renders the NAME as the value (founder rule a4c9548a)", () => {
  it("a claude-code agent's runtime field shows `claude-code` as TEXT — the name is the value, not only the mark", () => {
    const out = renderAgentDetail("dev50.driver");
    expect(out).toMatch(/runtime:\s+claude-code/);
  });

  it("a codex agent's runtime field shows `codex` as TEXT", () => {
    const out = renderAgentDetail("dev50.guard");
    expect(out).toMatch(/runtime:\s+codex/);
  });
});

it.each(["opencode", "antigravity"])("shows %s configured model separately from unobserved effective model", runtime => {
  const out = renderAgentDetail("dev50.driver", runtime);
  expect(out).toContain(runtime);
  expect(out).toContain("openrouter/vendor/a-long-concrete-model-name");
  expect(out).toContain("observed model");
  expect(out).toContain("unknown (not served)");
  expect(out).toContain("CONTEXT · unknown");
  expect(renderAgentDetail("dev50.driver", runtime, 80)).toContain("configured model");
});
