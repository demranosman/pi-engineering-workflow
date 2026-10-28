# pi-engineering-workflow

Evidence-gated engineering workflow for Pi:

```text
PLAN -> ARCHITECTURE -> IMPLEMENTATION -> VERIFY -> DONE
```

The agent may think freely, but it cannot silently skip an approved plan,
architecture, or contract. Gates are mechanical: missing evidence, placeholders,
scope drift, and unverified claims block the flow.

> UI messages are currently Turkish. The implementation is language-agnostic.

## Commands

```text
/eng init
/eng plan <task>
/eng plan-check
/eng plan-approve

/eng architecture
/eng architecture-check
/eng architecture-approve

/eng implement
/eng verify
/eng audit [--slow]
/eng status
/eng gate
/eng back architecture
/eng back plan
/eng reset-models
```

`/auto` remains a model-selection command; it does not start this workflow.

## Install

Local development:

```bash
pi install /path/to/pi-engineering-workflow
```

Or load it for one run:

```bash
pi -e /path/to/pi-engineering-workflow
```

The extension auto-discovers `.engineering-agent/` in the project root.

> If an older `~/.pi/agent/extensions/engineering-workflow.ts` is still loaded,
> remove or disable it first. Two copies would register the same `/eng` command.

## Project state

```text
.engineering-agent/
├── config.json
├── state.json
├── plan.draft.md
├── architecture.draft.md
├── contract.json
├── verification.json
├── audit.json
└── quality-baseline.md
```

`config.json` controls verification commands, gates, revision budget, optional
audit integration, and phase model chains. See `examples/config.json`.

## Gate logic

- Plan and architecture are checked structurally before human approval.
- Contract hashes cover the approved plan, architecture, and `config.json`.
  Changing any of them blocks implementation until re-approval.
- Placeholder, scope, and verification checks are mechanical.
- Changed files are determined with `git`. Without git, `/eng verify` fails
  closed; it never guesses that nothing changed.
- A failing gate keeps its revision counter. After
  `max_revisions_per_phase` failures the workflow enters `BLOCKED`.
- A new `/eng plan` resets revision and repair counters.

## Verification commands

`/eng verify` runs the commands configured in `.engineering-agent/config.json`:

```json
{
  "commands": {
    "test": "npm test",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": "npm run build"
  }
}
```

At least one command must be configured, and all configured commands must exit
with code `0`. Empty commands are reported but do not count as success.

> Security note: these commands execute in the project root and are read from
> the project config. `/eng verify` and `/eng audit` therefore require an
> explicit confirmation in the UI before running anything. Without a UI, they
> fail closed unless the **user** sets `PI_ENGINEERING_ALLOW_COMMANDS=1`.
> A repository config cannot disable this confirmation.

## Model selection

Each phase has a fallback chain. Defaults are in `PHASE_MODEL_CHAINS`; override
them per project:

```json
{
  "phase_models": {
    "PLAN": ["provider/model-a", "provider/model-b"],
    "ARCHITECTURE": ["provider/model-a"],
    "IMPLEMENTATION": ["provider/model-c"],
    "VERIFY": ["provider/model-d"]
  }
}
```

On credit/quota exhaustion the extension records the failed model and switches
to the next available entry. `/eng reset-models` clears the failed list.

## Optional quality audit

`/eng audit` integrates an external Python `quality_pipeline`. It is disabled
unless `engineering_dir` or `quality_pipeline_dir` is configured (or
`PI_ENGINEERING_DIR` / `PI_QUALITY_PIPELINE_DIR` is set). No personal paths are
hard-coded.

## Test

```bash
npm test
```

Runs pure gate tests and an end-to-end regression suite with a fake Pi API.
No model calls, no network.

CI runs the same suite on Node 22 and 24, on Ubuntu and Windows.

## Design boundaries

- The workflow is a gate, not a sandbox.
- It does not implement isolation or replace the permission system.
- It records decisions; a human still approves plan and architecture.
- For sensitive repositories, pair it with `@gotgenes/pi-permission-system`.
