import { describe, expect, it, vi } from "vitest";
import { findExactNativeResumeProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const token = "00000000-0000-7000-8000-000000000001";
const startedAt = "Sat Jan  1 12:00:00 2000";
function rows(): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "bash", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "node", command: `node /opt/bin/codex resume ${token}`, startedAt },
    { pid: 13, ppid: 12, pgid: 11, tpgid: 11, executableName: "codex", command: `/opt/native/codex -p resume resume --add-dir /tmp/state ${token}`, startedAt },
  ];
}
const check = (listProcesses: () => NativeProcessRow[] | Promise<NativeProcessRow[]>, overrides = {}) => verifyCodexPaneProcess({
  target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses, expectedToken: token, requireResume: true, ...overrides,
});

describe("joined native Codex identity", () => {
  it("selects the unique native process, not its Node wrapper", async () => {
    expect((await check(rows))?.process.pid).toBe(13);
    expect(findExactNativeResumeProcess(rows(), 10, "codex", token)?.pid).toBe(13);
  });
  it("proves direct-native resume", async () => {
    expect((await check(() => [{ ...rows()[3]!, pid: 10, ppid: 1 }]))?.process.pid).toBe(10);
  });
  it("distinguishes fresh/non-strict runtime proof from exact resume", async () => {
    const fresh = () => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex -m model" } : r);
    expect(await check(fresh)).toBeNull();
    expect(await check(fresh, { requireResume: false })).not.toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: "different" })).toBeNull();
    expect(await check(rows, { requireResume: true, expectedToken: null })).toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: null })).toBeNull();
    expect(await check(() => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex resume --last" } : r), { requireResume: false, expectedToken: null })).toBeNull();
  });
  const controls: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ["wrong UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume other" } : x)],
    ["missing UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume" } : x)],
    ["token only in prompt", r => r.map(x => x.pid === 13 ? { ...x, command: `/opt/native/codex resume other ${token}` } : x)],
    ["wrong OS executable", r => r.map(x => x.pid === 13 ? { ...x, executableName: "printf" } : x)],
    ["argv-only executable", r => r.map(x => x.pid === 13 ? { ...x, command: `/bin/echo codex resume ${token}` } : x)],
    ["unrelated descendant", r => r.map(x => x.pid === 13 ? { ...x, ppid: 999 } : x)],
    ["background native", r => r.map(x => x.pid === 13 ? { ...x, pgid: 99 } : x)],
    ["conflicting foreground", r => r.map(x => x.pid === 13 ? { ...x, tpgid: 99 } : x)],
    ["missing root", r => r.slice(1)],
    ["missing ancestry", r => r.filter(x => x.pid !== 11)],
    ["cyclic ancestry", r => r.map(x => x.pid === 11 ? { ...x, ppid: 13 } : x)],
    ["multiple native candidates", r => [...r, { ...r[3]!, pid: 14 }]],
    ["duplicate PID", r => [...r, r[3]!]],
    ["missing start time", r => r.map(x => ({ ...x, startedAt: undefined }))],
    ["missing group", r => r.map(x => ({ ...x, tpgid: undefined }))],
    ["exited native", r => r.filter(x => x.pid !== 13)],
  ];
  it.each(controls)("refuses %s", async (_name, mutate) => {
    expect(await check(() => mutate(rows()))).toBeNull();
  });
  it.each(["startedAt", "command", "ppid", "pgid"] as const)("refuses a changed native %s between observations", async (field) => {
    const changed = rows().map(r => r.pid === 13 ? { ...r, [field]: field === "startedAt" ? "Sat Jan  1 12:00:01 2000" : field === "command" ? r.command + " --verbose" : 99 } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a reused pane PID even when the native PID is unchanged", async () => {
    const changed = rows().map(r => r.pid === 10 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a changed or missing pane and process observation failures", async () => {
    expect(await check(rows, { tmux: { getPanePid: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(11) } })).toBeNull();
    expect(await check(rows, { tmux: { getPanePid: async () => null } })).toBeNull();
    expect(await check(async () => { throw new Error("ps failed"); })).toBeNull();
  });
  it("retains the existing Claude exact-token contract", () => {
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: `claude --resume ${token}` }], 10, "claude-code", token)?.pid).toBe(10);
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: "claude --resume wrong" }], 10, "claude-code", token)).toBeNull();
  });
});

