# Target Purchase Extension Postmortem and Learnings

Date: 2026-09-18  
Status: Retired and uninstalled  
Scope: Target-only Chrome extension for monitoring Pokémon product pages,
adding an available product to cart, and advancing one supervised checkout

## Executive summary

The extension was mechanically successful but operationally unsuccessful.

We built a substantial Manifest V3 Chrome extension with per-tab product
monitors, an independent checkout monitor, a localhost scheduler, durable
state, one-use action authorization, strict cart validation, a popup console,
and an offline test suite. The extension installed, connected to its scheduler,
tracked live Target tabs, and passed its final offline safety reviews.

A separate supervised run was reported by the user to have reached Target order
confirmation. That report established that the flow could work under at least
one set of live conditions, but the confirmation evidence was not preserved in
this archive.

The later multi-product run—the run represented by the browser artifacts in
this archive—did not succeed:

- At the captured popup state, ten product tabs reported
  `monitoring · Unavailable; refreshing.`
- The checkout tab reported
  `blocked · Cart is empty or contains a product that was not armed.`
- A captured live product page visibly contained both `Add to cart` and
  `Buy now`, while the cart still showed zero items.
- All 25 archived console logs contain Target cart-service `429` responses.
- The logs contain 680 recorded `429` lines between approximately 07:29 and
  07:52 UTC. These are recorded log entries, not necessarily 680 unique network
  requests, because captures can overlap.
- No order-confirmation URL or confirmation phrase appears in the archived
  multi-tab run.

The strongest evidence points to request amplification and retailer throttling,
combined with insufficiently realistic pre-live testing and weak live
observability. A five-second fixed cadence across ten independently refreshing
tabs created a theoretical upper bound of 120 product reloads per minute before
accounting for overlapping page loads. Target pages then repeatedly called the
cart service, which returned `429 Too Many Requests`.

The checkout safety model did what it was designed to do: it refused to submit
an empty or unrecognized cart. That was a safety success, but the complete
system still failed its purchasing objective.

## Evidence and confidence

This document distinguishes three evidence levels:

1. **Confirmed from archived artifacts:** source code, test definitions,
   scheduler output, live accessibility snapshots, and console logs.
2. **Confirmed from development-session verification:** the final focused unit
   tests, simulated browser test, syntax checks, and adversarial safety probes
   passed before supervised user testing.
3. **User-reported, not independently preserved here:** one supervised live
   flow reached Target order confirmation.

The archive does not contain enough telemetry to prove whether the failed
multi-tab run stopped primarily because the extension missed the actionable
button, Target rejected the click, the cart request was throttled, or the
extension missed a success signal. The evidence supports a likely failure
chain, not a single conclusively proven cause.

## What we were trying to solve

The prior Playwright/CDP approach had established several hard requirements:

- Keep one persistent browser tab per product URL.
- Avoid generic button searches that can click recommendation controls.
- Do not open checkout until an add-to-cart result is confirmed.
- Preserve the signed-in browser session.
- Keep one checkout owner because all tabs share one cart and payment state.
- Pause for manual CAPTCHA or retailer verification.
- Never claim success without explicit order-confirmation evidence.

The extension was intended to retain those safeguards while removing the
fragility of an external Playwright worker controlling many live pages.

## What we built

### Browser extension

The archived extension is under
[`extension/target-purchase/`](extension/target-purchase/).

Its main components were:

- `background.js`: durable tab assignments, serialized state mutation,
  scheduler connection, action claims, one-use authorization, and tab
  reconciliation.
- `content/product-monitor.js`: product-page evaluation, refresh, guarded
  Add-to-cart or Preorder clicks, cooldown, and verification pause.
- `content/checkout-monitor.js`: cart validation, high-demand handling,
  Save-and-continue handling, exact PIN dialog handling, Place-order guarding,
  and confirmation detection.
- `content/shared.js`: DOM visibility, product-action selection, cart-row
  extraction, product identity, and verification detection.
- `lib/core.js`: pure product and checkout state machines.
- `popup/`: arming, stopping, interval, PIN, scheduler, and per-tab status
  controls.

### Local scheduler

