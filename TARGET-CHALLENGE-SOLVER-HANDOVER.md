# Handover: Target "Press & Hold" Challenge Solver

**Audience:** engineers maintaining or extending the solver and its monitor integration.
**Code walkthrough:** [TARGET-CHALLENGE-DEVELOPER-GUIDE.md](./TARGET-CHALLENGE-DEVELOPER-GUIDE.md) explains module ownership, interfaces, frame discovery, timing, queues, tests, and the existing-profile workflow. This handover retains the plugin contract and acceptance checklist.
**Status of this repo (2026-09-18):** the opt-in native-input solver and local unit/browser tests are implemented. Integration corrections address queue re-entry, iframe inspection, stale request invalidation, and explicit observe-only recovery validation. Independent verification is strengthened, not removed; backoff and request cadence are unchanged. **The required same-run sequence is now observed in a bounded real-Target diagnostic:** retrying a preserved `Please try again` state produced `TARGET_CHALLENGE_CLEARED`, `TARGET_CHALLENGE_SOLVED`, and two fresh successful availability polls. The run used an isolated unauthenticated browser, a nonstandard user agent/automation flag, and a 45-second attempt budget. Default-budget performance and normal authenticated-session reliability remain unproven. Earlier failed/delayed attempts exposed closed-shadow frame discovery and completion-wait gaps, now corrected and regression-tested. See `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md` and `SESSION-LEARNINGS.md` for the exact timeline and limits.

---

## 1. What already exists

| File | Role |
|---|---|
| `target-challenge.js` | Detection (`detectChallenge`), solver loading (`loadChallengeSolver`), and the bounded retry + verification driver (`resolveChallenge`). |
| `target-watch.js` | The monitor. Calls `handleChallenge()` at every point a challenge can surface. |
| `target-challenge-page.js` | Bounded independent inspection of the main page and visible nested frames; unreadable state fails closed. |
| `target-challenge-solver.js` | Opt-in native press-and-hold interaction, deadlines, and release cleanup. |
| `tests/target-challenge-solver.integration.test.js` | Isolated Chrome fixtures and intercepted monitor E2E paths, not real provider evidence. |
| `tests/target-challenge.test.js` | Contract tests for the seam. Must stay green. |

The monitor calls your solver from exactly one place (`handleChallenge` in `target-watch.js`), and only after a challenge has been positively detected on the live page.

### Where challenges are detected today

1. After `page.goto()` of the product page (`navigateProduct`).
2. After clicking Add to cart / Preorder (`triggerPurchase`).
3. When a replayed availability API call returns a challenge response (`pollAvailability`) — the monitor reloads the PDP first so an interstitial can render, then calls you.
4. When the passive response listener sees a challenged response — deferred to the next poll tick so the solve runs serialized, never concurrently with another action.

---

## 2. The contract you must implement

Create a CommonJS module, e.g. `target-challenge-solver.js`:

```js
/**
 * @param {object} ctx
 * @param {import('patchright').Page} ctx.page  Live authenticated page showing the challenge.
 * @param {{id: string, tcin: string, url: string}|null} ctx.product
 * @param {"press_and_hold"|"generic"} ctx.kind
 * @param {string} ctx.reason      Human-readable trigger description.
 * @param {number} ctx.attempt     1-based attempt number.
 * @param {number} ctx.maxAttempts
 * @param {(message: string) => void} ctx.log
 * @returns {Promise<void>}        Return value is IGNORED. Throw to signal a hard failure.
 */
module.exports = async function solveChallenge(ctx) { /* ... */ };
```

Either `module.exports = fn` or `module.exports = { solveChallenge: fn }` is accepted.

Wire it in by environment variable only:

```powershell
$env:TARGET_CHALLENGE_SOLVER = "./target-challenge-solver.js"
```

### Rules the seam enforces on you

