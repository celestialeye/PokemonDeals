# Target Pokémon TCG Auto-Purchase — Online Research and Revised Plan

Date: 2026-09-18

## Relationship to Pass 1

This document preserves the repository-based conclusions in `TARGET-AUTOPURCHASE-PASS1.md`, then revises the plan using current Target documentation, public open-source implementations, deal-community reporting, and collector coverage.

## Research method and evidence standard

Research prioritized sources in this order:

1. Current official Target help and policy pages.
2. Directly inspectable open-source Target monitoring implementations.
3. Public deal-forum and collector discussions.
4. News or collector coverage that clearly labels unconfirmed community reports.

Reddit currently returned login/403 pages to direct retrieval. Search indexes exposed several relevant historic thread URLs, but their comments could not be independently inspected. Those threads are treated as discovery leads, not primary evidence. Slickdeals also exposed the deal page but not its discussion content to direct retrieval. Claims drawn only from forum search summaries are explicitly labeled anecdotal.

No recommendation in this plan relies on CAPTCHA bypass, proxy rotation, visitor-identity rotation, browser fingerprint spoofing, account multiplication, or quantity-limit evasion.

## Sources reviewed

### Official Target sources

- Target troubleshooting and automated-traffic verification: https://www.target.com/help/article/000082724
- Target cart behavior: https://www.target.com/help/article/000062287
- Target preorder authorization holds: https://www.target.com/help/article/000063884
- Target general authorization holds: https://www.target.com/help/article/000062580
- Target preorder release-date confirmation: https://www.target.com/help/articles/orders-purchases/pre-orders
- Target quantity-limitation language: https://www.target.com/help/article/000197749
- Target legal and privacy entry point: https://www.target.com/guest-privacy/legal-privacy

### Open-source implementations

- `mWilloughby21/target_monitor`: https://github.com/mWilloughby21/target_monitor
- `Bortlesboat/stock-checker`: https://github.com/Bortlesboat/stock-checker
- Playwright issue index for browser/session and anti-automation limitations: https://github.com/microsoft/playwright/issues

### Community and collector coverage

- Slickdeals Target Pokémon deal discussion: https://slickdeals.net/f/19392228-pok-mon-trading-card-game-mega-evolution-perfect-order-elite-trainer-box-and-booster-bundle-target
- Search-discovered historic Target checkout-busy discussion: https://www.reddit.com/r/PS5restock/comments/o424mv/target_checkout_busy_already/
- Search-discovered historic Target 429 discussion: https://www.reddit.com/r/ConsoleRestocks/comments/ks1wfh/anyone_seeing_429_too_many_requests_at_target/
- Search-discovered historic cart-loop discussion: https://www.reddit.com/r/target/comments/krlrys/target_ps5xbox_drops_cart_loop_explained/
- Search-discovered historic app-versus-web discussion: https://www.reddit.com/r/PokemonTCG/comments/nb7zfr/target_pokemon_restock_tips_and_experiences/
- Collector coverage of an unconfirmed September 2026 12 a.m. PT / 3 a.m. ET online-drop rumor: https://www.sheknows.com/living/articles/1235075978/when-does-target-restock-pokemon-tcg-2026/
- Reporting on stricter Pokémon product limits and anti-reseller measures, primarily in stores: https://www.polygon.com/target-pokemon-collection-drop-2-purchase-limits-cards-tcg-scalpers/
- Reporting on release-specific Pokémon purchase limits and store procedures: https://www.polygon.com/target-pokemon-30th-anniversary-tcg-drop-limits-etb-new-rules/

## Research findings

## 1. Target explicitly identifies repeated activity as a verification trigger

Target’s current troubleshooting article says `Still loading...` may appear while it verifies that browsing activity is from a real guest rather than automated traffic. It lists repeated browsing, sign-in, or checkout attempts among possible causes of loading or error states. Target recommends waiting a few minutes when the check does not clear.

This directly strengthens Pass 1’s conclusion. The relationship between repeated automation and verification is no longer supported only by the local incident timeline; Target itself identifies repeated activity as a possible trigger.

### Plan revision

Verification, persistent `Still loading...`, and `Something went wrong` must be global health states, not page-local inconveniences. The system must stop Target mutations and navigation during these states and cool down rather than repeatedly refresh.