[`scripts/target-extension-scheduler.js`](scripts/target-extension-scheduler.js)
provided a WebSocket tick source on `127.0.0.1:18765`.

The scheduler existed because hidden browser tabs and Manifest V3 service
workers were not considered reliable for an exact five-second JavaScript timer.
It bound only to localhost, required a token and Chrome extension origin,
normalized the configured interval, and emitted heartbeat messages.

The archived output confirms that it started successfully:

```text
TARGET_EXTENSION_SCHEDULER_READY port=18765 intervalMs=5000
```

### State and safety model

Product tabs used phases such as `monitoring`, `action-pending`, `added`,
`cooldown`, `verification`, and `stopped`.

Checkout used `monitoring`, `transitioning`, `placing`, `blocked`,
`verification`, `confirmed`, and `stopped`.

Safety controls included:

- Exact product URL and product-ID binding.
- Duplicate active product-arm rejection.
- One designated checkout tab.
- One-use product and checkout action tokens.
- A fresh DOM and cart check after asynchronous authorization.
- Required visible cart-item count.
- Quantity exactly one.
- Rejection of unknown, duplicate, or unarmed cart rows.
- Target PIN stored only in `chrome.storage.session`.
- Exact `Confirm your PIN` heading matching.
- Manual handling of CAPTCHA and verification.
- A one-shot Place-order latch.
- Explicit confirmation required before declaring success.

## Development and validation sequence

| Stage | Result |
|---|---|
| Design | Defined independent product and checkout roles, fixed cadence, fail-closed cart checks, and manual verification handling. |
| Initial implementation | Core state machines, scheduler, service worker, content scripts, popup, installer, and tests were created. |
| First review | Found checkout races, incomplete cart proof, post-order transition problems, broad PIN matching, confirmation-route gaps, and stale product actions. |
| Hardening | Added one-use authorization, fresh validation, broader fail-closed cart detection, exact URL binding, exact PIN matching, confirmation coverage, cooldown fixes, and scheduler isolation. |
| Final offline review | Reported no remaining Critical or Important issue and judged the code ready for supervised user testing—not unattended production use. |
| Supervised live testing | One flow was user-reported to reach order confirmation. |
| Multi-tab live run | Scheduler and popup worked, but product/cart behavior degraded under sustained live traffic; checkout remained blocked and no archived confirmation was observed. |
| Retirement | Scheduler stopped, extension uninstalled, active project hooks removed, and all artifacts moved here. |

## What worked

### 1. The extension infrastructure worked

The extension loaded in Chrome, the service worker ran, and the popup reported
`Scheduler connected`. The popup snapshot preserved in
[`page-2026-09-18T07-31-44-124Z.yml`](.playwright-mcp/page-2026-09-18T07-31-44-124Z.yml)
shows the scheduler, settings, ten product assignments, and one checkout
assignment.

This rules out a simple installation or scheduler-start failure as the main
cause of the failed multi-tab run.

### 2. Per-product tab ownership worked

Each product had its own persistent tab and durable assignment. This matched
the operational requirement that a single shared round-robin tab was too slow.
The popup could enumerate and report each armed tab independently.

### 3. The safety review process found real defects

The first implementations passed tests while still containing serious
checkout risks. Read-only adversarial reviews found:

- Stale cart validation before Place order.
- Incomplete cart-row accounting.
- Reusable authorization tokens.
- Post-Place-order PIN and high-demand transition failures.
- Overbroad PIN-dialog matching.
- Confirmation-route injection gaps.
- Product actions without fresh revalidation.
- Test isolation gaps.

Those findings were addressed before the final supervised test. This was an
important success: tests alone did not establish safety, but targeted review
and adversarial probes materially improved the implementation.

### 4. Offline state-machine behavior was well covered

The archive contains eight extension test files and seven Target fixtures.
The final offline verification covered:

- Interval normalization.
- Product URL and identity binding.
- Main-product selector scoping.
- Disabled, available, failure, and verification product states.
- Cart completeness and allowlist validation.
- Quantity and duplicate-row rejection.
- One-use action authorization.
- High-demand, PIN, and Place-order transitions.
- Confirmation redirects.
- Popup structure and installation preflight.
- A temporary Chromium profile with intercepted Target fixture pages.

