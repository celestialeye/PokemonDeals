# Target Autonomous Purchase Completion Plan

**Status:** Focused Buy-now/checkout slice complete; broader plan items deferred  
**Date:** 2026-09-19  
**Goal:** Finish a single-worker Target purchase system that monitors explicit product URLs and completes exactly one valid order through Preorder, Add to cart, or Buy now with no routine human interaction.

## 1. Read first

Before changing code, read:

1. `README.md` — operational source of truth.
2. `SESSION-LEARNINGS.md` — timing, traffic, challenge, and evidence constraints.
3. `target-watch.js` — monitoring, transaction ownership, queues, and checkout handoff.
4. `target-checkout.js` — shared checkout state machine.
5. `target-products.js` — product/action/cart validation.
6. `TARGET-CHALLENGE-DEVELOPER-GUIDE.md` and `TARGET-CHALLENGE-SOLVER-HANDOVER.md` — solver contract and evidence limits.
7. `tests/target-checkout.test.js` and `tests/target-watch-challenge.test.js` — current regression coverage.

Do not treat archived extension code as the implementation target. It is historical evidence only.

## 2. Current implemented state

The current worker already provides:

- One authenticated Chrome context over CDP.
- One reusable product tab per URL.
- One globally serialized availability-poll queue.
- One serialized mutation queue.
- A hard maximum of three products.
- Canonical Preorder, Add to cart, and Buy now mode enforcement.
- A pre-input in-process purchase owner.
- A blank dedicated checkout tab for cart-based flows.
- Same-product-tab Buy-now checkout.
- Cart mutation/reconciliation observation.
- Shared cart-service 429 backoff starting at one minute.
- Verification detection and an opt-in automated Press & Hold solver.
- Handling for high-demand dialogs, Save and continue, Target PIN, and Place order.
- Shared identity, quantity, fulfillment, item-price, and total validation.
- Explicit order-confirmation URL/text detection.
- Unit and isolated browser tests for challenge and checkout primitives.

The completed focused implementation is:

- Explicit `buy-now=url` selection, while existing bare URLs retain automatic Preorder/Add-to-cart behavior.
- In-process ownership is claimed before purchase input.
- Buy now remains on the original PDP; cart modes require the distinct prepared checkout tab after confirmed cart addition.
- One shared fail-closed validator covers identity, item count, quantity, fulfillment, item price, order total, and configured limits.
- Checkout tracks progress, bounds recovery, stops on unsafe states, and never repeats a potentially accepted Place-order action.
- Post-submit page closure/read failures are terminal ambiguous outcomes; uncertain cart-input outcomes retain their owner until positive no-add evidence or reconciliation.
- Existing authenticated shipping and payment state is consumed; sign-in or payment setup prompts stop fail closed and are not automated.
- `TARGET_STOP_BEFORE_SUBMIT=1` is implemented.
- Deterministic unit coverage is registered in `package.json`.

The implementation has not demonstrated a stop-before-submit authenticated run or a confirmed live order. Offline tests and isolated fixture-browser tests do not prove production purchase success or current Target-selector compatibility.

Per the corrected scope, no process-lock framework, restart journal, independent backoff redesign, broad telemetry layer, or speculative cart recovery architecture was added. Existing monitoring, Preorder/Add-to-cart, challenge, request-queue, cart-handshake, and rate-limit behavior remains in place.

## 2.1 Completion matrix

| Phase | Offline status | Remaining evidence |
|---|---|---|
| 1. Explicit jobs | Focused | Explicit Buy now added; bare cart-mode behavior retained |
| 2. Ownership/lock | Focused | In-process ownership only; no process lock |
| 3. Routing | Complete | Authenticated UI observation |
| 4. Recovery | Focused checkout coverage | Current Target-state compatibility |
| 5. Validation | Complete | Authenticated summary-field availability |
| 6. Challenge integration | Existing behavior preserved | Natural authenticated challenge only |
| 7. Independent backoff | Deferred | Existing shared backoff retained |
| 8. Journal/restart | Deferred | No journal added |
| 9. Observability | Deferred | Existing logs retained |
| 10. Offline validation | Complete after recorded commands below | Live gates remain prohibited here |

## 3. Implemented operating modes

The worker accepts explicit modes:

```powershell
npm run target:watch -- `
  'preorder=https://www.target.com/p/example/-/A-1234567890' `
  'buy-now=https://www.target.com/p/example/-/A-2345678901' `
  'add-to-cart=https://www.target.com/p/example/-/A-3456789012'
