import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { classifyPaneActivity } from "../src/domain/session-transport.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";

const empty = "  ┃\n  ┃\n  ┃  Build · Explicit Model\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n  tab agents ctrl+p commands";
describe("OpenCode native transport guard", () => {
  it("admits a live empty native prompt", () => {
    expect(classifyPaneActivity(empty, "opencode").state).toBe("agent_idle");
    expect(assessNativeResumeProbe({ runtime: "opencode", paneCommand: "opencode", paneContent: empty }).status).toBe("resumed");
  });
  it.each([
    ["draft", empty.replace("  ┃\n", "  ┃ Do not submit this draft\n")],
    ["authentication", "Sign in\n" + empty],
    ["permission", "Permission required\nAllow once\n" + empty],
    ["busy", empty + "\nesc to interrupt"],
    ["footer only", "tab agents ctrl+p commands"],
  ])("refuses %s even with native footer", (_label, screen) => {
    expect(classifyPaneActivity(screen, "opencode").state).not.toBe("agent_idle");
    expect(assessNativeResumeProbe({ runtime: "opencode", paneCommand: "opencode", paneContent: screen }).status).not.toBe("resumed");
  });
  it.each(["commands", "models", "sessions"])("blocks delivery/readiness beneath the native %s overlay", (kind) => {
    const paneContent = readFileSync(new URL(`./fixtures/opencode/${kind}.txt`, import.meta.url), "utf8");
    expect(classifyPaneActivity(paneContent, "opencode").state).not.toBe("agent_idle");
    expect(assessNativeResumeProbe({ runtime: "opencode", paneCommand: "opencode", paneContent }).status).not.toBe("resumed");
  });
  it("does not treat stale shell scrollback as a resumed runtime", () => {
    expect(assessNativeResumeProbe({ runtime: "opencode", paneCommand: "zsh", paneContent: empty }).status).toBe("inconclusive");
  });
});