The simulated browser test is preserved at
[`tests/target-extension-browser.test.js`](tests/target-extension-browser.test.js).

### 5. Checkout failed closed

During the failed run, checkout did not guess that the cart was safe. It
reported that the cart was empty or contained an unarmed product and refused
to submit.

That behavior prevented an unintended order when product identity and cart
state were uncertain.

### 6. Verification was designed as manual

The extension paused on CAPTCHA or verification states. It did not contain a
CAPTCHA bypass or simulation path for the live workflow.

### 7. Uninstallation and retirement were clean

The extension was removed from the Chrome remote-debugging profile, its local
extension storage was removed, the scheduler was stopped, the active package
scripts and direct `ws` dependency were removed, and the source was preserved
here.

## What did not work

### 1. The refresh model created a thundering herd

The design gave every unavailable product tab an independent five-second
refresh loop. With ten tabs, that represented up to:

```text
10 tabs × 12 refresh opportunities per minute = 120 refreshes per minute
```

The tabs were driven by the same scheduler, so their work was naturally
synchronized rather than distributed with jitter.

The archived logs contain 680 recorded `429` lines across all 25 console log
files. The affected endpoint was Target's cart service:

```text
https://carts.target.com/web_checkouts/v1/cart
```

The extension did not call this endpoint directly. Reloading Target pages
caused Target's own application to call it. This is an important systems
lesson: browser automation can amplify backend traffic indirectly even when
the automation itself only reloads a page.

The `429` pattern is consistent with self-induced throttling, although the
archive does not prove exclusive causation.

### 2. There was no global request budget or circuit breaker

The design treated each product tab as an independent worker. It had no
cross-tab limit for:

- Concurrent reloads.
- Reloads per minute.
- Cart-service errors.
- Repeated `429` responses.
- High-demand or retailer-degradation signals.

One tab could not tell the other tabs to slow down. The scheduler continued
providing ticks even when Target was clearly rejecting traffic.

### 3. The simulation was too faithful to our assumptions

The simulated browser test intercepted every `https://www.target.com/**`
request and replaced it with small local fixtures. That made the test
deterministic and safe, but it also removed the hardest live variables:

- Target's current production DOM.
- React hydration and delayed controls.
- Real cart API behavior.
- Authentication and profile differences.
- High-demand traffic controls.
- Rate limiting.
- Target's anti-automation systems.
- Branded Chrome behavior versus Playwright Chromium.

The fixtures intentionally used the selectors the extension expected. Passing
them therefore proved internal consistency, not production compatibility.

### 4. Live DOM compatibility remained uncertain

The product monitor required the main action to appear under:

```css
[data-test="module-product-detail-add-to-cart"] button
```

The archived live page snapshot
[`page-2026-09-18T07-32-40-094Z.yml`](.playwright-mcp/page-2026-09-18T07-32-40-094Z.yml)
shows a visible `Add to cart` button and a visible `Buy now` button, with the
cart still at zero items.

The popup snapshot taken shortly before showed all ten product tabs as
unavailable and refreshing. The archive does not reveal whether the extension
later detected and clicked the button, whether the click was rejected, or
whether the cart response was lost to throttling.

The absence of that distinction was itself a major failure.

### 5. Checkout independence could not compensate for an empty cart

The checkout monitor was intentionally independent from product-tab messages.
That avoided a fragile cross-tab signal chain, but checkout still required a
real, recognized cart.

The popup reported:

```text
blocked · Cart is empty or contains a product that was not armed.
```

This was correct safety behavior. It also meant checkout could do nothing when
the product side failed to create a verifiable cart.

### 6. High-demand handling did not solve service degradation

The extension recognized and could dismiss known high-demand dialogs. The
snapshot
[`page-2026-09-18T07-30-03-520Z.yml`](.playwright-mcp/page-2026-09-18T07-30-03-520Z.yml)
shows Target's `High-demand item in your cart` dialog.

Dismissing a modal did not address the underlying cart-service throttling. UI
recovery and backend recovery were treated as the same problem when they were
not.