- **Your return value is not trusted.** After each normally completed attempt the monitor waits `TARGET_CHALLENGE_SETTLE_MS` (default 1500) and re-reads the live page title/body/URL plus visible frame bodies. Only a clean page counts as success. A solver that returns `true` on a still-blocked page produces `unresolved` and the monitor backs off. There is a test for this.
- **You get at most `TARGET_CHALLENGE_SOLVE_ATTEMPTS` tries** (default 3). Attempt N+1 starts on whatever page state you left behind — leave the page navigable.
- **Throwing is fine and expected** for transient failures; the driver catches, logs, and retries without the settle/verification step for that attempt. If no later attempt clears the page, any retained exception makes the final outcome `failed`; otherwise a persistent block is `unresolved`.
- **You run serialized.** External entry points enqueue the solve; the post-click entry point runs it inside the already-owned mutation to avoid queue re-entry deadlock. No add-to-cart, click, or other mutation runs while you hold the page. Do not spawn parallel work on other tabs.
- **Never touch the request queue, the backoff ladder, or `monitorState`.** They are not passed to you on purpose.

### What happens after you return

| Driver outcome | Monitor behavior |
|---|---|
| `cleared` | Backoff ladder reset, pause lifted, stale request/availability state discarded. Active mode notifies Discord; observe-only suppresses it. Polling resumes only if no other stop condition is set. Use `TARGET_CHALLENGE_VALIDATE=1` with observe-only to permit challenged-API recovery; default calibration still stops. |
| `unresolved` | Exponential backoff starting at `TARGET_CHALLENGE_BACKOFF_MS` (default 5 min, cap 30 min). |
| `failed` | Same as `unresolved`, with your error message in the pause reason. |
| `unsupported` | No solver configured — current default behavior. |

---

## 3. Solver objective

The challenge is the standard PerimeterX/HUMAN "Quick verification — Press & Hold" interstitial: a button that must be held continuously until its progress indicator completes.

The solver's objective is **fully automatic recovery with no human interaction**. When invoked, it must attempt the configured automated resolution, wait for the resulting navigation/session update, and return control to the monitor. The monitor independently verifies that the challenge disappeared before resuming; an attempted action alone is never success.

The handover deliberately does not prescribe a particular solver implementation. Keep any provider credentials or transient tokens in environment variables, preserve the authenticated Chrome profile, and satisfy the module contract and acceptance tests below.

### Locating the element
The observed interstitial places its actionable iframe inside a closed shadow root, alongside hidden copies. Ordinary CSS/`frameLocator` traversal alone missed it in the live CDP session. `visibleScopes()` now uses the browser-native frame tree when available and checks each frame owner's and ancestor's visibility; a locator-only fallback remains for compatible adapters. Use accessible roles/text matching both `Press & Hold` and `Press and hold`, not rotating generated classes or hardcoded coordinates.

### Test and reproduction URLs

See `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md` for the complete prior incident timelines, confirmed versus inferred trigger evidence, negative-control runs, and the diagnostic evidence required from the next live challenge.

Use the deterministic local fixture for development and automated validation:

```text
file:///F:/Repos/personal/temp/PokemonDeals/tests/fixtures/target-press-and-hold.html
```

The fixture presents `Quick verification` and `Press & Hold`, then clears after an 800 ms pointer hold. It validates detection, solver interaction, and post-solve verification without depending on Target or risking the authenticated session. `target-watch.js` only accepts Target product URLs, so exercise the fixture through a focused solver test or a small test harness rather than passing it to the full product monitor.

The following live paths produced challenge evidence on 2026-09-18, but neither is a stable or deterministic test URL:

1. Preorder discovery used Target search URLs shaped like:

   ```text
   https://www.target.com/s?searchTerm=pokemon%20preorder
   ```

   Rapid sequential navigation across several Target search/category pages produced visible verification. The evidence associates the challenge with the sequence of discovery navigation, not with one guaranteed-trigger URL. Do not repeatedly navigate this URL merely to provoke a challenge.

2. A plain, out-of-browser HTTP client made roughly five sequential requests to the legacy fulfillment endpoint shape:

   ```text
   https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1
   ```

   It then received a confirmed PerimeterX `Press & Hold` page containing `_pxAppId = PXGWPp4wUS`. A usable request also required runtime parameters such as a rotating API key, TCIN, store, ZIP, and location data; therefore the endpoint root above is evidence and request-shape documentation, not a complete reusable test URL. Do not hardcode the observed key or use repeated bare-HTTP requests as a test strategy.

The local fixtures are the only deterministic challenge presentations in this repository. `npm run test:challenge:e2e` covers the original file plus variant fixtures and intercepted HTTPS origins in isolated installed Chrome. It is necessary for repeatable tests, but it is not sufficient for production acceptance.

### Mandatory real-challenge integration test

