# Target Pokémon TCG Auto-Purchase — Pass 3 Technical Assessment and Final Architecture

Date: 2026-09-18

## Purpose

This pass evaluates the additional Playwright/CDP, network monitoring, Patchright, stealth, Target API, and forum-derived notes against:

- the preserved Target run evidence;
- the existing repository implementation;
- Pass 1 and Pass 2 conclusions;
- current Playwright documentation;
- current Target automated-traffic guidance;
- the inspected Patchright project documentation.

It adopts the additional techniques as implementation hypotheses, contains their operational risk with feature flags and telemetry, and defines the revised implementation architecture.

## Executive decision

Use **one long-lived Node.js Playwright coordinator connected over CDP to the real, headful, authenticated Chrome profile** as the primary Target execution engine.

Do not return to the existing model of separate product and checkout workers. The failure was not Playwright itself; it was uncoordinated multi-tab activity, full-page polling, repeated actions after ambiguous outcomes, and the absence of a session-wide circuit breaker.

The Chrome extension remains useful as a prototype and optional operations UI, but it should not remain the core scheduler/execution engine. Playwright provides stronger network observation, actionability checks, centralized orchestration, tracing, and deterministic control of all product and checkout pages from one process.

Adopt **Patchright, early stealth patches, Target fulfillment API monitoring, and humanized interaction sequencing** as configurable implementation strategies. None is proven or disproven for the observed Target flow, so each must be instrumented independently and retained or removed based on measured checkout success, verification frequency, HTTP 429 incidence, and reliability.

Use a 1.5-second fulfillment polling mode during configured high-priority drop windows, with immediate 429 backoff and a global request budget. Require current DOM, network, and cart evidence before reporting success. CAPTCHA solving, proxy rotation, account multiplication, and purchase-limit evasion remain outside scope.

## Assessment of the additional research notes

## Findings accepted

### 1. Playwright + CDP remains the strongest execution foundation

This matches the repository’s own live evidence. Connecting `playwright-core` to the real Chrome profile on port `9444` preserved the authenticated Target session and avoided foreground accessibility-control interruption.

Playwright officially performs actionability checks before `locator.click()`, including exact-element resolution, visibility, stability, event reception, and enabled state. This is valuable for Target’s React re-renders and transient overlays.

Source: https://playwright.dev/docs/actionability

### 2. A single pre-authenticated headful profile is operationally important

The project already established that:

- cloning the profile did not preserve the Target session reliably;
- enabling CDP after Chrome had started did not work;
- all workers must use the same real authenticated profile;
- login, shipping, payment, and PIN readiness should be validated before a drop.

The correct Windows endpoint remains `http://127.0.0.1:9444`, not the generic examples using port `9222`.

### 3. Network observation is valuable

Playwright officially supports HTTP request/response monitoring, waiting for responses associated with actions, and WebSocket inspection.

Source: https://playwright.dev/docs/network

Network evidence can improve:

- availability-candidate detection;
- HTTP 429 recognition;
- add-to-cart transaction reconciliation;
- cart update confirmation;
- checkout transition diagnosis;
- response timing and error telemetry.

This should complement DOM evidence rather than replace it.

### 4. Full-page refresh should not be the default observation mechanism

The preserved runs prove that synchronized full-page refreshes generated excessive traffic. A page’s own XHR/fetch responses and in-page state changes should be observed first. Navigation should occur only when the document can no longer produce a fresh observation or when the scheduler deliberately refreshes one product under the global request budget.

### 5. One process should serialize the entire Target transaction

The additional notes reinforce Pass 2’s global-coordinator direction. One Playwright process can own:

- all product pages;
- one checkout page;
- network event collection;
- the global request budget;
- product-action leases;
- checkout priority mode;
- the submission latch;
- structured evidence.

This is stronger than independent extension content scripts or multiple Playwright processes competing through one account and cart.

## Findings adopted as measured hypotheses

### 1. Network fulfillment responses may precede usable DOM controls

This is plausible and technically testable, but the exact Target endpoint and response schema must be learned from the authenticated page’s own traffic. An undocumented example endpoint or copied API key must not become a hardcoded production dependency.

Use passive response discovery during normal product-page loading. Record sanitized endpoint categories and candidate fields. Promote a network field into purchasing logic only after repeated correlation with:

- an enabled main-product action;
- an accepted add-to-cart response;
- an exact cart row for the expected product.

### 2. Target may release inventory in small waves

The repository’s repeated appearance and disappearance of actionable controls is consistent with short or inconsistent availability windows. Forum terms such as “ghost drops” or “split drops” are not sufficiently verified to become formal system facts.

The architecture should nevertheless use an availability-wave state machine because it safely handles short, repeated inventory windows without depending on why they occur.

### 3. The Target app may sometimes outperform the website

This remains anecdotal. It does not justify replacing the existing Windows Chrome/CDP architecture with mobile automation. Track it as a future comparative study only if the revised browser implementation remains unsuccessful under controlled conditions.

### 4. Default payment choice may influence checkout latency

A saved Target Circle Card can avoid some payment-selection work for the observed account, but claims that Circle Card or Apple Pay produces a generally higher success rate are not established.

The requirement is payment readiness, not a specific payment product. Apple Pay may introduce OS/device confirmation and is therefore a poor foundation for unattended Windows automation.

## Techniques adopted with measurement controls

### 1. “Playwright + CDP bypasses authentication or 2FA”

Incorrect framing. CDP does not bypass authentication. It reuses an already authenticated browser profile. Any expired session, OTP, security prompt, or sign-in requirement remains a blocking state.

### 2. Standard Playwright versus Patchright detection

The repository does not prove whether Target detected Playwright’s CDP runtime, request behavior, or both. The local runs successfully loaded and operated Target pages, while verification followed high-volume activity. Target also officially lists repeated browsing, sign-in, and checkout attempts as possible automated-traffic triggers.

Source: https://www.target.com/help/article/000082724

Adopt an A/B driver mode. Run equivalent controlled sessions with standard Playwright and Patchright while holding product count, cadence, Chrome profile, and interaction sequence constant. Compare verification frequency, 429 rate, action success, checkout completion, and driver errors. Use Patchright as the initial production candidate, but preserve standard Playwright as the immediate fallback.

### 3. Adopt Patchright as the primary experimental driver

Patchright describes itself as an undetected Playwright fork and changes driver behavior to reduce known CDP and automation signals. Adopt its Node.js package behind a driver adapter so the coordinator can switch between Patchright and standard Playwright without changing state-machine code.

Its known tradeoffs must be engineered around:

- Chromium-only support is acceptable for this Windows Chrome workflow;
- disabled browser console collection requires network, injected application logging, screenshots, and coordinator-side telemetry;
- incomplete Playwright test compatibility requires running the repository’s complete suite against both drivers;
- routing-based init-script injection and upstream-release lag require version pinning and rollback;
- Target-specific benefit must be measured rather than assumed.

Source: https://github.com/Kaliiiiiiiiii-Vinyzu/patchright

Patchright is the first live candidate. Standard Playwright remains the fallback driver if Patchright causes regressions or fails to improve outcomes.

### 4. Adopt in-browser fulfillment polling during drop windows

**Revised 2026-09-18 after direct measurement.** A plain out-of-browser HTTP client polling `redsky.target.com` was served a PerimeterX `Press & Hold` block page (`_pxAppId = PXGWPp4wUS`) after roughly five sequential requests. Standalone `fetch`/`curl` polling is therefore not viable at any useful cadence.

All fulfillment polling must execute **inside the authenticated Patchright/Playwright page context** so requests carry the established PerimeterX cookie, browser fingerprint, TLS characteristics, and Target session. Use `page.request` or an in-page `fetch` originating from a live Target tab.

Verified endpoint generations are:

- Current live PDP path observed on 2026-09-18: `POST www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules` with a page-generated JSON body. The `ProductDetailWebDatasourceFulfillmentAndVariations` response contains the monitored product's fulfillment state.
- Legacy path verified earlier the same day: `GET redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1` for availability/fulfillment and `GET .../pdp_client_v1` for product details and eligibility.

The worker must capture and replay the complete page-owned request template rather than construct a fixed GET. Current CDUI requests include a rotating `key`, location/session query parameters, and an opaque page-context POST body. Legacy Redsky parameters include `key`, `tcin`, `store_id`, `zip`, `state`, `latitude`, `longitude`, and the `required_store_id`/`has_required_store_id` pair. Aggregation names are versioned and retired; endpoint disappearance, HTTP 405, or 410 must trigger rediscovery rather than be interpreted as product availability.