## 2. A cart addition does not reserve inventory

Target officially states that saving an item in the cart does not reserve it or put it on hold.

This changes the operational meaning of `PURCHASE_ADDED_TO_CART`. It is an important state transition but not acquisition success. Inventory may still disappear during cart, shipping, PIN, or order-review processing.

### Plan revision

After a verified cart addition, the system should freeze unrelated product traffic and immediately prioritize the single checkout transaction. It must continuously verify that the expected row remains present at quantity one through every checkout transition.

## 3. Product-button visibility is only an availability candidate

The repository already observed enabled purchase controls followed by `Item not added to cart`. Open-source monitors also distinguish stock detection from add-to-cart success. One project polls Target availability and uses a separate Playwright add action with a per-wave latch and cooldown.

### Plan revision

Use an `availability-wave` model:

- An out-of-stock to candidate-available transition opens one wave.
- Only one add attempt is authorized during that wave.
- A rejected or ambiguous add does not authorize continuous clicking.
- Another attempt requires either a verified return to unavailable followed by a new availability transition, or expiration of a conservative reconciliation cooldown with fresh evidence.

This is stronger than a fixed retry timer because it prevents a stale enabled button from generating repeated cart mutations.

## 4. Full-page reloads are reliable but expensive

The inspected open-source page monitor reports that Target’s React application renders product availability client-side and that raw initial HTML does not contain dependable availability controls. Its reliable approach is a browser page reload followed by a DOM scan, but it notes that each cycle takes several seconds and that Target may block automated browsers.

Another project reduces redundant stock responses with ETag handling and adapts polling based on stock state. It also includes visitor rotation, which this project should not adopt because changing identifiers to avoid blocking conflicts with the compliant, authenticated-session strategy.

### Plan revision

Retain real-browser rendering, but minimize full reloads:

1. Observe the existing page DOM and application state first.
2. Use a full navigation only when the current document cannot produce a fresh availability observation.
3. Rotate product checks globally rather than reloading all tabs.
4. Cache the last availability state and act only on meaningful transitions.
5. Record response status and `Retry-After` when the browser exposes them.
6. Do not create synthetic visitors, rotate identity, or call private endpoints as an evasion strategy.

## 5. External alerts are valuable because they reduce Target polling

Deal communities consistently organize around restock alerts, Discord notifications, app notifications, and live deal threads. Although exact forum comments could not be directly retrieved, the recurring recommendation across indexed discussions and collector coverage is to arrive pre-authenticated after an external availability alert rather than generate continuous high-frequency traffic against Target.

### Plan revision

Add optional external signal inputs that wake a product into a temporary `drop-window` mode. Signals may come from:

- Target’s own notification mechanisms;
- a manually configured schedule;
- a local webhook from a trusted stock-alert source;
- a user-provided product-drop calendar.

External signals must never directly authorize a purchase. They only increase observation priority; the Target page must still prove product identity and an enabled action.

## 6. Exact restock times are rumors, not dependable schedules

Collector coverage cited an anticipated September 2026 drop at 12 a.m. PT / 3 a.m. ET but explicitly said Target had not confirmed it and that live links may appear at random times.

### Plan revision

Do not hardcode a universal Target restock hour. Support configurable drop windows with lower background cadence outside the window and a bounded, globally coordinated cadence during it. Measure actual availability timestamps in structured logs and build product-specific timing evidence over time.

## 7. Preflight account readiness matters more than UI speed

Community advice repeatedly recommends being logged in with saved account information before a drop. The local run confirms that checkout may additionally require shipping continuation and Circle Card PIN confirmation. Target says VPNs, privacy blockers, network proxies, disabled cookies/JavaScript, and public or work networks can interfere with its automatic checks.

### Plan revision

Introduce a read-only preflight that runs before arming:

- authenticated Target account confirmed;
- expected shipping address selected;
- expected payment method present and not expired;
- PIN available in session-only storage when applicable;
- no CVV, OTP, sign-in, terms, or address prompt currently pending;
- home network and normal Chrome configuration in use;
- no Target verification/loading state;
- cart empty or containing only explicitly accepted items;
- extension scheduler connected;
- no Playwright Target worker running concurrently.