describe("OpenCode and Antigravity exact native identity", () => {
  const commands = [
    ["opencode", "opencode", `opencode attach http://127.0.0.1:4096 --dir /repo --session ${token}`],
    ["antigravity", "agy", `agy --model agy-test --mode accept-edits --conversation ${token}`],
  ] as const;
  it.each(commands)("binds %s identity to the unique foreground native process", async (runtime, executableName, command) => {
    const processes: NativeProcessRow[] = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "zsh", startedAt },
      { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName, command, startedAt }];
    expect(findExactNativeResumeProcess(processes, 10, runtime, token)?.pid).toBe(runtime === "antigravity" ? undefined : 11);
    expect(findExactNativeResumeProcess(processes, 10, runtime, "wrong")).toBeNull();
    expect(findExactNativeResumeProcess(processes.map(row => row.pid === 11 ? { ...row, ppid: 99 } : row), 10, runtime, token)).toBeNull();
    expect(findExactNativeResumeProcess(processes.map(row => row.pid === 11 ? { ...row, pgid: 99 } : row), 10, runtime, token)).toBeNull();
    expect(findExactNativeResumeProcess([...processes, { ...processes[1]!, pid: 12 }], 10, runtime, token)).toBeNull();
    const { verifyAdditionalNativePaneProcess } = await import("../src/domain/native-process-lineage.js");
    expect(await verifyAdditionalNativePaneProcess({ target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: () => processes, expectedToken: token, ...(runtime === "antigravity" ? { launchIdentity: { logPath: "/tmp/native.log", generation: "current", sessionId: token }, expectedGeneration: "current", listProcesses: () => processes.map(row => row.pid === 11 ? { ...row, command: row.command + " --log-file /tmp/native.log" } : row) } : {}) }, runtime)).not.toBeNull();
  });
  it("distinguishes the managed OpenCode serve sibling from its attached conversation", () => {
    const nativeRows: NativeProcessRow[] = [
      { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "zsh", startedAt },
      { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "node", command: "node /opt/openrig/opencode-runner.js", startedAt },
      { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "opencode", command: "opencode serve --hostname 127.0.0.1 --port 4096", startedAt },
      { pid: 13, ppid: 11, pgid: 11, tpgid: 11, executableName: "opencode", command: `opencode attach http://127.0.0.1:4096 --dir /repo --session ${token}`, startedAt },
    ];
    expect(findExactNativeResumeProcess(nativeRows, 10, "opencode", token)?.pid).toBe(13);
    expect(findExactNativeResumeProcess(nativeRows.filter(row => row.pid !== 13), 10, "opencode", token)).toBeNull();
  });
  it("rejects arbitrary Node scripts, prompts, wrong runtimes and fork-parent arguments", () => {
    for (const command of [`node worker.js --resume ${token}`, `node /opt/bin/agy --prompt '--conversation ${token}'`, `agy --conversation ${token} --fork`, `echo agy --conversation ${token}`]) {
      expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "node", command, startedAt }], 10, "antigravity", token)).toBeNull();
    }
  });
});


describe("Antigravity per-launch identity", () => {
  const launchIdentity = { logPath: "/tmp/native-launch.log", generation: "generation-current" };
  const nativeRows: NativeProcessRow[] = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "agy", command: "agy --model selected --log-file /tmp/native-launch.log", startedAt }];
  async function verify(overrides = {}) {
    const { verifyAdditionalNativePaneProcess } = await import("../src/domain/native-process-lineage.js");
    return verifyAdditionalNativePaneProcess({ target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: () => nativeRows, launchIdentity, expectedGeneration: launchIdentity.generation, ...overrides }, "antigravity");
  }
  it("proves fresh process presence without inventing resumability", async () => {
    expect(await verify()).not.toBeNull();
    expect(await verify({ requireResume: true })).toBeNull();
    expect(await verify({ expectedToken: token })).toBeNull();
    expect(await verify({ expectedToken: token, requireResume: true, launchIdentity: { ...launchIdentity, sessionId: token } })).not.toBeNull();
  });
  it("rejects stale, missing, conflicting or wrong launch evidence", async () => {
    expect(await verify({ expectedGeneration: "old" })).toBeNull();
    expect(await verify({ expectedGeneration: null })).toBeNull();
    expect(await verify({ launchIdentity: null })).toBeNull();
    expect(await verify({ launchIdentity: { ...launchIdentity, logPath: "/tmp/another.log" } })).toBeNull();
    expect(await verify({ expectedToken: token, launchIdentity: { ...launchIdentity, sessionId: "wrong" } })).toBeNull();
    expect(await verify({ listProcesses: () => nativeRows.map(row => ({ ...row, command: row.command + " --log-file /tmp/native-launch.log" })) })).toBeNull();
  });
});
