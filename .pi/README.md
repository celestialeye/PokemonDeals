# PokemonDeals development harness

A small pi team for maintaining this Windows/CommonJS repository. It does **not** run shopping workflows, connect to Chrome/CDP, or authorize purchases. Adding this harness does not modify worker behavior or npm operational commands.

## Use

Open pi in the repository root. Review and trust the project's resources when pi asks. In an already trusted session, use `/reload`; if a new trust decision is needed, use `/trust` and restart pi. Then:

```text
/deals plan a regression test for queue cooldown after a rejected request
/deals fix the scoped Amazon offer-validation regression and add offline tests
/deals review target-watch.js challenge stop conditions
/deals resume deals-001 re-review the queue fix
```

`/deals` expands [the orchestration prompt](prompts/deals.md). Natural-language maintenance requests are also routed there by the [AGENTS.md pointer](../AGENTS.md); simple questions and low-risk edits do not require a team. Plan/review-only requests never authorize implementation.

For direct skill use:

```text
/skill:deals-maintenance explain the Target cart-success boundary
/skill:deals-verification plan offline checks for a challenge-recovery change
```

## Team and execution

| Agent | Tools | Responsibility |
|---|---|---|
| `deals-scout` | read, grep, find, ls | Read-only source/test impact map and plan |
| `deals-worker` | read, grep, find, ls, edit, write, powershell | One scoped implementation slice and offline regression checks |
| `deals-reviewer` | read, grep, find, ls, powershell | Independent boundary/safety review; no source edits |

Agents explicitly read [maintenance](skills/deals-maintenance/SKILL.md) and, as needed, [verification](skills/deals-verification/SKILL.md) skills. This avoids depending on project skill auto-discovery in non-interactive child processes.

The coordinator uses `subagent` with `agentScope: "both"`, `confirmProjectAgents: true`, and the absolute repository cwd. Default flow: single scout -> coordinator plan -> worker/reviewer chain. Independent read-only analysis can run in parallel, but edits and test runs stay sequential. Repairs are capped at two rounds and each ends with another review.

Delegated runs keep sanitized manifests, plans, and handoffs under `_workspace/deals-NNN/`. Only the coordinator writes reports; read-only agents return text. New runs and explicitly resumed runs remain separate. `_workspace/` is ignored by Git, not a protected secret store.

## Runtime prerequisites and model choice

- Use a pi version with Windows `powershell` and tool allowlists. Commands use native PowerShell, not Bash.
- This session already supplies `subagent` through `@baryonlabs/pi-agent-harness` (inspected version: 2.1.0). No new extension or global setting was installed by this project harness.
- On another machine, the user must separately review/install a compatible subagent extension. One option is `pi install npm:@baryonlabs/pi-agent-harness@2.1.0`. This is a user setup step, not an automatic repair action. Do not install a second copy if the tool already exists.
- All agent definitions explicitly use `litellm-local/gpt-6-astra`, matching the configured coding route. This intentionally avoids unavailable Anthropic model tiers and child-process default-model drift. Model selection remains with the gateway; the route is **not** a claim of local/offline inference. Review and deliberately change the `model` fields if porting to another configured provider; never silently switch to hide failures.
- Project-agent confirmation and tool allowlists are useful boundaries, **not a sandbox**. Shell tools have host access. In non-interactive environments, ensure project trust was deliberately configured; interactive confirmation is not a substitute for OS isolation.
- If delegation or the configured model is unavailable, the workflow reports BLOCKED rather than auto-installing, disabling trust, or claiming independent review.

## Checks

From the repository root:

```powershell
node --check .pi/tests/harness.test.js
node --test .pi/tests/harness.test.js
npm run check
npm test
```

The harness test uses Node built-ins only. It checks the supported single-line frontmatter format, resource links, explicit tool/model settings, agent references, and key workflow contracts. It neither imports workers nor launches pi/browser processes. Run it explicitly: it is not registered in the existing npm unit/syntax scripts.

These structural tests cannot prove model compliance, extension availability, or live checkout safety. [Evaluation scenarios](tests/evals.md) provide read-only smoke and trigger checks; record actual results separately from intended assertions. Isolated Chrome tests are a separate opt-in layer, and authenticated manual verification remains outside this harness.

## Maintenance

Keep the team small: retail-specific procedures belong in the shared skill/module map, not duplicate agents. On changes, update the affected agent/skill/prompt, run contract tests and relevant read-only scenarios, and add a concise entry to the root `AGENTS.md` harness history. Preserve unresolved evidence and ask for feedback rather than automatically broadening scope.