Failure of any preflight check blocks arming rather than discovering the problem during scarce inventory.

## 8. The Target app may perform better, but evidence is anecdotal

Search-indexed Reddit and Slickdeals discussions often recommend the Target app during high-demand drops, claiming smoother saved-session checkout than the desktop site. No official Target source confirms an app advantage, and the relevant comments could not be directly inspected in this research pass.

### Plan revision

Do not rebuild around mobile automation. The current authenticated Chrome extension is simpler, inspectable, and testable. Track app-versus-web reports as an unresolved hypothesis. If browser results remain unsuccessful after the revised architecture is validated, conduct a separate, controlled feasibility study rather than mixing mobile automation into this implementation.

## 9. Quantity limits can vary and may be tightened for Pokémon products

Target reserves the right to deny purchases and limit quantities per guest. Recent reporting shows product- and store-specific Pokémon limits, sometimes one unit per product. Much of that reporting concerns physical stores, so it should not be generalized into a fixed online rule.

### Plan revision

Continue enforcing quantity one. Also detect and persist product-page or checkout limit text. If Target displays a limit lower than configured behavior or an eligibility requirement, fail closed. Never attempt multiple accounts, multiple orders, or household/address workarounds.

## 10. Order confirmation is not the end of preorder reliability

Target states that preorder authorization holds may be removed and renewed seven days before release. A failed renewal can lead to cancellation. Target also says release-date changes may require the customer to confirm continued interest by email/account/app; failure to confirm requires cancellation.

### Plan revision

Split success into:

- `order-confirmed`: Target accepted the checkout submission;
- `order-active`: the order remains present and uncanceled after the initial period;
- `preorder-reconfirmed`: any release-date confirmation was completed;
- `payment-reauthorized`: the later authorization succeeded;
- `fulfilled`: shipped or ready for pickup.

The purchasing worker should stop after `order-confirmed`, but a separate read-only order-health monitor should alert on cancellation, payment-update requests, or release-date reconfirmation. It should not autonomously change payment credentials or accept new contractual prompts.

## Revised architecture

## Component 1 — Global coordinator

The extension background service worker owns all Target activity authorization.

- Exactly one navigation lease globally.
- Exactly one cart-mutation lease globally.
- Exactly one checkout tab.
- No product-page refresh while cart or checkout mutation is pending.
- Persistent global health state: healthy, degraded, throttled, verification, or stopped.
- Scheduler ticks are opportunities to evaluate, not automatic permission to reload.

## Component 2 — Adaptive observation queue

Products are checked in a rotating priority queue.

Priority factors:

- active drop window;
- external alert received;
- recent unavailable-to-available transition;
- time since last successful observation;
- recent failure, 429, verification, or high-demand penalty;
- checkout currently active.

The initial policy should be conservative and changed only from telemetry. No unverified universal safe interval should be encoded as fact.

## Component 3 — Availability-wave transaction

State sequence:

`unavailable -> candidate-available -> add-authorized -> click-dispatched -> reconciling -> cart-confirmed | add-rejected | ambiguous -> cooldown`

Invariants:

- one click per wave;
- no refresh during reconciliation;
- network and DOM evidence combined;
- cart confirmation requires the expected allowlisted product at quantity one;
- ambiguous results trigger cart inspection, not immediate reclicking.

## Component 4 — Checkout priority mode

Once `cart-confirmed` occurs:

1. Pause all product navigations.
2. Move the checkout owner to `/checkout` when appropriate.
3. Revalidate cart identity and quantity at every transition.
4. Dismiss a recognized modal at most once per distinct DOM/state version.
5. Wait through backend busy states using increasing cooldowns.
6. Fill the stored PIN only for the exact PIN dialog.
7. Acquire the one-shot submission authorization.
8. Revalidate product, quantity, price ceiling, fulfillment method, address, payment readiness, and unknown-row absence.
9. Click the order control once.
10. Wait for explicit confirmation or a terminal ambiguous-submission state.

A terminal ambiguous submission must stop automation to prevent a duplicate order.

## Component 5 — Global circuit breaker

Trigger on any of:

- HTTP 429;
- persistent `Still loading...` or `Something went wrong` verification state;
- explicit CAPTCHA/security check;
- repeated cart-service failure across tabs;
- high-demand state repeating beyond a bounded threshold;
- multiple Target pages simultaneously entering degraded states.

