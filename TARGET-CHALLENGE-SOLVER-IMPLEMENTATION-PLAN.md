# Target challenge solver: review and implementation plan

**Implementation update (2026-09-18):** the follow-up implementation delivered the opt-in solver, integration corrections, unit tests, and isolated browser E2E coverage. An initial bounded live Target run returned five HTTP 200 responses without a challenge. A later isolated nonstandard-user-agent test did present a real challenge, which cleared after native input and was followed by a fresh HTTP 200 poll. That test exposed closed-shadow frame discovery and delayed-completion gaps, now fixed and regression-tested. The original driver returned before clearance. A later bounded retry with the revised wait produced the actual same-run cleared/solved events followed by two fresh HTTP 200 polls, closing that diagnostic gate. The passing test used a 45-second budget in an isolated nonstandard-user-agent session; default-budget, refresh-fallback, and normal authenticated-session reliability are not established. See `TARGET-CHALLENGE-SOLVER-HANDOVER.md` and `SESSION-LEARNINGS.md` for current status. The review findings and validation section below record the pre-implementation baseline.

## Recommendation

Implement an opt-in, bounded solver, but do not treat the current monitor integration as production-ready. The handover correctly preserves independent verification, serialized actions, conservative polling, and backoff. However, its claim that only one module remains is incomplete: there are integration defects and acceptance-test conflicts that require an explicit scope decision.

This plan does not implement the solver or authorize live Target traffic. Keep the solver unset until the applicable acceptance gates pass.

## Review findings

| Priority | Finding | Consequence / required decision |
|---|---|---|
| Blocker | `inspectAndTrigger()` queues `triggerPurchase()`, which awaits `handleChallenge()`, which queues another mutation (`target-watch.js:250–294,423–499`). | With a configured solver and a post-click challenge, the outer mutation waits for work queued behind itself. Fix queue ownership before enabling purchase-mode solving. The current seam tests do not exercise this path. |
| Blocker | `recordApiPoll()` sets `calibrationStopped` on an observe-only challenge; `recordChallengeSolved()` does not clear it (`target-watch.js:668–703`). | A replayed API challenge can be solved and logged, but polling still stops. The requested same-run `TARGET_CHALLENGE_SOLVED` followed by successful `TARGET_API_POLL` cannot be assumed for this path. Preserve default stop-on-error behavior and agree on a narrowly scoped validation policy. |
| High | `inspectChallenge()` reads only the top-level title/body/URL and converts read failures into empty strings (`target-watch.js:235–239`). | An iframe-only challenge can be missed; an unreadable or transitional page can appear clean. Frame-aware solver interaction alone does not fix monitor detection or verification. Qualify this limitation with fixtures; any inspection hardening needs approval because the handover freezes that logic. |
| High | `resolveChallenge()` bounds attempt count, not attempt duration (`target-challenge.js:96–119`). | One stalled solver can hold the mutation queue indefinitely. The solver must enforce an overall deadline, bounded operations, and pointer cleanup without leaving asynchronous work running. |
| Medium | Stale request templates are cleared in the two polling recovery branches, not centrally after every successful solve (`target-watch.js:285,519,596`). | The handover's blanket statement that success discards stale templates is stronger than the implementation. Test navigation and post-click recovery as well, and decide whether to centralize invalidation. |
| Medium | The supplied fixture is top-level DOM, has a fixed 800 ms hold, and clears without navigation. Its accessible button name is `Press and hold`, while visible text is `Press & Hold`. | Existing evidence does not cover iframe discovery, cross-origin/nested frames, variable duration, navigation, or provider rejection. Match both label forms and add separate fixtures. |
| Medium | The driver skips settle/verification when the solver throws; any earlier exception is retained if later attempts remain unresolved (`target-challenge.js:108–124`). | Document the actual `failed` versus `unresolved` behavior. Do not assume every attempt receives post-verification, or that throwing means an immediately terminal failure. |
| Documentation | README already lists the three required solver variables, but other README/session notes still state that all verification is manual. The module JSDoc describes a boolean return although the implementation ignores it. `.github/copilot-instructions.md` also has obsolete test-runner information. | Update only the relevant operational statements and scope the optional behavior to `target-watch.js`; do not change other workers' manual-challenge policies. |

Additional acceptance caveats:

- A successful official HUMAN testing-token run validates an authorized integration, not automatic acceptance by Target's production policy.
- The handover describes controlled-provider testing as preferred, but its definition of done still requires a real Target monitor run. Track these as separate gates rather than substituting one for the other.
- `TARGET_MONITOR_MAX_POLLS` does not impose a wall-clock limit when no request template is captured. Live validation needs an external/operator time limit too.
- The monitor closes its job pages on exit (`target-watch.js:813–823`), so preserving a naturally challenged page needs an explicit procedure or separately approved diagnostic option. Do not assume observe-only exit preserves it.

