# Target Purchase Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, simulate, and install a Target-only Chrome extension with one independently operating product monitor per armed tab and one independently operating checkout tab.

**Architecture:** A Manifest V3 extension injects separate product and checkout state machines into Target pages. A localhost WebSocket scheduler supplies configurable five-second ticks so hidden tabs do not depend on throttled page timers or ephemeral service-worker timers.

**Tech Stack:** Node.js CommonJS, Chrome Manifest V3, browser JavaScript, `ws`, `playwright-core`, Node test runner scripts.

**Spec:** `docs/superpowers/specs/2026-09-18-target-purchase-extension-design.md`

## Global Constraints

- Target.com only.
- One persistent product tab per armed product URL.
- Exactly one manually armed checkout tab.
- Refresh defaults to 5,000 ms and is configurable from 3,000–300,000 ms.
- Product and checkout roles do not require runtime messages from one another.
- Add to cart and Preorder are clicked once; Buy Now is not clicked in shared-cart mode.
- Verification challenges pause automation.
- Checkout requires a non-empty allowlisted cart and explicit confirmation.
- Real Target pages remain unarmed during simulated testing and after installation.
- This working copy has no Git metadata; use verification checkpoints rather than commits.

---

### Task 1: Shared state and validation library

**Files:**
- Create: `extension/target-purchase/lib/core.js`
- Create: `tests/target-extension-core.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `normalizeInterval(value) -> number`
- Produces: `getProductId(url) -> string|null`
- Produces: `classifyProductPage(snapshot, state, now) -> decision`
- Produces: `classifyCheckoutPage(snapshot, state) -> decision`
- Produces: `validateCheckoutProducts(visibleIds, armedIds) -> boolean`
- Produces: browser global `TargetPurchaseCore` and CommonJS exports

- [ ] **Step 1: Write failing interval and URL tests**

Test default `5000`, minimum `3000`, maximum `300000`, invalid fallback, and
Target `/p/-/A-1234567890` product-ID extraction.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/target-extension-core.test.js`

Expected: failure because `extension/target-purchase/lib/core.js` does not
exist.

- [ ] **Step 3: Implement interval normalization and product-ID extraction**

Expose the same functions through `module.exports` and
`globalThis.TargetPurchaseCore`.

- [ ] **Step 4: Add failing state-machine tests**

Cover:

- Verification takes priority over every action.
- `monitoring` plus enabled Add to cart produces `click-product`.
- `monitoring` plus enabled Preorder produces `click-product`.
- Buy Now produces `pause-buy-now`.
- No action produces `refresh`.
- `action-pending` never produces another click or refresh.
- Explicit failure produces `cooldown`.
- Explicit success produces `added`.
- Checkout confirmation produces `confirmed`.
- Unknown cart identifiers produce `blocked-cart`.
- Enabled Place your order with an allowlisted cart produces `place-order`.

- [ ] **Step 5: Run focused tests and verify RED**

Run: `node tests/target-extension-core.test.js`

Expected: assertions fail because classification functions are absent.

- [ ] **Step 6: Implement the minimal pure state machines**

Keep DOM access out of this file. Inputs and outputs must be serializable plain
objects so unit tests and content scripts use the same logic.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `node tests/target-extension-core.test.js`

Expected: `target-extension-core tests passed`.

- [ ] **Step 8: Add the focused test to `npm test`**

Append `node tests/target-extension-core.test.js` to the existing command.

### Task 2: Configurable localhost scheduler

**Files:**
- Create: `scripts/target-extension-scheduler.js`
- Create: `tests/target-extension-scheduler.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: interval rules from Task 1.
- Produces: `createSchedulerServer({ port, intervalMs })`
- WebSocket messages emitted: `{ "type": "tick", "at": <epoch-ms> }`
- WebSocket messages accepted: `{ "type": "configure", "intervalMs": number }`

- [ ] **Step 1: Install the WebSocket dependency**

Run: `npm install ws`

- [ ] **Step 2: Write failing scheduler tests**

Use an ephemeral port and assert that:

- A client receives ticks.
- Default cadence configuration is `5000`.
- A valid configure message changes the interval.
- Values below `3000` or above `300000` are normalized.
- Malformed messages do not stop the server.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node tests/target-extension-scheduler.test.js`

Expected: module-not-found failure.

- [ ] **Step 4: Implement the scheduler**

