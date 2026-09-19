# Copilot instructions

## Project shape

This is a Windows-only Node.js 20+ CommonJS project. The root scripts drive an already-authenticated Google Chrome profile over Chrome DevTools Protocol (CDP); `target-watch.js` uses Patchright by default with a `playwright-core` fallback, while the other workers use `playwright-core`. There is no transpilation or application build step.

The operational source of truth is `README.md`. `SESSION-LEARNINGS.md` records the state-machine ordering, polling cadence, verification recovery, concurrency behavior, and evidence limits. Keep those documents aligned with changes to commands, environment variables, selectors, or flow behavior. For challenge-recovery changes, start with `TARGET-CHALLENGE-DEVELOPER-GUIDE.md`; it maps the source interfaces, queue/verification ownership, timeout semantics, test layers, and profile/evidence boundaries.

## Build, test, and lint commands

Install dependencies:

```powershell
npm install
```

Run the repository's syntax validation:

```powershell
npm run check
```

`npm run check` runs `node --check` against the workers, shared modules, and challenge tests registered in `package.json`, including `monitor_with_captcha_simulation.js`.

For a focused syntax check on one script:

```powershell
node --check monitor.js
```

`npm test` delegates to `npm run test:unit`. Challenge tests use `node:test` and `node:assert/strict`; other suites also use direct Node assertions. `npm run test:challenge:e2e` launches isolated installed Chrome with locally intercepted fixture traffic, not the authenticated CDP profile. There is no lint script.

Before running a worker, check whether the existing authenticated Chrome already exposes CDP on port `9444`; reuse that context when available, rather than creating a fresh profile. Only if CDP is unavailable should the intended profile be closed and restarted with debugging enabled as documented in `README.md`. Verify the endpoint with:

```powershell
Invoke-RestMethod 'http://127.0.0.1:9444/json/version'
```

The project-scoped `.github/mcp.json` registers Playwright MCP against the same CDP endpoint for browser inspection and testing. Start the authenticated Chrome instance before using that MCP server.

The supported operational commands are:

```powershell
npm run target:checkout
npm run target:watch
npm run target:preorder
npm run amazon:preorder
npm run amazon:checkout
```

The checkout commands can submit real orders; `target:preorder` is the cart-monitoring step. Follow the environment-variable setup and safety checks in `README.md` before invoking any worker.

## Architecture

- **Shared browser runtime:** Every worker calls `chromium.connectOverCDP("http://127.0.0.1:9444")`, uses the first existing browser context, and opens its own page. The outer loop reconnects when Chrome or a page is unavailable.
- **Target URL watch (`target-watch.js`):** One global availability-request queue and one mutation queue serialize polling and cart actions. Optional `target-challenge-solver.js` performs bounded native press-and-hold input; `target-challenge-page.js` independently inspects the main page and visible frames, failing closed on unreadable state. Post-click solving already owns the mutation queue and must not re-enqueue itself. A bounded isolated real-Target retry confirmed the same-run cleared/solved events followed by two fresh HTTP 200 polls, using a 45-second attempt budget. Default-budget and normal authenticated-session reliability remain unverified; the optional diagnostic refresh fallback was not exercised or added to the bundled solver. Use the browser-native frame tree for closed-shadow iframe discovery, check owner/ancestor visibility, and wait for page clearance rather than label disappearance; see the session evidence.
- **Target checkout (`monitor.js`):** A page-local state machine handles `/cart` redirects, manual verification pauses, high-demand dialogs, shipping `Save and continue`, the `TARGET_PIN` confirmation dialog, and repeated order attempts. It exits only after explicit order-confirmation text or URL evidence.
- **Target preorder (`preorder.js`):** The configured Target product IDs are monitored in one reusable tab per product, with a stagger between pages. `PRODUCT_FILTER` narrows the set. A product tab closes after a cart-add signal; verification pauses only the affected tab, and reconnect cleanup closes the active batch before new tabs are created.
- **Pokémon Center (`pokemoncenter-preorder.js`):** The deduplicated catalog uses one reusable tab per product. Product actions are serialized through the shared Pokémon Center cart; the worker validates product identity and order total, pauses for manual verification/sign-in, and stops after explicit confirmation.
- **Amazon preorder (`amazon-preorder.js`):** The flow validates the expected ASIN/title, accepts only an Amazon-shipped and Amazon-sold offer under the configured item-price limit, selects only the expected cart item, enforces an order-total limit, and then proceeds through checkout.
- **Amazon checkout (`amazon-checkout.js`):** The current transient checkout URL comes from `AMAZON_CHECKOUT_URL`. The worker refreshes while Amazon reports quantity/update errors, clicks `Continue` when needed, submits when checkout is usable, and then waits for explicit confirmation evidence.
- **Experimental Target variant:** `monitor_with_captcha_simulation.js` is syntax-checked but is not an exposed npm workflow.

## Repository-specific conventions

- Keep the code CommonJS. Use Patchright only through the Target URL watch's driver switch and retain `playwright-core` as its fallback and as the driver for existing workers. Use the existing Node assertion/test harness; do not introduce a framework or bundler for routine changes.
- Pass secrets and transient session data through environment variables only: `TARGET_PIN`, `PRODUCT_FILTER`, the `AMAZON_*` inputs, and especially `AMAZON_CHECKOUT_URL`. Never hardcode PINs, credentials, or short-lived checkout URLs.
- Preserve the state-machine ordering. Detect verification before taking actions; handle Target's `Item not added to cart` failure before treating cart-related text as success; validate product identity and price/total guards before Amazon checkout actions; treat a click as successful only after the resulting page state is confirmed.
- Use resilient accessible selectors (`getByRole`, `getByText`, and regular expressions) because Target and Amazon vary button labels such as `Place order` and `Place your order`. Check that controls are visible and enabled before clicking.
- Verification detection intentionally combines URL, title, and body-text patterns. Other workers retain manual handling. Only the Target URL watch supports an explicitly configured press-and-hold solver; preserve independent live inspection, bounded input cleanup, serialized work, and unresolved-challenge backoff. Observe-only normally stops on challenge; `TARGET_CHALLENGE_VALIDATE=1` permits verified recovery only, never unrelated-error or limit resets. Do not deliberately hammer Target to trigger verification.
- Keep the conservative cadence documented in `SESSION-LEARNINGS.md`: Target checkout waits before reloads, Target preorder waits up to 3 seconds for `Preorder` and 5 seconds after a click, and Amazon checkout refreshes about once per second while quantity errors remain. Faster loops were temporally associated with retailer verification in the preserved session evidence.
- All workers share the same Chrome profile, cart, payment state, and session. Concurrent workers can interfere with each other and can submit duplicate orders; stop remaining workers immediately after the first explicit confirmation.
- When changing checkout readiness detection, preserve Target's decimal-currency load signal and its grace period before refreshing. It prevents a populated checkout from being reloaded too aggressively while still allowing recovery from a stalled page.
