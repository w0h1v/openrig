import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import { AntigravityRuntimeAdapter, antigravitySeatPaths, classifyAntigravityPrompt } from "../src/adapters/antigravity-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
const EMPTY = "─────────────────────────────────────────────\n>\n─────────────────────────────────────────────\n? for shortcuts                   Gemini 3.1 Pro · low\n\n";
const RELAY = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/antigravity-activity-relay.cjs");
const relay = createRequire(import.meta.url)(RELAY);
const binding = { nodeId: "node", tmuxSession: "seat", cwd: "/work", model: "gemini-3.1-pro-low", launchGeneration: "g" } as NodeBinding;
function fixture() {
 const files: Record<string,string> = {[RELAY]: "present"};
 const tmux = {hasSession:vi.fn(async()=>true),getPaneCommand:vi.fn(async()=>"agy"),capturePaneContent:vi.fn(async()=>EMPTY),sendText:vi.fn(async(_session:string,_text:string)=>({ok:true})),sendKeys:vi.fn(async()=>{
 const m=JSON.parse(files[antigravitySeatPaths("/state","seat").statePath]!);files[m.logPath]='Propagating selected model override to backend: label="Gemini 3.1 Pro (Low)"';return {ok:true};})};
 const adapter = new AntigravityRuntimeAdapter({tmux:tmux as unknown as TmuxAdapter,fsOps:{exists:p=>p in files,readFile:p=>{if(!(p in files))throw Error("ENOENT");return files[p]!;},writeFile:(p,v)=>{files[p]=v;},mkdirp:()=>{}},stateRoot:"/state",activityRelayPath:RELAY,env:{},sleep:async()=>{},readVersion:()=>"1.2.14",readModels:()=>"gemini-3.1-pro-low\tGemini 3.1 Pro (Low)"});
 return {adapter,tmux,files};
}
describe("Antigravity native contract",()=>{
 it("requires exact empty bordered native input and rejects drafts/dialogs",()=>{
  expect(classifyAntigravityPrompt(EMPTY).ready).toBe(true);
  for(const content of [EMPTY.replace("\n>\n","\n> draft\n"),EMPTY+"Allow once?",EMPTY.replace("? for shortcuts","esc to cancel"),">\n? for shortcuts",EMPTY.replace("\n>\n","\n>\ncontinued draft\n"),"Select login method:"])expect(classifyAntigravityPrompt(content).ready).toBe(false);
 });
 it("does not mistake transcript quotations for current native gates",()=>{
  for (const history of [
   "Assistant: The test asserts the error failed to resume.",
   "User: Explain the Select login method dialog.",
   "Do you trust the contents of this project?",
   "Terms of Service & Data Use",
   "warning: conversation abc not found, ignoring --conversation flag",
  ]) expect(classifyAntigravityPrompt(history+"\n"+EMPTY)).toEqual({ready:true});
 });
 it.each(["login","color-scheme","terms"])("recognizes captured native %s dialog",name=>{
  const capture=readFileSync(path.join(import.meta.dirname,"fixtures/antigravity",name+".txt"),"utf8");
  expect(classifyAntigravityPrompt(capture)).toMatchObject({ready:false,code:"login_required"});
  // A positive native dialog must veto an empty composer visible behind it.
  expect(classifyAntigravityPrompt(capture+"\n"+EMPTY)).toMatchObject({ready:false,code:"login_required"});
 });
 it("recognizes native trust choices and refuses unrecognized dialogs without inventing an error",()=>{
  const trust="Accessing workspace:\n/tmp/work\nDo you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n";
  expect(classifyAntigravityPrompt(trust)).toMatchObject({ready:false,code:"trust_gate"});
  expect(classifyAntigravityPrompt(trust+EMPTY)).toMatchObject({ready:false,code:"trust_gate"});
  expect(classifyAntigravityPrompt("Assistant: failed to resume\nNative custom footer")).toEqual({ready:false,reason:expect.any(String)});
 });
 it("launches actual native flags without inventing fresh identity",async()=>{
  const {adapter,tmux,files}=fixture();expect(await adapter.launchHarness(binding,{name:"seat"})).toEqual({ok:true});
  const command=tmux.sendText.mock.calls[0]![1] as string;expect(command).toContain("agy --model 'gemini-3.1-pro-low' --log-file");expect(command).not.toContain("--session-id");expect(adapter.readSessionId("seat").ok).toBe(false);
  expect(adapter.readLaunchIdentity("seat","g")?.logPath).toContain("native-");expect(adapter.readLaunchIdentity("seat","old")).toBeNull();
  const hooks=JSON.parse(files["/work/.agents/hooks.json"]!);expect(hooks["openrig-antigravity-activity"].PreToolUse).toBeUndefined();
 });
 it("rejects unknown models before launch and never falls back",async()=>{
  const {adapter,tmux}=fixture();expect((await adapter.launchHarness({...binding,model:"auto"},{name:"seat"})).ok).toBe(false);expect(tmux.sendText).not.toHaveBeenCalled();
 });
 it("rejects missing native resume even if native exposes fresh prompt",async()=>{
  const {adapter,tmux}=fixture();tmux.capturePaneContent.mockResolvedValue('warning: conversation "12345678-1234-4234-8234-123456789abc" not found\n'+EMPTY);
  expect((await adapter.launchHarness(binding,{name:"seat",resumeToken:"12345678-1234-4234-8234-123456789abc"})).ok).toBe(false);
 });
 it("requires both verified native resume log markers for the exact requested ID",async()=>{
  const {adapter,tmux,files}=fixture();const token="12345678-1234-4234-8234-123456789abc";
  const send=tmux.sendKeys.getMockImplementation()!;
  tmux.sendKeys.mockImplementation(async()=>{await send();const m=JSON.parse(files[antigravitySeatPaths("/state","seat").statePath]!);files[m.logPath]+=`\nI0930 common.go:401] Resuming conversation ${token}\nI0930 manager.go:935] Full redraw completed (rerenderAll) for conversation ${token} (epoch 0, items 4)\n`;return {ok:true};});
  expect(await adapter.launchHarness(binding,{name:"seat",resumeToken:token})).toEqual({ok:true,resumeToken:token,resumeType:"antigravity_id"});
  const launch=adapter.readLaunchIdentity("seat","g")!;expect(launch.sessionId).toBe(token);
  files[launch.logPath]=files[launch.logPath]!.replace(`for conversation ${token}`,"for conversation aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");expect(adapter.readSessionId("seat","g").ok).toBe(false);
 });
 it("fences old launch metadata and preserves operator hooks",async()=>{
  const {adapter,files}=fixture();files["/work/.agents/hooks.json"]='{"operator":{"Stop":[]}}';await adapter.launchHarness(binding,{name:"seat"});const first=adapter.readLaunchIdentity("seat","g");await adapter.launchHarness({...binding,launchGeneration:"next"},{name:"seat"});expect(adapter.readLaunchIdentity("seat","g")).toBeNull();expect(adapter.readLaunchIdentity("seat","next")?.logPath).not.toBe(first?.logPath);expect(JSON.parse(files["/work/.agents/hooks.json"]!).operator).toEqual({Stop:[]});
 });
 it("protects user skill edits while updating unchanged owned skill files",async()=>{
  const {adapter,files}=fixture();files["/source/SKILL.md"]="original";
  const plan={runtime:"antigravity",cwd:"/work",entries:[{effectiveId:"helper",category:"skill",absolutePath:"/source/SKILL.md",classification:"safe_projection"}],startup:{files:[],actions:[]},conflicts:[],noOps:[],diagnostics:[]} as unknown as ProjectionPlan;
  expect((await adapter.project(plan,binding)).failed).toEqual([]);files["/source/SKILL.md"]="updated";expect((await adapter.project(plan,binding)).failed).toEqual([]);
  expect(files["/work/.agents/skills/helper/SKILL.md"]).toBe("updated");files["/work/.agents/skills/helper/SKILL.md"]="operator edit";files["/source/SKILL.md"]="new";expect((await adapter.project(plan,binding)).failed).toHaveLength(1);
 });
 it("refuses to replace an operator-owned hook block",async()=>{
  const {adapter,files,tmux}=fixture();files["/work/.agents/hooks.json"]='{"openrig-antigravity-activity":{"Stop":[]}}';expect((await adapter.launchHarness(binding,{name:"seat"})).ok).toBe(false);expect(tmux.sendText).not.toHaveBeenCalled();
 });
 it("fences callbacks against the current launch and detects changed native models",()=>{
  const root=mkdtempSync(path.join(tmpdir(),"openrig-agy-relay-"));try{
   const manifest=path.join(root,"manifest.json"),state=path.join(root,"state.json");const data={launchId:"current",generation:"g",expectedSessionId:null,modelSlug:"example-model"};writeFileSync(manifest,JSON.stringify(data));writeFileSync(state,JSON.stringify(data));
   const env={OPENRIG_ANTIGRAVITY_STATE_PATH:state,OPENRIG_ANTIGRAVITY_MANIFEST_PATH:manifest,OPENRIG_ANTIGRAVITY_LAUNCH_ID:"old"};const payload={generation:"g",sessionId:"12345678-1234-4234-8234-123456789abc",modelName:"example-model"};expect(relay.updateSidecar(payload,env)).toBe(false);
   env.OPENRIG_ANTIGRAVITY_LAUNCH_ID="current";expect(relay.updateSidecar(payload,env)).toBe(true);expect(JSON.parse(readFileSync(state,"utf8"))).toMatchObject({confirmed:true,modelMismatch:false});expect(relay.updateSidecar({...payload,modelName:"different"},env)).toBe(true);expect(JSON.parse(readFileSync(state,"utf8")).modelMismatch).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it("only fullyIdle Stop means idle and relays no prompt/tool payloads",()=>{
  const env={OPENRIG_SESSION_NAME:"seat",OPENRIG_NODE_ID:"node",OPENRIG_ANTIGRAVITY_LAUNCH_ID:"launch",OPENRIG_OCCUPANT_GENERATION:"g"};
  const input={conversationId:"12345678-1234-4234-8234-123456789abc",fullyIdle:false,prompt:"secret",toolArguments:"secret"};
  expect(relay.buildPayload(input,env,"Stop").hookEvent).toBe("active");expect(relay.buildPayload({...input,fullyIdle:true},env,"Stop").hookEvent).toBe("Stop");expect(JSON.stringify(relay.buildPayload(input,env,"PreInvocation"))).not.toContain("secret");expect(relay.buildPayload(input,{},"PreInvocation")).toBeNull();
 });
});