Begin with one globally scheduled request every 1.5 seconds, rotating across prioritized products rather than independently polling every product every 1.5 seconds. This provides fast aggregate detection without immediately producing approximately 440 requests per minute across eleven products.

Capture response status, latency, ETag, relevant fulfillment fields, and `Retry-After`. Treat an HTML response body, a `Press & Hold` string, or a `_pxAppId` marker as a challenge event with the same severity as HTTP 429. On the first 403, 429, challenge body, malformed response, or verification correlation, stop direct polling and fall back to passive page network observation with progressive cooldown.

Add an explicit configuration switch for per-product 1.5-second polling so it can be tested later if the global strategy is too slow and telemetry shows sufficient headroom.

### 5. Adopt network-first immediate purchase triggering

When the monitored fulfillment response changes to the configured purchasable state, immediately elevate that product, navigate or activate its prepared page, and begin the add transaction without waiting for the next scheduler cycle.

A backend signal still does not prove the add will succeed or reserve inventory. Target officially states that cart contents are not reserved, and the local runs showed enabled controls followed by `Item not added to cart`.

Source: https://www.target.com/help/article/000062287

Therefore the network transition authorizes immediate DOM revalidation and one add attempt—not an assumption of success. Measure network-signal-to-click latency as a primary performance metric.

### 6. Adopt humanized interaction sequencing

Add a configurable interaction strategy that:

- moves or hovers over the final resolved control;
- waits a randomized 150–400 milliseconds;
- uses ordinary Playwright click for product actions;
- tests focused keyboard `Enter` for checkout transitions where the control supports keyboard activation;
- preserves Playwright’s actionability checks;
- never uses forced clicks unless a specific tested state requires them.

No current evidence proves that Target treats these event paths differently, so log the strategy used for every action and compare success, verification, and latency against direct locator clicks. Retain the strategy if it improves results without increasing stale-element or timing failures.

### 7. Adopt Patchright’s built-in stealth behavior and controlled early patches

Use Patchright’s patched driver and default Chromium argument changes as the initial stealth layer. Add only narrowly scoped early scripts required by the selected driver integration, version them explicitly, and test them against the local Target fixtures and live read-only pages.

Do not stack unrelated stealth plugins blindly. Every patch must have a named detection hypothesis, an on/off feature flag, telemetry, and a rollback path. Interactive CAPTCHA solving, proxy rotation, account multiplication, and purchase-limit evasion remain excluded.

### 8. Adopt frame-safe checkout handling when frames appear

Implement reusable frame discovery and `frameLocator()` helpers for payment or wallet controls that Target may embed. Prefer the already saved payment method and observed Target PIN flow, but do not let an unexpected iframe cause the state machine to stall.

Credentials, card numbers, CVV values, OTPs, and passwords must never be hardcoded. Any required sensitive values remain in the authenticated browser or approved session-only input.

## Final recommended architecture

## 1. One Playwright Target coordinator

Create a single CommonJS Node.js process, tentatively `target-coordinator.js`, behind a browser-driver adapter. Patchright is the primary driver and the existing `playwright-core` runtime is the fallback. Pin both versions and expose the driver choice through configuration.

Responsibilities:

- connect once to `http://127.0.0.1:9444`;
- use the first existing browser context;
- acquire or create one page per configured product;
- acquire or create exactly one cart/checkout page;
- register network listeners before monitoring begins;
- run one global scheduler and state store;
- own every navigation, cart mutation, and checkout action;
- stop all activity after confirmation or terminal ambiguity.

No separate `target:preorder` and `target:checkout` processes should run during coordinated operation.

## 2. Hybrid network-and-DOM product observation

Each product observation produces a combined snapshot:

- exact configured product ID and URL;
- title/identity match;
- main-product action label and readiness;
- visible unavailable/failure/success state;
- verification/loading state;
- most recent relevant page-owned fulfillment response;
- response timestamp and status;
- cart badge or cart-response change;
- current availability-wave ID.

Direct fulfillment polling and page-owned network responses are primary speed signals. A purchasable network transition immediately activates the product transaction. The click still requires a freshly resolved, visible, stable, enabled main-product control for the exact product.

If the network schema is unavailable or changes, the system falls back to passive page network observation and conservative DOM monitoring. Schema drift must not authorize a guessed purchase.