### 7. Observability was insufficient

The popup reported phases and short messages but did not preserve a structured
event trail showing:

- The selector result on every tick.
- The exact reason a control was considered not ready.
- Claim and authorization timestamps.
- Whether a click actually dispatched.
- The DOM state immediately after a click.
- Cart API status and retry headers.
- Target's add-to-cart response.
- A global reload and error rate.
- Why a success signal was accepted or rejected.

Without those events, the failed live run cannot be reconstructed precisely.
The console captures show Target failures, but not the extension's full
decision history.

### 8. The test rollout scaled too quickly

The system moved from fixture simulation and focused safety reviews to a live
set of ten product tabs. A safer progression would have validated:

1. One live tab in read-only mode.
2. One live tab with supervised refresh.
3. One supervised add-to-cart.
4. Cart identity and quantity.
5. Checkout without order submission.
6. One supervised end-to-end order.
7. Two product tabs with a global rate budget.
8. Gradual scale only while error rates remained acceptable.

The extension had one reported successful supervised path, but that did not
establish that the design would remain stable at ten-tab scale.

### 9. Documentation and completion records drifted

The design document says the tests cover “success-before-failure ordering.”
The final implementation instead makes `successVisible` false whenever a
failure signal is present, and the core state machine evaluates failure before
success. This is conservative, but it does not match the written design.

The implementation plan also retains unchecked task boxes even though the
components were implemented and tested.

The lesson is that design, tests, and operational documentation must be updated
during hardening. The archived design and plan are historical inputs, not an
authoritative description of every final behavior.

### 10. Browser-profile handling added operational ambiguity

The extension was installed in the remote-debugging profile at:

```text
C:\Users\iwsco\AppData\Local\Google\Chrome\User\Default
```

It was not installed in the normal Chrome `User Data` profile. Separate
profiles complicate authentication, debugging, installation verification, and
cleanup. The live run was authenticated, but the profile distinction created
another avoidable source of confusion.

### 11. Readiness language needed tighter scope

The final code review concluded that no Critical or Important code issue
remained and that the extension was ready for **supervised user testing**.

That verdict was appropriate for the reviewed safety invariants. It was not
proof of:

- Live Target compatibility.
- Sustainable multi-tab traffic.
- Successful cart formation.
- Resistance to throttling.
- Unattended purchasing reliability.

The project needed separate readiness labels for code safety, fixture
integration, one-tab live compatibility, and scaled live operation.

## Root-cause analysis

### Why did the multi-tab run fail to purchase?

Because the archived evidence does not show checkout with a verifiable
non-empty cart.

### Why was the cart not verifiable?

Product actions did not produce a durable, recognized cart result in the
archived run. The cart remained at zero in the captured product page, and the
checkout monitor correctly blocked.

### Why did product monitoring become unreliable?

Ten tabs were configured to reload from synchronized five-second ticks while
Target's cart service returned sustained `429` responses.

### Why did the system continue under throttling?

Rate handling existed only inside individual state machines. There was no
global backoff, jitter, concurrency limit, or circuit breaker based on network
health.

### Why did testing not expose this?

The browser integration test replaced Target with local fixtures and manually
triggered behavior ticks. It validated our state machines and selectors against
our own model of Target, not Target's production load and failure behavior.

## Primary and contributing causes

### Most likely primary operational cause

The fixed, synchronized per-tab refresh model most likely generated excessive
aggregate traffic and did not react to retailer throttling.

### Secondary technical cause

The test environment did not reproduce live DOM timing, backend responses,
anti-automation controls, or cart-service behavior.

### Contributing causes

- No global rate budget.
- No random staggering.
- No circuit breaker on `429`.
- No progressive one-tab-to-many-tab rollout.
- Insufficient decision telemetry.
- Dependence on exact live DOM structure.
- An external scheduler added another moving part without solving global load
  coordination.

## What should be preserved

The following ideas remain valuable:

