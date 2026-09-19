# Initial harness validation — 2026-09-18

## Executed checks

| Check | Result |
|---|---|
| `node --check .pi/tests/harness.test.js` | PASS |
| `node --test .pi/tests/harness.test.js` | PASS: 9 tests |
| `npm run check` | PASS |
| `npm test` | PASS, including the current registered Target checkout suite |
| Installed pi native resource loaders/parser | 2 skills, 1 prompt, 3 agents; no skill diagnostics; `/deals` argument expansion retained `{previous}` |
| Read-only subagent parallel smoke | Skill-enabled scout and temporary equivalent-tool baseline both completed M1-M3/V1-V3; temporary agent removed |
| 20-query routing classification | Independent reviewer classified before reading expected results; all agreed with intended workflow/direct/operator routing |
| Independent review and repair | Initial FAIL F1 corrected; final re-review PASS, including read-only M4 state-transition comparison |

Cases are defined in [evals.md](evals.md). Core baseline and skill-enabled answers largely agreed; this small comparison does not demonstrate a benchmark-quality improvement. Routing classification is not the same as executing twenty workflows.

## Finding resolved

During setup, concurrent runtime changes added a Target checkout helper and changed watch completion semantics. The first guidance snapshot described the former cart-add completion flag. Independent review caught the mismatch; only harness guidance and its module map/evaluation cases were corrected. The corrected skill instructs agents to follow actual assignments and consumers, distinguishing `addedToCart` from checkout-confirmed `completed`, rather than trusting historical comments.

No runtime worker, package script, or dependency was edited by this harness task. Runtime files did change elsewhere during the session; early matching hashes are not evidence that the whole working copy stayed unchanged. Existing work was preserved. With no Git metadata, root documentation changes were checked against narrow local pre-edit snapshots rather than a historical Git diff.

## Limits

- No worker launch, browser/CDP connection, retailer request, notification, purchase, or authenticated manual verification.
- Isolated-browser E2E was not run.
- Write-enabled implementation delegation and an actual worker/reviewer editing chain were not smoke-executed. Chain shape, error recovery, resume behavior, and repair bounds were reviewed statically, not fault-injection tested.
- M4 was verified by reading current source/tests, not by adding runtime tests or executing a purchase path.
- Tool allowlists and instructions do not sandbox shell access. Offline PASS does not authorize purchases or prove live behavior.

Sanitized local handoffs are retained under `_workspace/deals-001/` (ignored, not required for resource loading). They capture a point-in-time review; revalidate current code before using their line references or verdicts for later work.
