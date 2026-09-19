# Target Pokémon TCG Auto-Purchase — Pass 1 Findings and Plan

Date: 2026-09-18

## Objective

Automatically purchase explicitly allowlisted, high-demand Pokémon TCG products from Target using the authenticated Chrome profile, quantity one per product, as soon as inventory becomes actionable, without requiring routine human interaction.

The system must never purchase an unknown product, increase quantity, or submit more than one order attempt without a new explicit arming action.

## Evidence reviewed

- `README.md`
- `SESSION-LEARNINGS.md`
- `monitor.js`
- `preorder.js`
- `target-products.js` and `data/target-products.json`
- Target extension source, design, implementation plan, fixtures, and tests
- Preserved Target runtime logs under `data/runtime/`
- Preserved screenshots and their evidence index
- Available Playwright browser-console evidence

## Executive finding

The project can recognize Target product availability controls and can navigate many checkout states, but the preserved evidence does not show a completed autonomous add-to-cart or confirmed Target order.

The primary failure was not inability to find Target buttons. The system repeatedly found purchase controls, but excessive concurrent refreshes and repeated purchase attempts produced failed cart additions, HTTP 429 throttling, high-demand loops, cart redirects, and Target verification. The direct Playwright architecture amplified traffic by operating many product tabs independently while sharing one Target account, cart, browser profile, and network identity.

The newer Chrome extension is the correct architectural direction because it centralizes scheduling and action authorization while preserving one product tab per item and one checkout owner. It is not production-ready yet: the complete test command currently fails in `tests/target-extension-product.test.js` because failure-dismissal refresh behavior is inconsistent between the test and implementation.

Fully unattended purchasing can work only while Target permits the authenticated session to proceed without an interactive verification challenge. The system can reduce the probability of challenges through conservative, coordinated traffic, but it cannot guarantee that Target will never require human verification. CAPTCHA or anti-bot bypass is outside the design.

## What was built

### Direct Playwright workers

- One Target product page per configured product.
- Detection of enabled `Preorder` and `Add to cart` controls inside the main product module.
- Failure-before-success classification for `Item not added to cart`.
- Product-tab reuse, duplicate-tab cleanup, staggered startup, filtering, and reconnect handling.
- A checkout state machine handling `/cart` redirects, high-demand dialogs, inline busy banners, shipping continuation, PIN confirmation, flexible order-button labels, and confirmation detection.
- Product/cart allowlisting and environment-only PIN handling.

### Chrome extension

- Persistent product and checkout tab roles.
- A localhost WebSocket scheduler that avoids hidden-tab timer throttling.
- Durable product phases including monitoring, action-pending, cooldown, added, verification, and stopped.
- Cross-tab claim and authorization messages intended to prevent duplicate actions.
- Exact armed URL/product binding.
- Quantity-one and allowlisted-cart validation.
- A one-shot checkout submission latch.
- Unit tests and simulated browser fixtures.

## What worked

1. Connecting Playwright to the real Chrome profile through CDP preserved the authenticated browser context.
2. Main-product purchase controls were detected reliably enough to generate many `PURCHASE_ACTION_FOUND` events.
3. The code learned to distinguish explicit add failures from misleading cart-related text inside the same dialog.
4. Target checkout variants were catalogued and handled, including multiple high-demand presentations, `Save and continue`, PIN confirmation, and both known order-button labels.
5. Cart validation safely refused at least one unsafe or unrecognized checkout state.
6. The extension’s remaining checkout, popup, installation, and simulated-browser tests pass independently.
7. No evidence indicates an unintended purchase or duplicate confirmed order.

## What failed

### Product monitoring generated too much traffic

Historical product runs accumulated hundreds or thousands of refresh events across many simultaneous tabs. One run recorded 1,776 refresh log events. Another recorded 833. Eleven product pages could refresh and act within a narrow window, multiplying request volume against the same Target session and network identity.

### Purchase controls were not equivalent to obtainable inventory

The workers recorded hundreds of purchase-action detections but no preserved `PURCHASE_ADDED_TO_CART` or `ALL_PURCHASES_ADDED_TO_CART` result. Repeated `ITEM_NOT_ADDED_CLOSED` events show that Target displayed an actionable control while rejecting the cart mutation.

### Repeated actions continued after ambiguous results

When a click did not produce an explicit success signal, the direct worker eventually refreshed and attempted again. During unstable inventory this converted one availability signal into repeated add requests instead of treating the attempt as a transaction requiring reconciliation.

### Target throttled cart traffic

Browser-console evidence contained repeated HTTP 429 responses from Target cart endpoints. The system detected visible high-demand messages but did not have a global 429 circuit breaker. Product and checkout activity could therefore continue across other tabs while the shared Target session was already throttled.

### Checkout entered nonproductive loops

Preserved runs show repeated `/cart` redirects and high-demand dismissal. One checkout run logged 286 high-demand events without reaching `PLACE_ORDER_CLICKED` or `ORDER_CONFIRMED`. Dismissing the same class of dialog repeatedly created more activity without evidence that the checkout session was becoming healthier.

### Cart validation lacked diagnostic evidence

`CART_VALIDATION_FAILED` correctly refused an order, but the logs did not preserve a sanitized explanation of which cart rows, IDs, labels, or counts caused rejection. This prevented distinguishing selector drift from an actually unsafe cart.

