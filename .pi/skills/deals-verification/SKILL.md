---
name: deals-verification
description: "Verify PokemonDeals JavaScript changes and harness changes with offline syntax checks, Node unit tests, boundary reviews, and evidence-based reports. Load when testing, reviewing, diagnosing a failed check, or rechecking a fix. Not a live browser, retailer-monitoring, purchasing, or benchmark workflow."
---

# Offline verification and review

Read `.pi/skills/deals-maintenance/SKILL.md` first for the shared safety boundary and handoff format. All commands below run from the repository root with PowerShell. The reviewer reports findings without editing source; the coordinator stores its report.

## 1. Establish a baseline

Read `package.json` and the selected test files before execution. Inspect imported workers for `require.main === module` startup guards and inspect new/changed tests for browser, subprocess, network, or filesystem side effects. A startup guard is not sufficient by itself: Target watch can load a configured challenge-solver module during import. Verify safe test configuration without exposing environment values; block execution if a plugin's side effects are unknown. A script name containing `test` is not proof of safety.

If Git is available, inspect status and the relevant diff without discarding work. This working copy may have no `.git`: capture narrowly scoped before/after text or hashes of assigned files instead. Report that a historical diff is unavailable; never initialize Git merely to make review work. Keep any temporary snapshots local and free of secrets.

## 2. Run the smallest safe check, then the repository gates

| Purpose | Command | Boundary |
|---|---|---|
| One changed JavaScript file | `node --check <file>` | Parses only; does not execute the worker |
| Focused existing unit test | `node tests/global-request-queue.test.js` (replace with the mapped suite) | Inspect the selected suite/imports first |
| Required JS syntax gate | `npm run check` | Required for every JavaScript change; only covers files registered in `package.json` |
| Unit regression gate | `npm test` | Delegates to `test:unit`; both Node test runner and direct-assertion suites |
| Harness contract tests | `node --test .pi/tests/harness.test.js` | Reads local harness resources only; does not spawn agents or import workers |

For every changed/new JavaScript file not covered by `npm run check`, run its explicit `node --check` too. For behavior changes, run the focused suite, `npm run check`, and `npm test`. For harness-only Markdown changes, run the harness contract tests; worker tests are optional regression evidence, not proof of prompt behavior.

Use bounded output and a reasonable timeout. Record command, exit code, summary, and actual errors. A timeout or missing dependency is BLOCKED, not PASS. Do not install packages automatically or rerun an unchanged failing command without new evidence. Do not print environment values. `npm run check` and `npm test` do not start operational workers in the inspected configuration; recheck that assumption after script/test changes.

## 3. Compare both sides of each changed boundary

- Availability parser output <-> watch decision <-> visible/enabled button guard.
- Queue completion/rejection <-> next admission/cooldown; lock acquisition <-> release/shutdown.
- Challenge driver outcome <-> independent inspector <-> watch stop flags and stale-state invalidation. Solver return values alone do not authorize resume.
- Offer predicate/cart selection <-> expected product, seller/shipper, price and total checks at checkout.
- Product catalog/config parser <-> worker selection and deduplication.
- New environment variable/default <-> actual usage, validation, tests, and README.
- Selector outcome <-> post-click state evidence, not just locator existence.
- State-field comments/docs <-> actual assignments <-> consumers/stop conditions. For Target watch, distinguish `addedToCart`, nonconfirmed checkout outcomes, and checkout-confirmed `completed`; inspect `target-checkout.js` and its test along with the watch.
- Harness agent name/tools <-> prompt delegation <-> skill paths <-> handoff ownership.

Test relevant failure paths: unreadable/malformed input, ambiguous controls, rejection/timeout cleanup, negative cart-add text, stale evidence, unrelated stop conditions, and duplicate/concurrent actions. Do not invent nonexistent checkout coverage.

## 4. Keep test layers distinct

1. **Syntax:** parse validity only.
2. **Offline unit:** pure helpers and fake browser state. This is the default behavioral gate.
3. **Isolated local browser:** `npm run test:challenge:e2e` uses installed Chrome and intercepted fixture traffic, not authenticated CDP. Run only when explicitly requested/approved for this layer, after verifying interception and isolation. Test the Playwright fallback separately if relevant; restore any process-environment changes afterward. Missing Chrome is a reported limitation, not a reason to attach to CDP.
4. **Live/authenticated:** outside this harness. A behavior change still requires deliberate manual verification under `README.md`; provide a bounded operator checklist with expected evidence, stop conditions, and redaction requirements. Do not perform it or claim it passed.

No observed challenge means recovery was **not exercised**. A fixture pass, a cleared challenge, and an order confirmation are not interchangeable evidence.

## 5. Verdict and repair

Use the HANDOFF format from the maintenance skill. In EVIDENCE, separate checks actually run from checks only recommended. For each finding include severity, producer and consumer `file:line` references, failure scenario, and a minimal repair/test suggestion.

- **PASS:** requested offline scope is complete, required checks passed, and no blocking defect was found. List manual/live gaps explicitly; this is never purchase authorization.
- **FAIL:** an evidenced defect or required check failure remains. Distinguish pre-existing failures from new ones when the baseline permits.
- **BLOCKED:** input, access, safe test conditions, or required evidence is missing. Missing tests cannot be converted into PASS by speculation.

The coordinator may request at most two bounded repair rounds, with a fresh review after each. Re-review the current code and prior findings; do not merely repeat the implementation agent's success claim. Preserve unresolved findings and let the user choose next steps.
