# tdd-strict

A blocking TDD gate for [GSD Core](https://github.com/open-gsd/gsd-core).

GSD ships a first-party `tdd` capability. Its `execute:post` gate is `blocking: false` by design — a `type: tdd` plan that skipped the failing test gets a note in `SUMMARY.md` and the phase seals anyway. This capability adds a second gate at the same point that actually halts.

## What it checks

For every `type: tdd` plan in the phase, `checks/tdd-gate.js` asserts:

| Gate | Rule |
|---|---|
| RED | a commit matching `^test(<phase>-<plan>):` exists |
| GREEN | a commit matching `^feat(<phase>-<plan>):` exists |
| ORDER | the oldest RED commit is an ancestor of the oldest GREEN commit |

`refactor(<phase>-<plan>)` is optional and is reported, never required. Plans with `status: superseded` and plans that are not `type: tdd` are skipped. Both the root (`08-01-PLAN.md`) and nested (`plans/PLAN-01-*.md`) layouts are read.

Output on failure:

```
TDD gate violated in 1 of 3 plan(s):
  08-02 (.planning/phases/08-billing/08-02-PLAN.md): RED commit missing
Expected per plan: test(<phase>-<plan>) committed and failing, then feat(<phase>-<plan>).
```

## What it does not check

**This gate fires only at GSD loop extension points reached inside a GSD command.** Code an agent writes in a plain chat turn never crosses a loop point, so this capability never sees it. If you want enforcement at the tool-call boundary, pair this with a write-time guard such as [Probity](https://github.com/nizos/probity) — the two layers are complementary, not redundant.

It also does not judge test *quality*. A `test(...)` commit containing `expect(true).toBe(true)` satisfies the gate. Commit shape is what a deterministic check can see; whether the test was meaningful is what the first-party advisory review checkpoint asks a human to look at.

## Install

```bash
gsd capability install https://github.com/ayhid/tdd-strict.git#v0.1.0 --scope project
gsd capability state --raw
```

To install from a local checkout instead, clone the repo and point at it directly:

```bash
git clone https://github.com/ayhid/tdd-strict.git
gsd capability install ./tdd-strict --scope project
```

The repo name matches the manifest `id`, so a plain clone already produces the `tdd-strict` directory that `capability install <local-path>` requires. If you clone into a different directory name, rename it back to `tdd-strict` first. Installing from the git URL is unaffected either way.

Requires the first-party `tdd` capability, so turn that on too:

```bash
gsd capability set tdd --gate workflow.tdd_mode=true
```

Project scope puts the files in `.gsd/capabilities/tdd-strict/`; global scope uses `~/.gsd/capabilities/tdd-strict/`. The gate command resolves either.

## Configure

| Key | Type | Default | Effect |
|---|---|---|---|
| `tdd-strict.enabled` | boolean | `true` | Gate is active. Set `false` to keep the capability installed but inert. |

## Bypassing

A deliberate bypass needs a reason and leaves a trace:

```bash
GSD_TDD_STRICT_OVERRIDE="hotfix for incident 4412" /gsd-execute-phase 8
```

The reason is appended to `.planning/tdd-strict-overrides.log`. This exists so that the path of least resistance under pressure is a logged override rather than quietly flipping `tdd-strict.enabled` to `false`.

## Uninstall

Installed overlays are removed, not disabled — `gsd capability disable` only accepts first-party ids:

```bash
gsd capability remove tdd-strict --scope project
```

## Development

```bash
npm test          # node --test, no dependencies
```

Test the predicate against a real phase without going through a full loop:

```bash
gsd_run check predicate \
  --predicate '{"kind":"command-exit-zero","command":"node .gsd/capabilities/tdd-strict/checks/tdd-gate.js \"${PHASE_DIR}\"","timeout":60}' \
  --phase-dir ".planning/phases/08-billing" --phase-number "08" --raw
```

## License

MIT