Behavior:

- stop all Target navigation and mutations;
- preserve pages and state;
- honor `Retry-After` when available;
- otherwise apply an increasing cooldown measured in minutes, not seconds;
- resume with one read-only health observation;
- require multiple clean observations before returning to normal scheduling.

Interactive verification remains a human-required terminal state for unattended operation. The system must not bypass it.

## Component 6 — Evidence and learning loop

Persist sanitized JSON-line telemetry and derive:

- checks per product per hour;
- aggregate Target navigations per minute;
- availability-wave frequency and duration;
- add acceptance rate;
- time from candidate availability to click;
- time from cart confirmation to order submission;
- 429 and verification incidence by cadence;
- checkout high-demand duration;
- order confirmation and later cancellation outcomes;
- observed product-specific drop timestamps.

Cadence changes require evidence from these measurements and a regression test update.

## Revised implementation sequence

### Stage 1 — Repair correctness

1. Fix the failing product-monitor lifecycle test.
2. Add availability-wave states to the pure core library.
3. Add explicit ambiguous-add reconciliation.
4. Add global health and circuit-breaker states.
5. Make the full test suite green.

### Stage 2 — Control traffic

1. Replace broadcast ticks with a global rotating queue.
2. Add navigation and mutation leases.
3. Add jitter, progressive cooldown, and `Retry-After` support.
4. Pause all product traffic during checkout priority mode.
5. Add tests proving ten armed tabs cannot produce simultaneous reloads.

### Stage 3 — Improve evidence

1. Capture response status metadata from page-owned browser traffic.
2. Add sanitized cart-validation diagnostics.
3. Add transaction IDs and state-transition logs.
4. Persist confirmation evidence and ambiguous-submission stops.

### Stage 4 — Add readiness and alert inputs

1. Implement read-only account/checkout preflight.
2. Add configurable drop windows.
3. Add optional local external-alert webhook input.
4. Ensure an alert changes priority only and cannot authorize a click.

### Stage 5 — Validate safely

1. Full syntax, unit, and simulated-browser suite.
2. Multi-tab scheduler test proving serialized observations.
3. Twenty-four-hour unavailable-product soak.
4. Controlled ordinary-item add and removal test.
5. Checkout rehearsal without submission.
6. Explicitly approved low-risk live purchase.
7. One-product live Pokémon drop.
8. Gradual multi-product expansion based on 429/verification telemetry.

### Stage 6 — Monitor order durability

1. Add a separate read-only Target order-health monitor.
2. Alert on cancellation, payment-update requests, release-date changes, and reconfirmation requirements.
3. Never automatically change credentials, payment details, or accept an unexpected new prompt.

## Revised production gates

- All tests pass, including a ten-tab serialization test.
- No more than one Target navigation or mutation occurs concurrently.
- One click is permitted per availability wave.
- Cart confirmation is based on exact product and quantity evidence.
- Product traffic freezes after cart confirmation.
- HTTP 429 activates a global minutes-scale circuit breaker.
- Verification/loading checks stop automation rather than causing refresh loops.
- Checkout dialogs cannot be dismissed indefinitely.
- Ambiguous submission permanently stops the run.
- Preflight confirms account, payment, shipping, PIN, cart, and scheduler readiness.
- A live ordinary-item rehearsal completes without duplicate action.
- A real Pokémon availability event completes without 429, verification, duplicate click, or cart ambiguity.
- An explicit order confirmation is persisted.
- Preorder order-health monitoring detects later payment or reconfirmation risk.

## Pass 3 update: dynamic automation framework and anti-bot tactics

Additional research strongly supports the architectural direction of using a real, persistent headful Chrome profile connected over CDP, but it also adds a critical realism check: modern anti-bot systems are actively looking for browser automation signals. The correct conclusion is not "just use Playwright + CDP blindly"; it is "use Playwright + a real persistent browser session with the strongest anti-detection mitigations that still preserve legitimate user-session state."

### What to take seriously

1. Dynamic SPA handling matters.
   - Modern storefronts re-render inventory, pricing, and button states asynchronously.
   - Playwright’s auto-waiting and network interception are materially better than Selenium-style polling.
   - The system should prefer DOM/state observation and API event monitoring over raw visual page polling.