## 3. Global observation scheduler

The coordinator maintains one priority queue across all products.

Rules:

- only one product may navigate or refresh at a time;
- passive DOM and network evaluation may occur without navigation;
- no synchronized broadcast refresh;
- jitter prevents fixed bursts;
- drop windows and external alerts affect priority, not purchase authorization;
- checkout priority suspends product navigation;
- cooldowns are based on observed state and session health.

During configured drop windows, start with one globally rotated fulfillment request every 1.5 seconds and immediate event-driven escalation when stock changes. Outside drop windows, use a slower adaptive cadence. Feature-flag a more aggressive per-product 1.5-second mode for measured trials. Tune or roll back from telemetry, especially 403, 429, verification, and malformed-response rates.

## 4. Availability-wave state machine

Per product:

`unavailable -> candidate-available -> action-claimed -> click-dispatched -> reconciling -> cart-confirmed | add-rejected | ambiguous -> cooldown`

Invariants:

- one click per availability wave;
- no product refresh during reconciliation;
- stale buttons cannot authorize repeated clicks;
- explicit failure is handled before generic cart text;
- ambiguous results cause cart reconciliation;
- a new click requires a new wave or deliberate recovery rule backed by fresh evidence.

## 5. Add-to-cart network reconciliation

Before clicking, arm response listeners for relevant Target cart mutations.

After clicking, classify using multiple signals:

- cart request status;
- cart response outcome when safely inspectable;
- `Item not added to cart` or equivalent failure;
- exact expected cart row at quantity one;
- cart badge/count change;
- navigation or modal state;
- verification or 429 response.

`cart-confirmed` requires exact expected-product evidence. A successful HTTP response alone is insufficient.

## 6. Checkout priority transaction

When one product reaches `cart-confirmed`:

1. Pause every product navigation and mutation.
2. Activate the single checkout page.
3. Revalidate the cart at each state transition.
4. Handle `/cart`, shipping continuation, known high-demand states, PIN, and order review.
5. Arm response listeners before every checkout action.
6. Dismiss each distinct modal state at most once before backing off.
7. Acquire the one-shot submission latch.
8. Revalidate product ID/title, quantity one, configured price ceiling, order-total ceiling, fulfillment method, address readiness, payment readiness, and unknown-row absence.
9. Click `Place order` or `Place your order` once.
10. Wait for explicit confirmation or terminal ambiguity.

Terminal ambiguity stops all automation because repeating the submission could create a duplicate order.

## 7. Session-wide circuit breaker

Trigger when any page or relevant response indicates:

- HTTP 429;
- automated-traffic `Still loading...` or persistent `Something went wrong`;
- CAPTCHA, security check, access denied, or verification;
- repeated cart-service failure;
- high-demand state exceeding a bounded threshold;
- multiple product pages degrading together.

Behavior:

- stop all Target navigations and mutations;
- preserve pages and transaction state;
- honor `Retry-After` when exposed;
- otherwise use increasing minutes-scale cooldowns;
- resume with one read-only health observation;
- require multiple clean observations before normal operation.

An interactive challenge remains a human-required terminal condition. The coordinator must not solve, simulate, refresh through, or bypass it.

## 8. Preflight and readiness

Before arming:

- CDP endpoint healthy on port `9444`;
- one authenticated Target session;
- no verification/loading state;
- correct configured product catalog;
- cart empty or explicitly approved and allowlisted;
- shipping address ready;
- payment method ready and unexpired;
- session-only PIN available when required;
- no OTP, CVV, sign-in, terms, or account prompt pending;
- no competing Target worker or armed extension;
- evidence directory writable;
- emergency stop available.

## 9. Structured evidence

Persist sanitized JSON-line events for:

- scheduler decisions;
- product snapshots and availability waves;
- network endpoint category, status, timing, and `Retry-After`;
- action claim and authorization;
- click dispatch;
- cart reconciliation;
- checkout transitions;
- circuit-breaker activation;
- submission latch;
- confirmation evidence;
- later preorder order-health state.

Do not store cookies, authorization headers, API keys copied from page traffic, PIN values, addresses, payment details, or sensitive response bodies.

## Implementation plan

### Phase 1 — Repair the current baseline