Bind only to `127.0.0.1`. Export the factory for tests and run on port `18765`
when invoked directly.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node tests/target-extension-scheduler.test.js`

Expected: `target-extension-scheduler tests passed`.

- [ ] **Step 6: Add scheduler scripts**

Add:

```json
"target-extension:scheduler": "node scripts/target-extension-scheduler.js"
```

Append the scheduler test to `npm test` and the scheduler file to `npm run
check`.

### Task 3: Manifest V3 background coordinator

**Files:**
- Create: `extension/target-purchase/manifest.json`
- Create: `extension/target-purchase/background.js`
- Create: `tests/target-extension-background.test.js`

**Interfaces:**
- Consumes: `TargetPurchaseCore.normalizeInterval`
- Produces messages:
  - `TARGET_PURCHASE_TICK`
  - `TARGET_PURCHASE_STATE`
  - `TARGET_PURCHASE_CONFIG`
- Accepts popup/content messages:
  - `GET_STATUS`
  - `ARM_PRODUCT`
  - `ARM_CHECKOUT`
  - `STOP_TAB`
  - `STOP_ALL`
  - `SET_INTERVAL`
  - `SET_TARGET_CHECKOUT_PIN`
  - `REPORT_STATE`
  - `RUN_TICK_NOW`

- [ ] **Step 1: Write failing background state tests**

Test pure helpers for:

- Arming the current product tab with URL and product ID.
- Replacing the prior checkout tab when another is armed.
- Stopping one tab without closing it.
- Stopping all tabs without closing them.
- Removing state when Chrome reports a tab closed.
- Rejecting malformed messages.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/target-extension-background.test.js`

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement manifest and coordinator**

Manifest permissions:

- `storage`
- `tabs`
- `activeTab`
- Host access for `https://www.target.com/*`
- Host access for `ws://127.0.0.1/*`

The service worker connects to `ws://127.0.0.1:18765`, persists tab roles in
`chrome.storage.local`, stores PIN in `chrome.storage.session`, and broadcasts
each tick only to armed tabs.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node tests/target-extension-background.test.js`

Expected: `target-extension-background tests passed`.

### Task 4: Product-tab monitor

**Files:**
- Create: `extension/target-purchase/content/shared.js`
- Create: `extension/target-purchase/content/product-monitor.js`
- Create: `tests/target-extension-product.test.js`

**Interfaces:**
- Consumes: `TargetPurchaseCore.classifyProductPage`
- Produces snapshot:
  - `verificationVisible`
  - `successVisible`
  - `failureVisible`
  - `actionLabel`
  - `actionReady`
- Reports product states through `REPORT_STATE`

- [ ] **Step 1: Write failing selector and transition tests**

Use minimal fake DOM adapters to verify:

- Recommendation-card buttons are ignored.
- Main Add to cart and Preorder buttons are selected.
- Disabled controls are not clicked.
- Buy Now pauses without clicking or refreshing.
- Action pending blocks duplicate clicks.
- Failure is evaluated before generic cart links.
- Success stops future refreshes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/target-extension-product.test.js`

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement shared DOM helpers and product state machine**

Use `[data-test="module-product-detail-add-to-cart"]` as the primary scope.
After clicking once, attach a `MutationObserver` and maintain the persisted
`action-pending` state across page changes. Call `location.reload()` only for
the `refresh` decision.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node tests/target-extension-product.test.js`

Expected: `target-extension-product tests passed`.

### Task 5: Checkout-tab monitor

**Files:**
- Create: `extension/target-purchase/content/checkout-monitor.js`
- Create: `tests/target-extension-checkout.test.js`

**Interfaces:**
- Consumes: `TargetPurchaseCore.classifyCheckoutPage`
- Reads armed product IDs through `GET_STATUS`
- Requests the Target checkout PIN through `GET_TARGET_CHECKOUT_PIN`
- Reports checkout states through `REPORT_STATE`

- [ ] **Step 1: Write failing checkout tests**

Cover:

- Empty cart remains idle.
- `/cart` with an armed product navigates to `/checkout`.
- Unrecognized products block checkout.
- Verification blocks all actions.
- Modal OK is preferred over refresh.
- Save and continue is clicked when ready.
- PIN is filled only from session storage.
- Place order is clicked once.
- Confirmation disarms checkout automation.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/target-extension-checkout.test.js`

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement checkout monitor**

