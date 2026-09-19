---
description: "Plan, implement, debug, or review PokemonDeals retailer workers safely. Supports updates, follow-up fixes, resume, partial reruns, and re-review of prior results."
argument-hint: "<task | plan task | review scope | resume run-id task>"
---

Coordinate the following PokemonDeals development request:

$@

Use the `subagent` tool with `agentScope: "both"` and `confirmProjectAgents: true` on **every** delegation. Keep the user in control. This prompt is not permission to operate a monitor or checkout.

## 0. Context, safety, and triage

1. Read `AGENTS.md`, `.github/copilot-instructions.md`, `.pi/skills/deals-maintenance/SKILL.md`, and `.pi/skills/deals-verification/SKILL.md`. Resolve the absolute repository root and use it as `cwd` for every subagent; in parallel/chain mode set each task's cwd too.
2. An empty or ambiguous request needs a scope question, not an invented product or purchase task. A request to run a worker gets a safety explanation and a separately approved operator procedure, not delegation to a development agent. No worker launch, CDP/browser contact, live retailer request, Discord notification, credential access, or purchase in this workflow.
3. Inspect `.pi/agents/` before invoking their definitions. Respect project-agent trust confirmation. Do not install extensions, change global settings, switch model routes, or disable confirmation to recover a failure.
4. Classify the request:
   - **Conversational:** answer directly from bounded source evidence; no team or workspace needed.
   - **Small:** one low-risk isolated edit; main agent or a single `deals-worker`. Preserve verification requirements. State-machine, queue, checkout-guard, and challenge changes are at least standard even if one line.
   - **Standard:** multi-file/behavior work; scout -> main plan -> worker -> independent review, one slice at a time.
   - **Substantial:** architecture, new purchase policy, changed safety limits, or broad refactor; present a plan and obtain explicit approval before implementation. Then execute as bounded standard slices.
   - **Plan/review only:** no source edits; route to `deals-scout`/`deals-reviewer` respectively, regardless of complexity.

## 1. Run state and handoff ownership

For delegated work, inspect `_workspace/` by directory listing only. Start a new unused `_workspace/deals-NNN/` directory for a new task. Resume an existing run only when the user identifies it (or the current conversation unambiguously does); otherwise ask. Do not rename, delete, or overwrite unrelated runs.

The **main coordinator** creates and updates `manifest.md` with sanitized request, mode, status, allowed files, acceptance criteria, baseline references, chosen agents, exact test plan, completed stages, repair count, and outstanding manual gates. No secrets, request captures, transient URLs, or raw authenticated screenshots in artifacts. Ignore this workspace in Git, but remember that ignored files are not a secret store.

Use these coordinator-owned artifacts, storing each agent's returned HANDOFF verbatim after checking it for sensitive values:

- `01_scout.md`: source/test impact map and evidence.
- `02_plan.md`: self-contained request, approved slice/file ownership, constraints, acceptance criteria, and safe checks. Include repository root and previous artifact paths.
- `03_implementation.md`: changed paths, actual test results, open issues.
- `04_review.md`: independent verdict and evidenced findings.
- `05_final.md`: integrated result, checks, remaining gaps, next action.

Read-only agents return text; never ask them to write reports or manifests through the shell. Keep returns under 1,200 words; split overly broad analysis into bounded subtasks rather than losing it to the parallel output cap. Follow-ups use revision-suffixed artifacts (for example `04_review-r1.md`) and preserve earlier evidence. Re-read current files/baselines; old PASS results do not certify changed code.

## 2. Delegate only what is needed

**Single:** call `deals-scout` for unfamiliar code/planning, or `deals-reviewer` for review-only work. Every task must include the request, root, scope, acceptance criteria, plan/prior artifact paths, and the offline-only boundary. Persist its returned HANDOFF before proceeding. If only a plan was requested, return it and stop.

