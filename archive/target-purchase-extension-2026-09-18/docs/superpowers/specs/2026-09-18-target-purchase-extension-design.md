# Target Purchase Extension Design

Date: 2026-09-18

## Purpose

Replace the Target Playwright/CDP monitor and checkout workers with one
Manifest V3 Chrome extension that operates inside the user's existing Target
tabs.

The extension has two independent roles:

1. Product tabs refresh until the main product action becomes available, click
   it once, and stop refreshing while the result is evaluated.
2. One manually designated checkout tab independently advances Target checkout
   until an explicit order confirmation or a state requiring human attention.

Product tabs do not trigger or control the checkout tab. Both roles share only
extension configuration, status reporting, and the set of product identifiers
the user explicitly armed.

## Scope

- Target.com only.
- One persistent product tab per armed product URL.
- Exactly one armed checkout tab.
- Default product refresh interval: 5,000 milliseconds.
- Refresh interval configurable from 3,000 through 300,000 milliseconds.
- Add to cart and Preorder are supported in shared-cart mode.
- Buy Now is detected but not clicked in shared-cart mode because it creates a
  second checkout flow in the product tab.
- CAPTCHA and anti-automation verification are detected and paused for manual
  completion.
- Existing Playwright workers remain available but are not run alongside the
  extension.

## Architecture

### Extension package

The unpacked extension lives in `extension/target-purchase/`.

- `manifest.json`: Manifest V3 definition and narrow Target/localhost
  permissions.
- `background.js`: tab registration, durable state, scheduler connection,
  configuration, and tick delivery.
- `content/product-monitor.js`: Target product-page state machine.
- `content/checkout-monitor.js`: Target cart/checkout state machine.
- `content/shared.js`: selector, visibility, product-ID, verification, and
  message helpers.
- `popup/`: controls for arming or stopping the current tab, stopping all
  activity, configuring refresh cadence, and providing an optional session-only
  Target checkout PIN.

### Local scheduler

`scripts/target-extension-scheduler.js` runs a localhost WebSocket server.
It emits a tick at the configured interval. A persistent WebSocket avoids
depending on hidden-page JavaScript timers or Manifest V3 service-worker
timers for the five-second cadence.

The scheduler:

- Does not read browser cookies, credentials, DOM, cart, payment, or product
  information.
- Accepts interval updates only from localhost clients.
- Enforces the same 3,000–300,000 millisecond range as the extension.
- Defaults to 5,000 milliseconds.

The extension reconnects automatically and displays `Scheduler offline` when
the helper is unavailable.

## Product-tab state machine

Each armed product tab has one persisted state:

- `monitoring`: inspect the main product control on each scheduler tick.
- `action-pending`: a purchase control was clicked once; do not refresh or
  click again.
- `added`: explicit cart-add success was detected; remain idle.
- `cooldown`: an explicit failure was detected; resume monitoring after a
  bounded delay.
- `verification`: CAPTCHA or anti-automation verification is visible; perform
  no automated action.
- `stopped`: retain the tab but perform no work.

On every monitoring tick:

1. Detect verification first.
2. Restrict selectors to Target's main product purchase module.
3. If an enabled Add to cart or Preorder control exists, stop refreshing and
   click exactly once.
4. Observe DOM changes for success or explicit failure.
5. Mark `added` on success.
6. Enter cooldown after explicit failure.
7. Refresh only when no actionable product control is present.

A visible Buy Now control produces a `Buy Now requires direct-checkout mode`
status and stops refreshes; it is never clicked by this shared-cart workflow.

## Checkout-tab state machine

The checkout tab never waits for a product-tab message. On every scheduler
tick it evaluates its own URL and DOM:

1. Pause on verification.
2. Detect explicit order confirmation and stop.
3. If Target redirected to the cart, navigate to checkout only when the cart
   visibly contains at least one armed product.
4. Dismiss recognized modal high-demand dialogs.
5. Click Save and continue when enabled.
6. Fill and confirm the Target PIN only when a PIN is present in
   `chrome.storage.session`.
7. Validate that the cart is non-empty and all visible product identifiers are
   among the armed product identifiers.
8. Click Place order or Place your order once.
9. Wait for confirmation, another PIN prompt, or a recognized transient state.

The checkout tab does not refresh while actionable controls, checkout content,
PIN, confirmation, or a known modal are visible. Automatic reload is limited
to explicit transient checkout-busy states and uses the configured interval.

## State and security

- Non-sensitive configuration and tab assignments use `chrome.storage.local`.
- The optional Target checkout PIN is used only when Target displays its exact
  `Confirm your PIN` dialog. It uses `chrome.storage.session` and is cleared
  when Chrome exits.
- Content-script messages are validated by type and sender tab.
- Host access is limited to `https://www.target.com/*` and the localhost
  scheduler endpoint.
- The extension contains no remote code and no credentials.
- Quantity defaults to one. The extension never increases quantity.
- Product actions remain bound to the exact armed URL and product ID.
- Product success and failure signals exclude recommendation and sponsored
  content.
- Order submission requires a non-empty allowlisted cart, quantity exactly
  one for every recognized row, no unknown cart-like rows, and an enabled,
  visible order button.
- The first authorized Place order action creates a one-shot submission latch.
  PIN or high-demand handling after that point cannot authorize a second
  Place order action; the user must explicitly re-arm checkout to start a new
  attempt.

## Popup design

The popup is a compact operations console rather than a dashboard.

- Palette: paper white `#FAFAF8`, ink `#17202A`, Target red `#CC0000`,
  confirmed green `#16794A`, warning amber `#A15C00`.
- Typography: system UI for dependable rendering, with tabular numerals for
  cadence and timestamps.
- Layout: current-tab identity and state first, then one primary arm/stop
  action, checkout controls, cadence, and a short all-tab status list.
- No animation beyond immediate state-color changes.
- Every control is keyboard accessible and has visible focus.

## Testing

### Unit tests

Node tests cover:

- Interval validation and normalization.
- Product and checkout state transitions.
- Main-product selector scoping.
- Success-before-failure ordering.
- Single-click protection.
- Buy Now refusal in shared-cart mode.
- Verification pause.
- Cart allowlist validation.
- Fail-closed handling for unknown cart-row markup.
- Message validation and tab-role persistence.
- Exact product URL binding and one-shot checkout submission.

### Simulated browser tests

A Playwright test launches a temporary Chrome profile with the unpacked
extension and intercepts Target URLs with local fixtures.

It verifies:

- One product tab reloads on scheduler ticks while unavailable.
- Refreshing stops when Add to cart appears.
- The product button is clicked exactly once.
- Explicit add failure enters cooldown.
- Explicit add success marks the tab added.
- One checkout tab independently advances and clicks Place order once.
- A full-page redirect to the confirmation URL is detected on the next tick.
- Unrecognized cart products block submission.
- Verification blocks clicks and refreshes.
- Product and checkout tabs remain open.

The simulated test uses a temporary extension copy and an ephemeral scheduler
port. No simulated test reaches the real Target site, changes the live
scheduler, or submits a real order.

## Installation and operation

1. Install dependencies and run all unit and simulated-browser tests.
2. Register the unpacked extension in the user's existing Chrome profile.
3. Start the localhost scheduler hidden.
4. Verify the extension popup reports `Scheduler connected`.
5. Verify a Target fixture tab can be armed and receives five-second ticks.
6. Leave all real Target tabs unarmed after installation.

The user operates the extension by opening product tabs, arming each as a
product monitor, opening one checkout tab, and arming it as checkout.