Evaluate the DOM on scheduler ticks and mutation events. Never depend on a
product-tab message. Maintain a local pending-action guard so every control is
clicked at most once until the DOM changes.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node tests/target-extension-checkout.test.js`

Expected: `target-extension-checkout tests passed`.

### Task 6: Popup operations console

**Files:**
- Create: `extension/target-purchase/popup/popup.html`
- Create: `extension/target-purchase/popup/popup.css`
- Create: `extension/target-purchase/popup/popup.js`
- Create: `tests/target-extension-popup.test.js`

**Interfaces:**
- Consumes background message contract from Task 3.
- Provides controls:
  - `Arm product tab`
  - `Arm checkout tab`
  - `Stop this tab`
  - `Stop all`
  - configurable refresh interval
  - session-only Target checkout PIN
  - `Run now`

- [ ] **Step 1: Write failing static popup tests**

Assert required control IDs, accessible labels, sentence-case copy, configured
palette tokens, keyboard focus styling, and no remote assets.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/target-extension-popup.test.js`

Expected: missing-file failure.

- [ ] **Step 3: Implement the popup**

Use the palette and layout from the design spec. Keep the interface under
360 px wide and display scheduler state plus current-tab status before controls.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node tests/target-extension-popup.test.js`

Expected: `target-extension-popup tests passed`.

### Task 7: Simulated Chrome integration tests

**Files:**
- Create: `tests/fixtures/target-product-unavailable.html`
- Create: `tests/fixtures/target-product-available.html`
- Create: `tests/fixtures/target-product-failure.html`
- Create: `tests/fixtures/target-checkout.html`
- Create: `tests/fixtures/target-checkout-blocked.html`
- Create: `tests/fixtures/target-confirmation.html`
- Create: `tests/target-extension-browser.test.js`
- Modify: `package.json`

**Interfaces:**
- Launches installed Chrome executable with a temporary profile.
- Loads `extension/target-purchase` unpacked.
- Intercepts Target URLs with fixtures.
- Drives `RUN_TICK_NOW`; it does not contact real Target.

- [ ] **Step 1: Write the browser test**

Assert the requirements listed in the design's simulated-browser section,
including exact one-click counts and persistent tab count.

- [ ] **Step 2: Run it and verify RED**

Run: `node tests/target-extension-browser.test.js`

Expected: failing assertions until all extension pieces integrate.

- [ ] **Step 3: Fix integration defects without weakening assertions**

Change only production code necessary to satisfy the existing browser test.

- [ ] **Step 4: Run it and verify GREEN**

Run: `node tests/target-extension-browser.test.js`

Expected: `target-extension-browser tests passed`, with no real Target request.

- [ ] **Step 5: Add browser test command**

Add:

```json
"test:extension-browser": "node tests/target-extension-browser.test.js"
```

### Task 8: Installation and operational verification

**Files:**
- Create: `scripts/install-target-extension.ps1`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Installs/reloads `extension/target-purchase` as an unpacked extension.
- Starts `scripts/target-extension-scheduler.js` hidden.
- Does not arm real Target tabs.

- [ ] **Step 1: Create an installation preflight**

The script validates:

- Chrome exists.
- Extension manifest parses.
- Port `18765` is available or already belongs to the scheduler.
- `npm test`, `npm run check`, and `npm run test:extension-browser` passed in
  the current workspace.

- [ ] **Step 2: Document installation and operation**

Update README with:

- Scheduler start/stop commands.
- Chrome unpacked-extension installation steps.
- Product and checkout arming workflow.
- Configurable interval behavior.
- Manual verification handling.
- Explicit warning not to run Playwright retail workers concurrently.

- [ ] **Step 3: Run complete verification**

Run:

```powershell
npm test
npm run check
npm run test:extension-browser
```

Expected: all commands exit `0`.

- [ ] **Step 4: Install into the user's Chrome**

Open `chrome://extensions`, enable Developer mode if necessary, load
`extension/target-purchase`, and verify the installed extension points to the
workspace directory.

- [ ] **Step 5: Start the scheduler hidden**

Start `npm run target-extension:scheduler` in a hidden background process and
verify port `18765` is listening.

- [ ] **Step 6: Verify installed state without arming real Target tabs**

Open the extension popup and verify:

- `Scheduler connected`
- interval `5000 ms`
- no product tabs armed
- no checkout tab armed

- [ ] **Step 7: Record final evidence**

Report the extension ID, installed path, scheduler PID/port, test commands, and
the fact that no real Target order action was executed during installation.