**Parallel:** only for independent read-only analysis of separate scopes (for example Target and Amazon impact maps using two `deals-scout` tasks). Use at most three tasks in this harness; the tool supports eight, four concurrent. Main reads and integrates all results, recording disagreements. Do not parallelize edits or test suites, and do not run a reviewer while a worker is still editing its input.

**Chain:** for an approved implementation slice, use the following shape, replacing angle-bracket paths with actual absolute paths. The first task reads the full plan; the reviewer reads the same plan and uses `{previous}` for the implementation handoff.

```json
{
  "agentScope": "both",
  "confirmProjectAgents": true,
  "cwd": "<repository-root>",
  "chain": [
    {
      "agent": "deals-worker",
      "cwd": "<repository-root>",
      "task": "Read <run>/02_plan.md and implement only its assigned slice and acceptance criteria. Follow the offline-only boundary. Return HANDOFF with changed paths, exact checks and open issues."
    },
    {
      "agent": "deals-reviewer",
      "cwd": "<repository-root>",
      "task": "Read <run>/02_plan.md. Independently review its slice in current source and tests; run the approved offline checks without editing. If implementation is FAIL/BLOCKED, report that barrier, not completion. Return a verdict using HANDOFF. Implementation handoff: {previous}"
    }
  ]
}
```

Persist **both** step outputs from the tool results as implementation/review artifacts. If a step output is unavailable or truncated, retrieve a bounded handoff with a single read-only follow-up; do not fabricate an artifact or rerun edits blindly. With tools that do not expose intermediate results, use sequential single calls instead of chain.

Review after **each completed slice**, before extending dependent modules. The main agent checks evidence and the resulting diff (or before/after text when Git is absent), not just the verdict label.

## 3. Failures, repair, and final gate

- The tool stops a chain on execution failure. A textual FAIL/BLOCKED verdict may not stop a chain, so inspect each returned status and do not advance dependent work past a failed gate.
- For a transient tool failure, inspect partial edits/artifacts first, then retry the failed step **once** only if safe and justified. Do not blindly rerun a worker. Report an unavailable tool/model or denied trust; never silently reroute.
- If subagent is unavailable, report it. Small safe work may be done directly within the user's scope; do not claim independent review occurred. Standard/substantial work remains BLOCKED until the user chooses a reduced/direct workflow or restores delegation.
- On evidenced review FAIL, delegate only in-scope fixes to `deals-worker`, followed by a fresh `deals-reviewer` call. Maximum **two repair rounds**, counted in the manifest. Stop and ask on scope expansion, missing evidence, or unresolved failure; do not weaken guards/tests to get PASS.
- Required syntax/unit failures or a missing required review cannot be omitted from the completion gate. An optional analysis failure may be reported as incomplete, but never converted to a successful safety review.
- Finish with a concise `05_final.md` and user summary: changed paths, checks actually run/results, unresolved risks, and manual verification not performed. Offline PASS does not certify live behavior. No automatic commit, PR, push, merge, install, or deployment.
- Offer the user a chance to adjust the result/workflow. Recurring feedback may justify a focused harness update; record approved harness changes in `AGENTS.md` and rerun `.pi/tests/harness.test.js`.

## Test scenarios

- **Normal:** plan a queue-rejection regression -> scout reads queue plus tests -> main records a bounded plan -> plan-only stops; implementation requests proceed worker -> reviewer, with offline evidence and no CDP call.
- **Follow-up:** resume a named run to re-review a fix -> read prior artifacts/current files -> create a revision report without overwriting earlier evidence or reimplementing unrelated work.
- **Failure:** reviewer reports a failing stop-flag test -> repair only that defect -> review again; after two failed repairs return FAIL with evidence, never success-by-omission.
- **Blocked:** unavailable subagent/model, denied trust, missing plan, unsafe test import, or request to run authenticated checkout -> state the barrier and stop before live actions. No model switch, auto-install, or browser fallback.