- Pure, testable state-machine functions.
- One persistent tab per product URL.
- One checkout owner.
- Exact product URL and identity binding.
- Fail-closed cart and quantity validation.
- One-use action authorization.
- Fresh validation immediately before a destructive click.
- Session-only checkout PIN storage.
- Manual CAPTCHA and verification handling.
- Explicit order-confirmation requirements.
- Local fixture tests for deterministic regression coverage.
- A user-visible operations console with Stop-all.

## What should not be reused unchanged

- Five-second fixed reloads on every tab.
- Independent per-tab scheduling without a shared load budget.
- Synchronized ticks with no jitter.
- Continuing after repeated `429` responses.
- Treating modal dismissal as backend recovery.
- Declaring live readiness from fixture-only browser tests.
- Scaling directly to ten live tabs.
- Relying on exact production selectors without live canary validation.
- Running automatic checkout when cart identity evidence is incomplete.

## Requirements for any next approach

Any replacement should include these controls before it can be considered for
live use:

1. **Global coordinator:** one process or service owns all refresh and action
   scheduling.
2. **Concurrency limit:** only a small bounded number of tabs may reload or act
   simultaneously.
3. **Jitter:** tabs must not refresh on the same clock edge.
4. **Adaptive backoff:** slow down on network errors, high-demand signals, or
   slow page loads.
5. **Global circuit breaker:** the first sustained `429` pattern pauses every
   product and checkout worker.
6. **Read-before-reload:** inspect the hydrated DOM before deciding that a
   reload is necessary.
7. **Structured event log:** record every decision, selector result, action
   claim, click, cart identity, HTTP failure class, and terminal state.
8. **Live canary stages:** prove one read-only tab, one supervised action, and
   one complete supervised checkout before adding more product tabs.
9. **Separate readiness gates:** code safety, fixture integration, one-tab live
   compatibility, and scaled operation must be approved independently.
10. **Human checkout boundary:** checkout remains supervised and starts only
    after a confirmed cart-add and cart-identity check.

## Suggested abort conditions

A future worker should stop all automation immediately when any of these occur:

- Any `429` response pattern.
- CAPTCHA or verification.
- Cart identity cannot be proven.
- Cart quantity is not exactly one.
- An unknown cart row appears.
- A product action is visible but cannot be classified.
- Repeated reloads do not change the state.
- A high-demand state persists after one bounded recovery attempt.
- More than one checkout owner exists.
- An order action was attempted without explicit confirmation afterward.

## Final conclusion

The project produced useful engineering artifacts and several durable safety
patterns, but the architecture optimized for per-tab speed without controlling
aggregate live traffic.

The extension's internal mechanisms worked: installation, scheduling, state,
popup control, safety claims, and fixture tests. The live multi-tab system did
not work reliably because the retailer environment was not a larger version of
the fixture environment. It had shared backend limits, dynamic DOM behavior,
high-demand controls, and rate limiting that required global coordination.

The most important lesson is:

> One persistent tab per product does not imply one independent high-frequency
> reload loop per product.

Future work should preserve persistent tabs and strict checkout safety, but
centralize scheduling, limit aggregate traffic, stop globally on throttling,
and prove the system incrementally against live behavior.

## Evidence index

- [Archive summary](README.md)
- [Design specification](docs/superpowers/specs/2026-09-18-target-purchase-extension-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-18-target-purchase-extension.md)
- [Manifest](extension/target-purchase/manifest.json)
- [Core state machines](extension/target-purchase/lib/core.js)
- [Background coordinator](extension/target-purchase/background.js)
- [Product monitor](extension/target-purchase/content/product-monitor.js)
- [Checkout monitor](extension/target-purchase/content/checkout-monitor.js)
- [Shared DOM helpers](extension/target-purchase/content/shared.js)
- [Simulated browser test](tests/target-extension-browser.test.js)
- [Scheduler startup output](data/runtime/target-extension-scheduler.out.log)
- [Live popup snapshot](.playwright-mcp/page-2026-09-18T07-31-44-124Z.yml)
- [Live product snapshot](.playwright-mcp/page-2026-09-18T07-32-40-094Z.yml)
- [Live high-demand checkout snapshot](.playwright-mcp/page-2026-09-18T07-30-03-520Z.yml)
- [Live console captures](.playwright-mcp/)