Before the solver is considered complete, it must be tested against an actual HUMAN/PerimeterX `Press & Hold` challenge—not only the local imitation. Use this order:

1. **Controlled HUMAN test environment (preferred):** follow HUMAN Security's official [Human Challenge integration testing process](https://docs.humansecurity.com/applications/human-challenge-integration-testing-process). In a tenant/environment you control, send the documented `User-Agent: PhantomJS` header to force presentation of the real challenge. Use that tenant's CAPTCHA bypass token through `x-px-captcha-testing` for a repeatable successful test. HUMAN also supports appending `~<milliseconds>` to the testing token to define a 1,000–10,000 ms hold duration for automated validation. These headers and tokens apply only to an authorized HUMAN integration; they cannot be assumed to work on Target.
2. **Natural Target challenge:** run a bounded, single-product, observe-only Target session. If Target naturally presents `Press & Hold`, preserve the page and run the solver against it. Require `TARGET_CHALLENGE_SOLVED` followed by resumed successful `TARGET_API_POLL` output. Do not clear the challenge manually before the solver test.
3. **Do not manufacture the Target challenge by hammering search or Redsky.** The earlier search-navigation sequence and roughly five bare Redsky requests are evidence of prior triggers, not an approved load recipe. Reproducing them deliberately risks the authenticated Target session and does not produce a deterministic test.

There is no verified official public HUMAN challenge URL. A deterministic real-provider test therefore requires a HUMAN environment controlled by the tester; otherwise the Target integration test must wait for a naturally presented challenge.

---

## 4. Definition of done

- [x] `target-challenge-solver.js` exists and satisfies the module contract.
- [x] Unit tests use fake pages, `node:test`, and `node:assert/strict`, without network.
- [x] New modules and tests are registered in `package.json`.
- [x] `npm run check` and `npm run test:unit` pass.
- [x] Isolated browser E2E tests pass with Patchright and the Playwright fallback.
- [x] An isolated real-Target run with observe-only enabled demonstrated `TARGET_CHALLENGE_SOLVED` followed by two fresh HTTP 200 `TARGET_API_POLL` records. Evidence: `screenshots/target-live-retry-refresh-2026-09-18T20-11-28-193Z.json` (45-second attempt budget; no purchase actions).
- [x] `README.md` documents configuration and local/live validation; `SESSION-LEARNINGS.md` records fixture results and the bounded live run.
- [x] Record the real challenge's screenshot/DOM structure, failed attempts, delayed clearance, and subsequent same-run passing retry. See Incident 4 in `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md`. The optional diagnostic refresh-before-second-attempt fallback was not exercised and is not part of the bundled solver.

### Do not
- Do not weaken `detectChallenge` to make runs "look clean."
- Do not remove the post-solve re-verification or the backoff fallback.
- Do not raise poll rates or concurrency (hard caps: 3 products, 1 in-flight request, ≥1.5s cooldown) — high-frequency probing is what triggered this challenge in the first place.

---

## 5. Relevant environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TARGET_CHALLENGE_SOLVER` | unset | Path/name of your solver module. Unset = pause-and-backoff only. |
| `TARGET_CHALLENGE_SOLVE_ATTEMPTS` | `3` | Max solve attempts per challenge. |
| `TARGET_CHALLENGE_SETTLE_MS` | `1500` | Wait before re-verifying each normally completed attempt. |
| `TARGET_CHALLENGE_HOLD_MS` | `10000` | Maximum native hold, 100–15000 ms; release early when the control disappears. |
| `TARGET_CHALLENGE_TIMEOUT_MS` | `20000` | Action budget, 1000–45000 ms and at least hold + 1000; cleanup may add 1500 ms. |
| `TARGET_CHALLENGE_VALIDATE` | unset | Observe-only recovery validation; requires a configured solver. |
| `TARGET_MONITOR_MAX_RUNTIME_MS` | `0` | Optional run limit checked between operations; in-flight work may finish later. |
| `TARGET_MONITOR_KEEP_PAGE` | unset | Preserve diagnostic tabs on normal observe-only exit. |
| `TARGET_CHALLENGE_BACKOFF_MS` | `300000` | Base backoff when the solve does not clear. |
| `TARGET_CHALLENGE_MAX_BACKOFF_MS` | `1800000` | Backoff cap. |
