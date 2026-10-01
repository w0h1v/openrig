# OpenCode and Antigravity CLI

Managed runtime IDs are `opencode` and `antigravity`. Antigravity's executable is
`agy`; it is a separate product from Gemini CLI. No Gemini CLI compatibility or
model restriction is implied by this integration.

Configure and authenticate the native executable first. OpenRig checks executable
availability without making a model request; account entitlement remains unverified
until an actual model turn. Initial compatibility targets are OpenCode 1.18.x and
Antigravity CLI 1.2.x (native-tested 1.2.14). Other release families need compatibility verification.

## Provider-only setup

```sh
rig setup --runtime opencode
# or
rig setup --runtime antigravity
```

These explicit choices skip Claude Code and Codex installation and login. They do
not install the selected native CLI or choose a model. Ordinary `rig setup` retains
its existing behavior. Use the [official Antigravity installation guide](https://antigravity.google/docs/cli/install/)
and complete authentication in `agy` before starting managed seats.

## Kernel from the TUI

Start the TUI, open startup (`S`), and choose **Set up kernel**. Choose OpenCode (`o`)
or Antigravity CLI (`a`), then enter a concrete native model ID. OpenCode model IDs
use `provider/model`; preserve the full OpenRouter ID shown by your native setup.
For Antigravity, use an exact model ID from `agy models`. No paid model is selected
automatically. Enter prepares topology; choose individual seats to launch afterward.
Escape cancels model entry.

All three AI kernel seats receive the entered model. Existing kernels are reused,
never reconfigured by this chooser. Automatic kernel boot keeps its existing
Claude/Codex preference; detecting a new executable does not select that provider.

## Starter rigs

Available templates are `first-project-opencode`, `first-project-antigravity`, and
`first-project-opencode-antigravity`. The mixed template has an OpenCode owner and
Antigravity checker. Their `native` profile selects shared skills and startup guidance,
without Claude/Codex plugins or runtime configuration.

These templates intentionally have no model defaults. Use `rig specs show` to locate
the installed template. Copy the complete containing `specs` tree into a user-owned
`openrig-specs` directory, preserving relative agent and culture paths. Add a concrete
`model` field to **each AI member** of the copied rig using a model your account can
access. Do not launch a literal placeholder.

Preview and launch the edited copy from the intended repository:

```sh
rig up ./openrig-specs/rigs/launch/first-project-opencode-antigravity/rig.yaml --cwd . --plan
rig up ./openrig-specs/rigs/launch/first-project-opencode-antigravity/rig.yaml --cwd .
```

Missing models fail preflight. Native provider credentials belong in native stores
or the daemon process environment, never in specs, model IDs, or messages.

## Operator behavior

The TUI identifies OpenCode as `oc` and Antigravity as `ag`. Seat details distinguish
the configured model from unknown effective-model observation. Missing context and
usage data remain unknown. Existing messaging and terminal controls are reused;
automatic delivery requires proof that the native prompt can safely accept it.
Recovery requires a recorded, verified native conversation ID. A fresh conversation
is a separate explicit choice.

Reconciliation of an existing managed OpenCode or Antigravity conversation preserves
its session identity and launch generation. Adopting an unmanaged conversation or
using a discovered session as a handover successor is unsupported for these runtimes;
OpenRig refuses that operation before changing the current occupant. Launch a fresh
managed successor, or reconcile the existing managed conversation instead.

OpenCode preserves native permission policy; generic `full_bypass` is unsupported.
Antigravity permission modes are mapped only to verified native controls, with
sandbox constraints reported separately.

## Antigravity configuration and history

Antigravity's native configuration lives in
`~/.gemini/antigravity-cli/settings.json`; `/config` edits it, and `/model` changes
a persistent preference. OpenRig uses a seat's explicit model for launch rather
than altering that global preference. Antigravity shares settings with its GUI;
changing global settings can therefore affect other sessions. See the
[official CLI usage guide](https://antigravity.google/docs/cli/using/).

OpenRig does not support an Antigravity settings resource: no per-seat native
configuration override has been verified. It projects AGENTS.md and `.agents/skills`,
and adds an owned block to project `.agents/hooks.json`, without changing global
settings. Lifecycle reporting is partial: native hooks report invocation/tool/idle
activity, but there is no verified permission-request hook.

A fresh idle Antigravity seat has no native conversation ID until its first
invocation hook. OpenRig verifies its live process using the current launch's
unique log path and generation, but cannot resume it before that ID is captured.
Unknown `--conversation` IDs silently start fresh natively; managed restore refuses
that fallback and requires the current launch’s exact resume and completed-redraw
log markers (or captured native hook identity), otherwise it remains in attention.

Native `/resume` opens the conversation picker. Exact native resume uses
`agy --conversation <id>`. OpenRig does not use `--continue`: the native latest-session
cache can fall back to a fresh conversation. See the
[official resume guide](https://antigravity.google/docs/cli/commands/resume/).

Authenticated Antigravity model turns, permission round trips, and mixed-rig task
exchange require native acceptance. Unit tests and executable discovery do not
establish those behaviors. The adapter's documented supported settings and tested
lifecycle gates are the authority for managed launch capability.

## Selected provider configuration resources

In your own agent definition, add a native profile and a runtime resource. This is
an illustrative fragment: keep your existing shared skills and startup files as
needed, and create the referenced JSON file relative to that agent directory.

```yaml
profiles:
  router:
    uses:
      skills: []
      guidance: []
      subagents: []
      plugins: []
      runtime_resources: [router-settings]
resources:
  runtime_resources:
    - id: router-settings
      path: runtime/openrouter.json
      runtime: opencode
      type: opencode_config
```

For `runtime/openrouter.json`, reference an environment variable instead of storing
a credential:

```json
{
  "provider": {
    "openrouter": {
      "options": { "apiKey": "{env:OPENROUTER_API_KEY}" }
    }
  }
}
```

Configure that variable in the daemon's launch environment, or use OpenCode's native
credential store and omit the explicit API-key option. The bounded resource schema
allows `$schema`, `provider`, `permission`, `instructions`, and `small_model`; other
top-level keys are rejected. The main model belongs on the rig member.

The following member fragment is **not runnable as written**. Replace the bracketed
model slug with the exact OpenRouter model ID you selected and point `agent_ref` at
your agent directory. This does not choose a paid model for you.

```yaml
- id: owner
  agent_ref: "local:agents/router-owner"
  runtime: opencode
  model: "openrouter/<exact-model-slug>"
  profile: router
  cwd: "."
```

These integrations cover managed rig members, startup, TUI operation, and native
recovery. Older workflow-harness and package-manifest runtime allowlists are separate
surfaces and have not been broadened by this change. OpenCode image/fork discovery
uses only the named seat's persisted `opencode_id`.

OpenCode settings files must be strict JSON, not JSONC. OpenRig preserves global
native configuration and writes the selected configuration to seat-owned state.
Before attaching, it checks that the requested model appears in the native catalog
and its provider is connected; this does not prove model entitlement. It also checks
the native primary/default agent models. A conflicting model override in native
configuration or agent definitions blocks launch; remove that override or match the
member model. Global native configuration is preserved. Resume refuses
a requested model different from the conversation's last user model because native
attach cannot apply a model override. Use an explicit fresh conversation when changing
that model. OpenRouter billable model turns remain unverified in the local acceptance
checks. OpenCode 1.18.25 was the native version used for compatibility probes.
