# Target challenge recovery: developer guide

This guide explains the **current implementation**, not a proposed solver or a guaranteed way to trigger Target verification. [README.md](./README.md#optional-target-press-and-hold-recovery) is the operational/configuration reference. [The handover](./TARGET-CHALLENGE-SOLVER-HANDOVER.md) defines the plugin contract and acceptance status; [trigger evidence](./TARGET-CHALLENGE-TRIGGER-EVIDENCE.md) and [session learnings](./SESSION-LEARNINGS.md) record observations and limitations.

## 1. Vocabulary and reading order

- **PDP:** product detail page. The monitor reloads this page when it needs a fresh browser-owned request or a visible verification widget.
- **TCIN:** Target's product identifier, used to match a product with its availability data.
- **CDP:** Chrome DevTools Protocol. The worker connects to Chrome already running at `127.0.0.1:9444`; the solver does not launch Chrome.
- **Attempt:** one invocation of the solver. **Recovery cycle:** the driver's bounded collection of attempts. **Backoff:** the monitor's longer pause after a cycle fails.
- **Request template:** a captured fulfillment URL, method, body, and selected headers. It stays in memory and can contain sensitive runtime values.

Read these files in order:

| File | Responsibility / useful entry points |
|---|---|
| [`target-challenge.js`](./target-challenge.js) | Shared types/kinds, pure `detectChallenge()`, trusted module loading, and `resolveChallenge()` retry/verification contract. |
| [`target-challenge-page.js`](./target-challenge-page.js) | `visibleScopes()` finds visible browser scopes; `inspectChallenge()` reads their live evidence; `withTimeout()` bounds individual waits. No input or DOM mutation. |
| [`target-challenge-solver.js`](./target-challenge-solver.js) | One native-input attempt: discover, hold, release, wait for completion. `createSolver()` supplies dependency injection for tests. |
| [`target-watch.js`](./target-watch.js) | `handleChallenge()` integration, browser-owned availability requests, per-product job state, serialized work, backoff, and stop conditions. |
| [`tests/target-watch-challenge.test.js`](./tests/target-watch-challenge.test.js) | Read alongside the monitor to see queue ownership, stop-flag, and stale-state regressions. |
| [`tests/target-challenge-solver.integration.test.js`](./tests/target-challenge-solver.integration.test.js) | Real browser mechanics against local fixtures/intercepted responses, not live Target. |

## 2. Recovery flow and ownership

```text
product navigation / post-cart-click / challenged API / deferred response signal
  -> handleChallenge(job, state, reason)
     -> inspectChallenge(page)
        -> clean, with no outstanding network challenge: return "clear"
        -> unreadable or network challenge without page evidence: pause/back off
        -> readable challenge but no configured solver: pause/back off
        -> readable challenge with a solver: enter the mutation queue
           -> resolveChallenge()
              -> invoke solver once
                 -> discover a unique supported control
                 -> native pointer down, bounded hold, pointer up in finally
                 -> wait for live completion within remaining attempt budget
              -> after normal return: settle, then inspect independently again
              -> still blocked: next attempt on the same page, if any remain
           -> verified clearance: discard stale job state, reset backoff, log solved
           -> exhausted/failed cycle: pause/back off
  -> resume polling only if no other stop condition applies
```

Four monitor entry points feed this flow:

1. `navigateProduct()` checks after loading the product page.
2. `triggerPurchase()` checks after a cart/preorder click. Solving does **not** prove the cart action succeeded; cart evidence is checked separately.
3. `pollAvailability()` handles a challenged replay response by loading the PDP so an interstitial can render.
4. `attachResponseMonitor()` records `job.challengeSignal`; the next poll tick handles it. Event listeners never start competing input actions.

**The solver never owns success.** Its return value is ignored, including `true`. The driver's separate verification must read live state. Solver-side inspection only avoids returning too early while a provider is still processing.

### Two different result vocabularies

`resolveChallenge()` returns an object with `outcome` and `attempts`:

| Outcome | Meaning |
|---|---|
| `cleared` | Independent verification passed after an attempt. |
| `unresolved` | Attempts returned normally, but the page stayed blocked. |
| `failed` | No attempt cleared the page and at least one solver exception was retained. An earlier exception remains relevant even if later attempts returned normally. |
| `unsupported` | No solver function was supplied. The monitor normally handles missing configuration before calling the driver. |

`handleChallenge()` returns `"clear"`, `"resolved"`, or `"blocked"`. `"clear"` means no solve was needed; `"resolved"` means a verified solve occurred. Neither string means an order was placed.

Throwing from a solver skips that attempt's settle/verification step and advances the retry loop. Do not throw merely to report “I clicked”: return normally and let verification decide. The built-in solver uses categorical errors rather than browser error strings that may expose request tokens.

## 3. The state and queue rules that must not be broken

A `MonitorJob` belongs to one product tab. Its JSDoc is in `target-watch.js`:

- `availabilityRequest`, `lastSummary`, and `lastFingerprint` are cached evidence, not authority to buy.
- `challengeSignal` is a deferred listener notification, not permission for concurrent solving.
- `pollCount` counts loop ticks, which can include navigation without an API replay.
- `triggered` prevents overlapping cart attempts; `completed` means cart-add evidence, **not checkout/order completion**.

All jobs share a monitor coordinator with two queues:

- **Mutation queue:** cart input and challenge input cannot overlap. It is not reentrant. Post-click recovery already runs inside a queued mutation, so it passes `mutationOwned: true` and resolves directly. Enqueueing behind itself and then awaiting that queued action would deadlock. Other callers must not pass this flag.
- **Global request queue:** serializes polling ticks and applies a cooldown after the previous tick completes. A tick can also navigate or handle a challenge, so it is not merely a raw fetch limiter.

The coordinator distinguishes three conditions:

| State | Meaning |
|---|---|
| `pausedUntil` | Temporary failure backoff. Successful verified recovery resets the escalation ladder. |
| `calibrationStopped` | Terminal observe-only error. Solving later must not erase unrelated errors or ordinary calibration's stop decision. |
| `challengePending` | Explicit validation mode is resolving an API challenge. Another queued request must not start until resolution clears this barrier. |

`TARGET_CHALLENGE_VALIDATE=1` lets observe-only runs recover from challenged API responses; it is not a blanket “ignore errors” mode. Failed solves, other HTTP/fetch/parse errors, and poll/runtime limits still stop the run. Runtime limits are checked between operations and do not interrupt an already running action.

Successful recovery clears the request template, deferred signal, stock summary, and log fingerprint, and allows a fresh PDP navigation. Do not replay pre-challenge cached data as evidence that the session recovered.

## 4. Browser frames and fail-closed inspection

The real widget's actionable iframe was inside a **closed shadow root**, with hidden iframe copies nearby. Ordinary CSS iframe enumeration missed the live control. `visibleScopes()` therefore prefers `page.frames()` and checks each frame owner's **entire ancestor chain** for visibility. Each visible frame is included once; the main page is included separately.

The helper caps raw frames at 64 and total visible scopes at 32. Locator-only adapters/fakes retain a bounded `frameLocator()` traversal. The code does not open shadow roots, remove overlays, or inject synthetic pointer events.

`inspectChallenge()` reads the main URL/title and body text in the visible scopes under one read deadline. Positive evidence is retained across scopes; a later clean frame cannot erase it. Specific press-and-hold text takes precedence over a generic block classification.

**Unreadable is not clean.** Closed pages, empty/transitional pages, frame/read failures, or exceeded inspection bounds produce `{ detected: true, kind: "generic", unreadable: true }`. The monitor will not start a solver on this initial unknown state, and the verifier will not count it as clearance. Do not “fix” a read failure by substituting empty text and declaring success.

## 5. One solver attempt, step by step

1. Reject a missing/closed page or unsupported challenge kind before sending input. The built-in solver supports `press_and_hold`, not arbitrary CAPTCHA or access-denied screens.
2. Validate timing configuration and establish one deadline. Discovery reserves a small margin for pointer-down rather than consuming the entire attempt searching.
3. Search visible scopes for an enabled button role named `Press & Hold` or `Press and hold`. Only if no eligible role control exists does it consider exact text matches. More than one candidate is an error, not a reason to choose `.first()`.
4. Hover with actionability checks, retain an `ElementHandle`, and obtain current geometry. Browser coordinates are calculated at runtime; screenshot coordinates are never hardcoded. Retaining the handle prevents a progress-label change from looking like disappearance of the held element.
5. Set the release flag **before** awaiting pointer-down. The browser may have received input even if its acknowledgement fails. Keep holding while the challenge remains present; release when readable clean-page evidence appears, the held element disappears, or the per-attempt safety budget expires. Element disappearance is still not proof of clearance.
6. Attempt pointer-up in `finally`, including error/navigation/detach cases. Preserve the primary error if cleanup also fails. Disposing the handle releases an object reference, not the DOM element.
7. Wait for live clearance within the remaining budget. A spinner, changed label, or `Please try again` message must not be treated as success. Return control to the driver for its own settle and independent verification.

The bundled solver does not recursively retry, reload the page between attempts, create tabs, clear cookies, rotate profiles, or modify the request queue. A refresh-before-second-attempt policy existed only in a live diagnostic harness; that branch was not needed in the passing run and is not a shipped feature.

### Timing is layered, not one global cancellation mechanism

See [README configuration](./README.md#target-url-availability-watch) for defaults/ranges.

| Layer | Owner / meaning |
|---|---|
| Dynamic hold | Solver keeps native input down while the challenge remains present; the provider determines the required duration. |
| Attempt budget | Solver discovery, dynamic hold, and completion waiting, default 20 seconds. |
| Cleanup allowance | Up to 1000 ms for release and 500 ms for handle disposal beyond the action deadline. |
| Settle interval | Driver delay after a normally returned attempt, default 1500 ms, before another independent read. |
| Attempt count | Driver; default three consecutive attempts on the page left by the previous attempt. |
| Backoff | Monitor; follows an exhausted/failed cycle, not every individual hold. |

`withTimeout()` bounds waiting for one operation. `Promise.race()` does **not** cancel a browser command already dispatched. It must not wrap an entire input routine that could continue issuing later clicks after timeout. A lost browser connection may prevent release; fail closed rather than promising guaranteed cleanup.

The driver does not impose a deadline on arbitrary third-party solver modules. Only load trusted modules that honor the contract and bound their own work. The monitor captures its environment configuration at module load; the bundled solver reads its own timing values at each invocation.

## 6. Existing profiles versus test profiles

**Normal operation uses the existing authenticated Chrome context on CDP port 9444.** It opens a dedicated tab for each configured product, not a new profile. If CDP is already available, reuse that browser; do not restart it or replace its cookies/user agent merely to get a clean test. A solver receives an existing `page` and needs no fresh profile.

- **Unit tests:** fake pages and clocks; no Chrome needed.
- **Local browser E2E:** isolated installed Chrome and intercepted fixture traffic. Isolation is essential because the test handler fulfills/aborts requests, including real-looking Target URLs. Never attach it to the user's live context.
- **Historical trigger diagnostics:** separate unauthenticated profiles isolated browser settings/cookies/cart state from the logged-in profile, but did not isolate IP reputation. Their nonstandard user agent and automation flag are evidence settings, not production recommendations.

For future operational verification, prefer the user's existing profile in observe-only mode, unchanged authentication/cookies/user agent, and a naturally presented challenge. Stop other workers sharing its cart/input state. Do not call exported `triggerPurchase()` directly in live diagnostics: its normal observe-only guard lives in `inspectAndTrigger()`. Tests call that lower-level function only on intercepted local fixtures.

## 7. Reading logs and troubleshooting

| Signal | Interpretation / next diagnostic |
|---|---|
| `TARGET_CHALLENGE_DETECTED` | Readable challenge evidence was found; not a solve result. |
| `TARGET_CHALLENGE_HOLD_STARTED` | Pointer-down returned normally; the solver is now waiting for readable clearance evidence or its attempt budget. |
| `TARGET_CHALLENGE_HOLD_FINISHED elapsedMs=...` | Total attempt telemetry, including discovery, dynamic hold, cleanup, and completion waiting; **not success**. |
| `TARGET_CHALLENGE_CLEARED` | The driver's independent post-attempt verification passed. |
| `TARGET_CHALLENGE_SOLVED` | Monitor recovery/reset was recorded; still check subsequent API evidence. |
| `TARGET_CHALLENGE_BACKOFF` | Unsupported, unreadable, unresolved, or failed recovery paused the worker. |
| `TARGET_API_POLL` | Transport evidence is recorded before JSON parsing. HTTP 200 alone is insufficient: require a valid availability payload too. |
| `CHALLENGE_CONTROL_NOT_FOUND` | Discovery expired; inspect the preserved page's frame structure/labels rather than inventing coordinates. |
| `CHALLENGE_CONTROL_AMBIGUOUS` | More than one eligible match (or excessive matches); investigate duplicates/visibility. |
| `CHALLENGE_KIND_UNSUPPORTED` | The built-in solver must not interact with this generic block. |
| `CHALLENGE_OPERATION_TIMEOUT` / `CHALLENGE_RELEASE_FAILED` | Bounded operation or cleanup failed; do not continue issuing input blindly. |

The summary's `challengeCount` counts challenged **API polls**, not all DOM-only challenges. A run can therefore have `challengeCount: 0` and `challengeSolvedCount: 1` without contradicting its live detection logs.

Never log captured request URLs/bodies, cookies, API keys, or challenge tokens. Preserve categorical errors, timings, sanitized state transitions, and redacted screenshots instead. A widget saying `Please try again` remains blocked; retries are bounded, and neither repetition nor refresh guarantees acceptance.

## 8. Tests and what has actually been proven

```powershell
npm run check
npm run test:unit
npm run test:challenge:e2e
```

For the local browser fallback, set `TARGET_BROWSER_DRIVER=playwright` before the E2E command and restore your previous value afterward. Local browser tests use installed Chrome, not the authenticated CDP connection.

| Test file | Primary coverage |
|---|---|
| `tests/target-challenge.test.js` | Classification, module loading, ignored return values, driver retries/verification. |
| `tests/target-challenge-page.test.js` | Frame visibility/ancestors, bounded reads, fail-closed unknown states. |
| `tests/target-challenge-solver.test.js` | Input ordering, cleanup, config bounds, fake-clock timing, delayed completion. |
| `tests/target-watch-challenge.test.js` | Post-click queue ownership, cached-state reset, validation/stop flags. |
| `tests/target-challenge-solver.integration.test.js` | Native browser input, hidden/closed-shadow frames, navigation/processing, and intercepted monitor recovery. |

Fake pages are deliberately small behavioral doubles, not a DOM emulator. Their logical clock does not replace the native timer used by `withTimeout()`. Browser fixtures store evidence in DOM attributes because Patchright's isolated evaluation world does not share page-script globals.

A [bounded real-Target run](./screenshots/target-live-retry-refresh-2026-09-18T20-11-28-193Z.json) recorded actual cleared/solved events followed by two fresh valid HTTP 200 polls. It used the real solver, driver, and request queue through a diagnostic harness, a preserved unauthenticated challenge, a 45-second attempt budget, and no purchase actions. The first retry succeeded; the optional refresh branch was unused. An extra transient unreadable inspection is retained in the report, alongside later clean inspections and valid responses.

That evidence does **not** prove a deterministic trigger, repeated-run reliability, the default 20-second budget, the full authenticated production CLI, the unused refresh fallback, or checkout/order placement. Keep local fixture passes, live recovery evidence, and production claims separate when changing this code.