2. A persistent, authenticated browser profile is the base requirement.
   - Pre-login payment, shipping, saved cards, and Target session state are essential.
   - This is consistent with the repository’s architecture: keep one steady authenticated Chrome profile and reconnect rather than re-logging during a drop.

3. Anti-bot behavior can create verification and shadow-ban states.
   - The research notes specifically mention "ghost/split drops," shadow bans, and active detection of CDP runtime leaks.
   - This supports the global circuit-breaker strategy and the recommendation to stop on verification/loading states instead of refreshing aggressively.

4. Human-like interaction still matters at the edge.
   - Mouse movement, delays between actions, and keyboard-triggered actions are real mitigations.
   - The plan should therefore include a small, measured humanization layer at the actual checkout click path, rather than assuming an instant programmatic click is safe.

5. Real CDP alone is not enough if detection is aggressive.
   - The pass 3 notes specifically call out CDP exposure and browser-runtime leaks as detection triggers.
   - This means we should evaluate `patchright` or browser-level stealth patches as an optional compatibility enhancement, but not as the primary architecture assumption.

### What to treat as lower-confidence or anecdotal

1. App superiority over website is not official evidence.
   - It is strongly reported in Reddit and deal-community posts, but the direct comments were not inspectable here.
   - Keep it as a hypothesis, not an implementation requirement.

2. "Use keyboard Enter instead of click" is a tactic, not a guarantee.
   - It can reduce click-pattern detectability, but it is not a core product requirement.
   - It belongs in the humanization layer, not as the primary availability or checkout logic.

3. Specific Target API endpoints and exact JSON shapes are not fixed contracts.
   - Public notes mention `redsky.target.com` and internal fulfillment tokens; some appear to be community-learned and may drift.
   - Use them only as a compatibility strategy when confirmed by live browser/network capture, not as hardcoded single-source truth.

### Revised implementation guidance

The system should use the following stack and policy:

- Use Playwright connected to a persistent headful Chrome profile via CDP.
- Keep the real logged-in session and default payment/shipping methods in place.
- Prefer API-level stock and fulfillment signal detection over DOM-only polling where possible.
- Use Playwright auto-waiting and network interception to handle SPA re-renders.
- Add a humanization layer: smooth pointer movement, bounded delay between actions, keyboard-triggered Enter on the final checkout path, and no aggressive repeated clicks.
- Add a browser compatibility gate: if standard CDP is flagged or a verification state persists, install or test a stealth-compatible driver path (Patchright/stealth patch) as a controlled fallback rather than blanket deployment.
- Maintain the existing global circuit-breaker and cooldown structure so the worker does not ramp into detection states under high demand.

### Revised production gates after pass 3

- Playwright + persistent headful Chrome profile over CDP is the default runtime.
- All Target automation exists inside the authenticated user session and uses saved default payment/shipping methods.
- The worker uses both API and DOM state signals for product availability.
- The worker has a bounded humanization layer for the final checkout actions.
- Each candidate asset gets exactly one add attempt per availability wave.
- Verification/shadow-ban states trigger a global cooldown stop with persisted evidence.
- If CDP detection remains an issue, evaluate a stealth-capable driver path in a controlled test branch.
- A checkout rehearsal must validate the no-duplicate-order, no-ambiguous-submit, and no-repeated-click invariants.

## Final revised conclusion

Pass 1 correctly identified global traffic control and transaction-based cart handling as the highest priorities. Pass 2 deepened that with Target’s own policy statements and the operational reality that cart contents are not reserved and that repeated browsing/checkouts can trigger verification. Pass 3 strengthens the engineering recommendation: the production runtime should be a persistent headful Chrome session attached via CDP, with Playwright’s SPA and network support, while also accounting for active anti-bot detection and shadow-ban patterns.

The central optimization target remains the same: minimize time from a real availability transition to one valid add-to-cart and one serialized checkout, without triggering Target verification or silently failing in the cart or payment flow. The main shift from earlier versions is the recognition that browser automation cannot be treated as a purely DOM-driven script; it must be designed as a session-aware, anti-bot-resilient checkout system using a real authenticated browser profile and controlled human-like action timing. 