1. Resolve the existing product-monitor test failure.
2. Preserve all passing extension tests as reusable state-machine coverage.
3. Add explicit availability-wave and ambiguous-add test cases.
4. Document the extension as prototype/optional operations UI rather than the production engine.

### Phase 2 — Build the coordinator core

1. Add a pure coordinator state library.
2. Add the global priority scheduler and leases.
3. Add product/checkout page acquisition and duplicate cleanup.
4. Add session-wide health and circuit-breaker state.
5. Add graceful reconnect without recreating all tabs unnecessarily.

### Phase 3 — Add active and passive network intelligence

1. Instrument response/request listeners on normal Target pages.
2. Discover the current fulfillment endpoint, key, and schema from page-owned traffic at runtime.
3. Implement the global 1.5-second rotating `fast-api` monitor for configured drop windows.
4. Add the feature-flagged per-product 1.5-second trial mode.
5. Capture ETag, 403, 429, response latency, malformed payloads, and `Retry-After` immediately.
6. Trigger immediate product activation on a configured purchasable transition.
7. Correlate fulfillment candidates with DOM action, cart mutation, and checkout success in logs.
8. Fall back automatically to passive network and DOM monitoring when the direct strategy degrades.

### Phase 4 — Implement transactional, humanized product actions

1. Add one action lease per availability wave.
2. Revalidate the exact product and button immediately before click.
3. Arm cart-response listeners before the action.
4. Apply the configured hover/movement and randomized 150–400 millisecond reaction delay.
5. Execute the product action and record the interaction strategy.
6. Reconcile response, DOM, and cart identity.
7. Prevent all immediate reclicks after rejection or ambiguity.
8. A/B test direct locator clicks against the humanized strategy.

### Phase 5 — Integrate checkout

1. Port the proven checkout ordering from `monitor.js` into the coordinator.
2. Add checkout action-response correlation.
3. Add bounded high-demand handling.
4. Add strict cart, quantity, price, total, fulfillment, address, and payment guards.
5. Add keyboard-activation trials for eligible checkout controls.
6. Add frame-safe discovery for embedded payment or wallet controls.
7. Add one-shot submission and terminal-ambiguity handling.

### Phase 6 — Validate

1. Run `npm run check` and all existing tests.
2. Add coordinator unit tests.
3. Add browser fixtures for network candidate, cart acceptance, rejection, 429, stale button, verification, high demand, PIN, confirmation, and ambiguous submission.
4. Run a multi-product soak proving serialized navigation.
5. Run a controlled ordinary-item add/remove rehearsal.
6. Run checkout to the final review state without submission.
7. Conduct an explicitly approved low-risk live purchase.
8. Test one Pokémon product during a real availability event.
9. Expand product count only when telemetry shows no 429 or verification escalation.

## Production gates

- Patchright is integrated behind a driver adapter with standard `playwright-core` fallback.
- Both driver modes pass the applicable automated suite.
- Driver, stealth patch, interaction strategy, and API-monitor mode are independently feature-flagged.
- One process owns all Target pages and state.
- One navigation and one mutation maximum at any instant.
- The global 1.5-second fulfillment monitor has immediate 403/429 fallback and circuit breaking.
- Per-product 1.5-second polling is enabled only as a measured trial mode.
- CAPTCHA solving, proxy rotation, account multiplication, and purchase-limit evasion remain excluded.
- One click per availability wave.
- Exact cart row and quantity-one confirmation before checkout.
- Product traffic freezes during checkout.
- First 429 activates the global circuit breaker.
- Repeated dialogs cannot create infinite action loops.
- One-shot order submission.
- Terminal ambiguity stops the run.
- Full automated test suite passes.
- Controlled live validation succeeds before scarce-inventory deployment.

## Pass 3 conclusion

The additional techniques are adopted because the available evidence neither proves nor disproves their Target-specific effectiveness. The implementation will test them directly rather than excluding them in advance.

The final direction is a **single Patchright-first Playwright/CDP coordinator with active 1.5-second fulfillment monitoring, passive page-network intelligence, humanized interaction sequencing, frame-safe checkout handling, DOM confirmation, availability-wave locking, globally serialized mutations, transaction reconciliation, strict checkout guards, and a session-wide circuit breaker**.

Every uncertain technique is isolated behind a feature flag and evaluated from measured purchase success, latency, verification, 429, and reliability data. If a technique fails, it can be disabled without redesigning the coordinator.