### Verification remained a hard stop

The scripts detect conservative verification indicators and pause. The preserved evidence links verification temporally to rapid Target activity, but no screenshot proves the exact provider or challenge type. No autonomous, compliant solution exists in this repository for an interactive challenge.

### The extension test suite is not green

`npm run check` passes. `npm test` currently fails in the product monitor test with `2 !== 1`. The implementation refreshes for `dismiss-failure-refresh`, while the test expects no additional refresh at that point. This lifecycle contract must be resolved before live use.

## What has not been proven

- A confirmed autonomous Target add-to-cart during real scarce inventory.
- A confirmed autonomous Target order.
- Correct operation through every current Target cart and checkout markup variant.
- Reliable cart identity extraction after Target changes page structure.
- A request cadence that is both fast enough for drops and consistently below Target throttling thresholds.
- Fully autonomous recovery from interactive verification.

## Pass 1 improvement plan

### Phase 1 — Make the extension the production baseline

1. Resolve the product failure/cooldown test discrepancy.
2. Require `npm run check` and the complete `npm test` command to pass.
3. Add tests for persistent failure dialogs, delayed cart updates, stale enabled controls, 429 states, redirect loops, and ambiguous click outcomes.
4. Retain Playwright workers only as diagnostic tools. Do not run them alongside the armed extension.

### Phase 2 — Introduce a global Target traffic controller

1. Replace simultaneous per-tab refresh behavior with one rotating global queue.
2. Permit only one navigation or cart-changing action at a time across all Target tabs.
3. Add per-product jitter so requests do not arrive in synchronized bursts.
4. Apply state-specific backoff:
   - ordinary unavailable response: normal interval;
   - explicit add failure: 15–30 second product cooldown;
   - high-demand response: 60–180 second checkout cooldown;
   - HTTP 429: global circuit breaker with progressively longer cooldown;
   - verification: stop all Target mutations until the session is normal again.
5. Require multiple clean page observations before leaving a global throttle cooldown.

The initial cadence should prioritize session survival over maximum raw refresh frequency. It should be tuned from measured 429 and verification outcomes rather than assumptions.

### Phase 3 — Treat add-to-cart as an atomic transaction

1. Detect an enabled action in the main product module.
2. Acquire a global product-action lease.
3. Revalidate URL, product ID, visible label, button state, and verification state.
4. Click exactly once.
5. Stop all refreshes for that tab while the result is unresolved.
6. Wait for explicit success, explicit failure, navigation, cart-count change, network completion, or a bounded timeout.
7. On an ambiguous result, inspect and reconcile the cart before permitting another add attempt.
8. Permanently disarm the product after confirmed cart addition.

### Phase 4 — Harden checkout progression

1. Maintain exactly one warm cart/checkout tab.
2. Validate cart rows using product ID, normalized title, quantity, row count, and the armed catalog.
3. Preserve a sanitized validation report whenever the cart is blocked.
4. Replace blanket reloads with state-specific actions.
5. Add a checkout high-demand circuit breaker rather than repeatedly dismissing the same modal.
6. Preserve one submission authorization across high-demand and PIN transitions.
7. Require explicit confirmation URL or text before reporting success.
8. Stop every armed product and checkout action immediately after confirmation.

### Phase 5 — Add operational telemetry

Write structured JSON-line events containing:

- timestamp and run/session ID;
- product ID and state transition;
- navigation, refresh, and click counts;
- response status category, including 429;
- cooldown reason and duration;
- add-attempt transaction ID and outcome;
- sanitized cart-validation result;
- checkout transition and submission latch state;
- confirmation evidence;
- sanitized screenshot path for unexpected states.

Do not log credentials, PIN values, addresses, payment details, cookies, or transient authenticated URLs.

### Phase 6 — Validate progressively

1. Make all syntax, unit, and simulated-browser tests green.
2. Run a 24-hour unavailable-product soak test and verify no duplicate clicks, runaway refreshes, or unbounded memory/tab growth.
3. Validate controlled add-to-cart behavior using an ordinary Target product without placing an order.
4. With explicit approval, conduct a low-risk end-to-end Target purchase rehearsal.
5. Monitor one Pokémon product during a live availability event.
6. Expand to multiple products only after telemetry shows stable request volume and no 429 escalation.

## Production-readiness gates

- Complete test suite passes.
- One global request/action budget controls every armed tab.
- No duplicate product clicks for one availability event.
- No duplicate order submissions.
- Global cooldown activates on HTTP 429 or widespread high-demand responses.
- Cart identity and quantity are proven before submission.
- Every ambiguous add attempt is reconciled before retry.
- Explicit order confirmation is persisted as evidence.
- At least one controlled live purchase and one real scarce-inventory event complete successfully without human interaction, excluding retailer-imposed interactive verification.

## Pass 1 conclusion

The next improvement should not be a faster polling loop. It should be a coordinated, transaction-based extension that minimizes Target traffic, recognizes session-level throttling, reconciles ambiguous cart actions, and advances checkout through one globally authorized state machine.

The online-research pass should test these assumptions against current user reports and technical observations, especially Target restock timing, app-versus-web behavior, cart reservation behavior, high-demand throttling, practical monitoring cadence, and recent changes to Target account or checkout flows.