## Phase 0 — Agree on scope and acceptance

1. Confirm the initial implementation strategy: native browser press-and-hold interaction on a positively identified control. Treat production success as unproven; do not assume a fixed hold can satisfy HUMAN's additional checks.
2. Keep module loading exclusively through `TARGET_CHALLENGE_SOLVER`; preserve both supported export forms and ignored return values.
3. Approve a separate, narrowly scoped monitor-integration change for the blockers above. Do not silently override the handover's prohibition on changing detection, verification, or backoff.
4. If monitor changes are not approved, deliver the isolated solver and local tests only. Mark production integration blocked; do not claim the original definition of done is satisfied.
5. Verify the linked HUMAN testing procedure against current official documentation before creating the authorized-provider harness. Confirm access to a controlled tenant; testing tokens/headers must never be assumed to work on Target.

**Exit gate:** agreed scope, supported challenge kinds, timeout policy, and distinct local/provider/Target acceptance criteria.

## Phase 1 — Reproduce and address integration blockers (approval required)

Add focused fake-page/state regression tests before modifying behavior:

- Reproduce post-click queue re-entry. Give one layer ownership of serialization; call the internal resolution operation directly when already inside the mutation queue. Do not solve this with parallel work or by removing serialization.
- Reproduce observe-only's persistent stop flag after a recorded solve. Preserve normal stop-on-error defaults. Agree whether to introduce an explicit bounded solver-validation mode; if so, only independently verified challenge recovery may resume it. HTTP errors, malformed responses, poll limits, and unresolved challenges must still stop it.
- Exercise initial navigation, post-click, replayed API, and passive-listener challenge entry points.
- Test frame-only evidence, transient empty/read-failure states, and persistent blocks. If inspection changes are approved, make unreadable state fail closed and preserve existing detection patterns and independent verification.
- Test fresh request-template capture after every successful recovery, without increasing polling or navigation frequency.

Do not change backoff values, product caps, request concurrency, or the minimum cooldown. Keep this change separate from solver mechanics so it can be reviewed independently.

**Exit gate:** regression tests demonstrate that recovery cannot deadlock, falsely clear an unreadable page, or accidentally override unrelated stop conditions. Unapproved cases remain explicit release blockers.

## Phase 2 — Implement `target-challenge-solver.js`

Use CommonJS, existing browser APIs, and no new runtime dependency initially.

### Per-attempt lifecycle

1. Validate `ctx`, the live page, and supported challenge kind. For an unsupported challenge, perform no input and throw a sanitized descriptive error; returning an `unsupported` value would have no effect because solver returns are ignored.
2. Establish one total attempt deadline. Bound element discovery, each browser operation, hold time, completion waiting, and cleanup. If configuration is exposed, use solver-specific environment variables with finite positive values and hard upper bounds; distinguish them from driver attempts and settle time.
3. Discover a unique visible, enabled control in the main document or a relevant iframe, including nested frames where necessary. Prefer accessible roles/names matching both `Press & Hold` and `Press and hold`; use text only as a constrained fallback. Avoid generated class names, arbitrary `.first()` selection, and unbounded frame scans.
4. Scroll the control into view, verify its geometry, and use native browser pointer input. Do not dispatch synthetic DOM events, remove challenge elements, modify detector evidence, or transplant session tokens.
5. Attempt pointer release in `finally`, including navigation, frame detach, timeout, and partial-input failure cases. Preserve the primary error if cleanup also fails. Do not leave an active hold or background task for the next attempt.
6. Wait within the remaining budget for the resulting widget/page transition. Support same-document completion as well as navigation; do not require a navigation event that the fixture never emits. Return normally after the bounded interaction and let the driver's independent verification decide success.
7. Log attempt stages and elapsed time through `ctx.log`. Use stable error descriptions; never log cookies, provider tokens, request bodies, or token-bearing URLs. Do not emit the monitor-owned `TARGET_CHALLENGE_SOLVED` event.

No internal retry ladder: the driver already owns retries. No extra tabs, profile replacement, storage clearing, proxy rotation, provider test headers on Target, or queue/state access. A timeout implemented only with `Promise.race()` is insufficient if the abandoned task can continue issuing input.

**Exit gate:** one attempt always returns or throws within a documented bound and leaves no continuing input/work behind.

## Phase 3 — Unit and local-browser validation

### Unit tests: `tests/target-challenge-solver.test.js`

Use `node:test`, `node:assert/strict`, fake pages/locators, and controllable time:

- Successful top-level and iframe discovery; both accessible label forms.
- Hidden, disabled, ambiguous, missing, and detached controls; unsupported generic challenges.
- Input ordering, pointer cleanup, page closure, navigation during hold, and cleanup failure.
- Overall deadline and invalid configuration; ensure no work continues after timeout.
- Context propagation, redacted logs, and no mutations outside the supplied page.
- Composition with `resolveChallenge()`: verified clearance, persistent challenge, thrown errors, retry limits, and unchanged ignored-return-value behavior.
- Add loader coverage for function and `{ solveChallenge }` exports and invalid exports to the existing seam tests.

### Browser integration: `tests/target-challenge-solver.integration.test.js`

Keep browser tests in a separate npm script; ordinary unit tests remain browser/network independent.

- Launch an isolated test browser/profile, never the authenticated CDP session.
- Exercise the existing 800 ms fixture through detection → solver → driver verification.
- Add local fixtures for iframe and nested-frame presentation, delayed appearance, early-release reset, never-clearing state, and navigation on completion.
- Use a loopback server with separate origins for realistic cross-origin frame coverage; do not depend solely on `file://` behavior.
- Prove that a still-blocked fixture cannot be reported as cleared and that cleanup releases input on failure.
- Use the production Patchright driver first; verify the Playwright fallback too before claiming both are supported.

Update `package.json`: syntax-check the new solver, register its unit tests in `test:unit`, and add an explicit browser-integration command. Preserve existing test scripts.

**Exit gate:** `npm run check`, `npm run test:unit`, and the separate local integration suite pass. A skipped or unavailable browser test is not a passing integration gate.

## Phase 4 — Real-provider and Target acceptance

1. In a HUMAN tenant controlled by the tester, follow the current official testing process and keep all secrets in process environment variables. Scope test headers to that environment. Cover documented hold-duration boundaries and failed/incomplete attempts.
2. Record this as controlled-provider evidence only; testing-token success does not prove production Target recovery.
3. Once integration blockers are resolved, run one exact Target product with `TARGET_MONITOR_OBSERVE_ONLY=1`, conservative cadence (start at 5000 ms), a small poll limit, and an explicit wall-clock stop. Stop other workers sharing the profile. Do not invoke checkout or deliberately trigger challenges.
4. If a challenge appears naturally, retain the page through the automated attempt. Require independent clearance and a subsequent successful 2xx `TARGET_API_POLL` with a valid availability payload—not merely a log line or hidden widget. Confirm a fresh request template and zero purchase actions.
5. If no challenge appears, record “not exercised”; if it fails, preserve the failure/backoff outcome. Neither case completes Target acceptance. Do not extend the run or hammer search/Redsky to obtain evidence.
6. Save only sanitized timing, challenge layout, outcome, driver version, and necessary screenshots. Record the exact limits of the evidence in `SESSION-LEARNINGS.md`.

**Exit gate:** local tests, controlled-provider results, and actual Target results are reported separately. The handover's Target-specific definition of done remains incomplete until a genuine Target recovery is observed.

## Phase 5 — Documentation and rollout

- `README.md`: opt-in setup, new solver-specific limits if added, separate test commands, unsupported behavior, failure/backoff expectations, and disabling via removal of `TARGET_CHALLENGE_SOLVER`.
- `SESSION-LEARNINGS.md`: observed results only; distinguish fixture, official test-mode, and Target production evidence.
- `TARGET-CHALLENGE-SOLVER-HANDOVER.md`: reconcile approved scope changes, thrown-attempt semantics, and acceptance gates without weakening verification.
- `target-challenge.js`: correct the stale return-type comment; behavior changes require separate review.
- `.github/copilot-instructions.md`: correct stale test guidance and scope any manual-verification exception to the Target URL watch only.

Start with observe-only. Purchase-mode rollout additionally requires the post-click regression to pass. If production interaction is ineffective, disable the module and retain existing backoff/manual recovery; do not compensate with faster polling or repeated challenge-provoking navigation.

## Review validation performed

- Read the full handover and compared it with the challenge module, relevant monitor paths, existing seam tests, fixture, package scripts, README, and session notes.
- `npm run check`: passed.
- `npm run test:unit`: passed; existing challenge suite has eight tests and does not cover the monitor integration blockers.
- Bounded, in-memory reproductions using `createMonitorState()`: confirmed that an observe-only challenge stop survives `recordChallengeSolved()`, and that awaiting a nested mutation blocks queue progress. These were synthetic state checks, not real challenge solves.
- No Target requests, browser automation, authenticated session changes, or order actions were performed.
- This working copy has no Git repository; `git status`/diff are unavailable. Only this new planning document was written during the review.