```

Mode behavior:

- `preorder`: accept only an enabled `Preorder` control.
- `buy-now`: accept only an enabled `Buy now` control.
- `add-to-cart`: accept only an enabled `Add to cart` control.
- Do not silently switch between explicitly configured purchase modes.
- Bare URLs retain the existing automatic Preorder/Add-to-cart behavior. They never select Buy now; Buy now requires `buy-now=`.
- Multiple configured products must remain inside one worker so they share the transaction lease and request scheduler.

## 4. Phase 1 — Explicit job configuration

### Changes

- Extend argument parsing in `target-watch.js` to parse `mode=url` entries.
- Store the requested mode on each product job separately from the runtime `purchaseMode` transaction state.
- Add canonical mode normalization in `target-products.js`.
- Change `findPurchaseButton()` to accept the requested mode and return only the matching enabled control.
- Reject unknown modes, duplicate products, malformed URLs, and conflicting duplicate entries before opening browser tabs.

### Tests

- Parse all three modes.
- Reject unsupported modes and malformed entries.
- Confirm each mode ignores the other two controls.
- Confirm bare URLs retain deterministic Preorder/Add-to-cart selection and never select Buy now.

### Acceptance

An explicit mode never chooses another control, and Buy now cannot be selected implicitly.

## 5. Phase 2 — Transaction ownership and process locking

**Focused-slice status:** pre-input in-process ownership is implemented. Cross-process locking is deferred by scope correction.

### Changes

- Claim the in-memory purchase owner immediately before dispatching any purchase click.
- Keep all losing product jobs suspended while ownership exists.
- Preserve ownership across challenge and 429 pauses.
- For Buy now, release ownership only when the panel definitively failed to open and the page is safely back at the expected PDP.
- For Preorder/Add-to-cart, do not release ownership after confirmed cart addition unless the transaction is explicitly and safely abandoned.
- Add a local lock scoped to this repository/profile endpoint so a second worker cannot purchase concurrently through the same Chrome profile.
- Remove the lock during orderly shutdown; detect and safely handle a stale lock from a terminated process.

### Tests

- Two products become available on the same tick; only one click occurs.
- A second worker cannot start an active purchasing run while the first owns the lock.
- Ownership survives challenge and rate-limit pauses.
- A Buy-now panel-open failure releases ownership exactly once.
- Confirmed cart ownership is not accidentally released after a transient checkout error.

### Acceptance

At most one product and one process can own a Target purchase transaction.

## 6. Phase 3 — Complete the three transaction paths

### Preorder

1. Poll availability through the shared request queue.
2. Reload/inspect the PDP and require a visible, enabled Preorder control.
3. Claim ownership.
4. Observe the cart handshake while clicking.
5. Handle verification before interpreting success.
6. Reject `Item not added to cart` before any broad cart-success text.
7. Confirm cart success.
8. Navigate the prepared checkout tab immediately.
9. Continue checkout until explicit confirmation or a safety stop.

### Add to cart

Use the same sequence as Preorder, but accept only Add to cart.

### Buy now

1. Confirm the product tab still represents the configured TCIN.
2. Require a visible, enabled Buy now control.
3. Claim ownership before clicking.
4. Click Buy now.
5. Keep all subsequent work in the same product tab.
6. Detect and operate the side panel without navigating to the dedicated checkout tab.
7. Validate the product, quantity, fulfillment, and total shown by the Buy-now flow.
8. Handle verification, high-demand, shipping, PIN, and Place order states.
9. Continue until explicit confirmation or a safety stop.

### Acceptance

Buy now never transfers to the prepared checkout tab. Preorder and Add-to-cart move to the dedicated checkout tab immediately after confirmed cart addition.

## 7. Phase 4 — Checkout state-machine recovery

The current state ordering must remain:

1. shared circuit-breaker check
2. verification
3. explicit confirmation
4. high-demand dialog
5. Save and continue
6. PIN
7. Place order
8. loaded-page wait or bounded recovery

### Changes

- Record the current state, prior state, state-entry time, and last meaningful progress time.
- Add bounded recovery for:
  - Buy-now panel never opening.
  - Buy-now panel opening and later disappearing.
  - Detached, disabled, or replaced controls.
  - Navigation during a click.
  - Shipping or PIN dialogs reappearing.
  - A loaded checkout remaining unchanged indefinitely.
  - Session expiration or a sign-in prompt.
  - Product becoming unavailable during checkout.
  - Empty cart or unexpected cart contents.
- A stalled Buy-now flow may safely return to the expected PDP and retry Buy now only when no order submission may already be in flight.
- After any Place-order click, classify ambiguous outcomes conservatively; never blindly restart the purchase action.
- Keep the approximately 500 ms human-scale wait after high-demand and Place-order actions unless live evidence supports a change.

### Tests

Create deterministic state-machine tests for every transition and recovery path, including repeated dialogs and controls replaced between snapshot and click.

### Acceptance

No state can wait forever without progress, and no recovery can create a second possible order after an ambiguous submission.

## 8. Phase 5 — Purchase validation and financial guardrails

### Changes

Before the first Place-order click, require:

- Expected TCIN/product identity.
- Quantity exactly one.
- No unexpected cart or order-summary items.
- Expected fulfillment method.
- A detected item price and order total.
- Item price and total at or below configured limits.

Add environment variables with fail-closed validation, for example:

- `TARGET_MAX_ITEM_PRICE`
- `TARGET_MAX_ORDER_TOTAL`
- Optional expected fulfillment constraint if Target exposes multiple choices.

Apply equivalent validation to Buy now; the current cart-based path has stronger identity/quantity validation than Buy now.

Do not log PINs, credentials, cookies, full request headers, payment details, or transient session tokens.

### Tests

- Correct product and quantity one succeeds.
- Wrong product, duplicate item, quantity greater than one, missing identity, wrong fulfillment, missing total, or excessive price/total blocks submission.
- Currency parsing handles commas and decimals but fails closed on ambiguity.

### Acceptance

The worker cannot submit an order it cannot positively validate against the configured product and limits.

## 9. Phase 6 — Challenge handling across all transaction states

### Changes

Verify solver integration at:

- Initial PDP navigation.
- Availability-response challenge.
- After Preorder/Add-to-cart.
- After Buy now.
- Inside the Buy-now panel.
- Checkout navigation.
- Shipping, PIN, and Place-order transitions.

After successful resolution:

- Independently verify the challenge cleared.
- Invalidate stale availability/request state.
- Preserve transaction ownership.
- Resume the interrupted transaction state rather than restarting from an unsafe earlier action.

If the page is unreadable or clearance cannot be established, fail closed and retain backoff.

### Tests

Inject a challenge at every state above and verify the exact resume point. Preserve the existing local and isolated-browser challenge suites.

### Acceptance

A solved challenge resumes safely; an unresolved or unreadable challenge cannot authorize another purchase action.

## 10. Phase 7 — Rate-limit policy and recovery

**Focused-slice status:** deferred. Existing shared challenge/cart escalation and pause behavior is preserved.

### Changes

- Keep the current shared one-minute minimum pause for cart-service 429 responses until live evidence supports narrowing it.
- Split challenge and cart-rate-limit backoff counters; they currently share one escalation counter.
- Continue honoring a longer `Retry-After` value.
- Preserve transaction ownership during the pause.
- When the pause expires and a transaction exists, resume that checkout before restarting product monitoring.
- Record endpoint class, status, Retry-After, source tab, transaction state, and elapsed time.
- Do not persist request bodies, cookies, authorization data, or rotating keys.
- Consider endpoint-specific backoff only after bounded telemetry demonstrates that cart reads, mutation/reconciliation, and checkout submission do not share the same throttle behavior.

### Tests

- Challenge failures do not increase the cart-rate-limit ladder.
- Cart 429s do not increase the challenge ladder.
- Concurrent listeners deduplicate one response.
- A longer Retry-After extends the current pause.
- Checkout resumes first after a transaction-scoped pause.

### Acceptance

Rate-limit recovery is conservative, deterministic, and cannot cause product polling to race an owned checkout.

## 11. Phase 8 — Duplicate-order protection and restart recovery

**Focused-slice status:** deferred. No transaction journal or restart framework was added.

### Changes

Add a small local transaction journal containing only non-sensitive fields:

- Product ID.
- Requested mode.
- Transaction start time.
- Last confirmed state.
- Last Place-order attempt time.
- Whether submission outcome is confirmed, failed before submission, or ambiguous.

On startup:

- If the prior transaction is confirmed, do not repurchase it automatically.
- If a Place-order attempt has an ambiguous outcome, do not submit again until Target confirmation/order-history evidence resolves it.
- Permit automatic retry only when evidence proves no submission occurred.

Use atomic file replacement and document journal cleanup/retention behavior.

### Tests

- Process restart before submission resumes safely.
- Process restart after an ambiguous Place-order attempt blocks resubmission.
- Confirmed order prevents duplicate purchase.
- Corrupt or unreadable journal fails closed.

### Acceptance

A crash or restart cannot silently turn one intended purchase into two orders.

## 12. Phase 9 — Observability

**Focused-slice status:** deferred. Existing operational logs plus focused checkout validation/state messages are retained.

Add structured events for:

- Parsed job and requested mode.
- Transaction owner claimed/released.
- Checkout state transitions.
- Cart handshake result.
- Challenge detection, attempt, and verified clearance.
- Rate-limit pause, extension, and resume.
- Purchase-validation result.
- Place-order attempt.
- Confirmation evidence.
- Ambiguous submission or terminal safety stop.

Emit one final sanitized run summary. Capture local screenshots only for unexpected terminal states and ensure no secrets are intentionally recorded.

## 13. Phase 10 — Validation sequence

Run after each focused change:

```powershell
node --check <changed-file.js>
```

Run the complete offline suite before declaring implementation complete:

```powershell
npm run check
npm run test:unit
npm run test:challenge:e2e
```

Then validate in stages:

1. Deterministic local fixtures for all three modes.
2. Real Target observe-only monitoring for explicit mode selection.
3. Add a `TARGET_STOP_BEFORE_SUBMIT=1` safety gate and validate each path through the final ready-to-submit state without clicking Place order.
4. Validate automated recovery if a natural Target challenge appears; do not manufacture one through aggressive traffic.
5. Conduct one explicitly approved, bounded live-order test.
6. Verify explicit order confirmation, journal completion, immediate monitor shutdown, and zero duplicate submissions.

A real purchase is an external financial action. Do not run the final live-order test without the user's specific approval for the product, limits, and purchase attempt.

### 2026-09-19 implementation evidence

The final offline commands completed successfully:

- `npm run check` — exit 0; every registered worker, helper, and mapped test parsed.
- `npm run test:unit` — exit 0; all registered suites passed, including 35 checkout tests and 23 Target-watch tests.
- `npm run test:challenge:e2e` — exit 0; 13/13 isolated Chrome fixture tests passed with Patchright.
- Playwright fallback (`TARGET_BROWSER_DRIVER=playwright`) — exit 0; 13/13 isolated Chrome fixture tests passed, and the prior environment state was restored (`TARGET_BROWSER_DRIVER_RESTORED=True`).

The first Patchright run exposed a synthetic fixture URL that did not contain its expected TCIN after the new PDP identity guard. The intercepted fixture URL was corrected to preserve the expected product identity, and both browser-driver suites then passed. No authenticated/CDP/retailer/Discord action is part of this evidence.

## 14. Documentation updates

Keep these aligned with the final behavior:

- `README.md`: CLI syntax, modes, environment variables, safety gate, process lock, journal, and operating instructions.
- `SESSION-LEARNINGS.md`: state ordering, retry cadence, observed live evidence, unresolved uncertainty, and any policy changes.
- Challenge documentation: only if the solver interface or behavior changes.

Do not claim production reliability from fixtures, unit tests, observe-only runs, or a single successful order.

## 15. Recommended implementation order

1. Explicit job-mode parsing and selector enforcement.
2. Transaction ownership timing and process lock.
3. Buy-now product/summary validation.
4. Price, total, quantity, and fulfillment guards.
5. State progress tracking and bounded recovery.
6. Separate challenge and rate-limit backoff state.
7. Persistent transaction journal and restart behavior.
8. Structured telemetry.
9. Full offline regression suite.
10. Stop-before-submit Target validation.
11. Explicitly approved bounded live-order validation.
12. Final documentation reconciliation.

## 16. Focused-slice definition of done

- Explicit Buy now and optional explicit cart modes pass deterministic tests; bare URLs retain cart-mode compatibility.
- Buy now remains in its original product tab for the complete transaction.
- Preorder and Add-to-cart immediately use the dedicated checkout tab after confirmed cart addition.
- Only one product in the worker can own a transaction.
- Wrong product, quantity, fulfillment, price, or total cannot be submitted.
- Existing challenge, request-queue, cart-handshake, and rate-limit behavior remains unchanged.
- Stalled states recover or stop safely rather than waiting forever.
- An ambiguous Place-order result cannot trigger another submission in the same run.
- The worker exits only after explicit confirmation or a clearly logged terminal safety failure.
- `npm run check`, `npm run test:unit`, and `npm run test:challenge:e2e` pass.
- `README.md` and `SESSION-LEARNINGS.md` accurately describe the final implementation and evidence limits.

## 17. Scope note

The blocked live-preorder-discovery task is not a dependency for this plan. The purchase worker receives explicit Target product URLs. Discovery may be completed separately after Target's challenge clears and a live preorder candidate exists.

## Remaining operator validation

Only separately approved operator work remains for this slice: explicit Buy-now observe-only inspection, one bounded authenticated `TARGET_STOP_BEFORE_SUBMIT=1` run for each checkout path, natural-challenge recovery if encountered without provoking it, and one transaction-bound live purchase approval.
