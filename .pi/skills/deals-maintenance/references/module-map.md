# Module and test map

All paths below are relative to the repository root. Use this map to locate code, not as a frozen specification: verify current commands in `package.json` and behavior in source plus `README.md`.

| Area | Source | Offline tests / reading |
|---|---|---|
| Target polling and availability | `target-watch.js`, `global-request-queue.js`, `target-availability.js` | `tests/global-request-queue.test.js`, `tests/target-availability.test.js`, `tests/target-watch-challenge.test.js` |
| Target watch checkout and transaction completion | `target-checkout.js`, `target-watch.js`, `target-products.js` | `tests/target-checkout.test.js`, `tests/target-watch-challenge.test.js`; cart evidence sets `addedToCart`, checkout confirmation sets `completed`/shared order-confirmed state; verify executable assignments if comments differ |
| Target one-product direct buy | `target-direct-buy.js`, `src/target-buy-input.js`, `src/target-buy-invocation.js`, `src/target-run-log.js`, `.github/skills/target-buy/` | `tests/target-buy-input.test.js`, `tests/target-buy-invocation.test.js`, `tests/target-direct-buy.test.js`, `tests/target-buy-skill.test.js`, `tests/target-run-log.test.js`; binds the raw URL to the active user-invoked turn before delegating browser behavior to the Target watch |
| Target challenge contract, page inspection, bounded input | `target-challenge.js`, `target-challenge-page.js`, `target-challenge-solver.js` | `tests/target-challenge.test.js`, `tests/target-challenge-page.test.js`, `tests/target-challenge-solver.test.js`, `tests/helpers/target-challenge-fakes.js`; start with `TARGET-CHALLENGE-DEVELOPER-GUIDE.md` |
| Target challenge browser mechanics | Same challenge modules, `target-watch.js` | `tests/target-challenge-solver.integration.test.js`, `tests/fixtures/`; isolated Chrome/local interception, separate opt-in test layer |
| Target catalogs and discovery | `target-products.js`, `target-preorder-discovery.js` | `tests/target-products.test.js`, `tests/target-preorder-discovery.test.js`; executing discovery itself is live, not a unit test |
| Legacy Target monitor/checkout | `preorder.js`, `monitor.js` | `README.md`, `SESSION-LEARNINGS.md`; no dedicated checkout unit suite at harness creation |
| Pokemon Center | `pokemoncenter-products.js`, `pokemoncenter-preorder.js` | `tests/pokemoncenter-products.test.js`; catalog coverage only, not checkout verification |
| Amazon offers, direct buy, shared cart, and logging | `src/amazon-offers.js`, `src/amazon-cart.js`, `src/amazon-run-log.js`, `amazon-preorder.js`, `amazon-multi-preorder.js` | `tests/amazon-offers.test.js`, `tests/amazon-direct-buy.test.js`, `tests/amazon-run-log.test.js`, `tests/amazon-multi-preorder.test.js`; includes direct Node assertions |
| Amazon transient checkout | `amazon-checkout.js` | `README.md`, `SESSION-LEARNINGS.md`; no dedicated checkout unit suite at harness creation |
| Experimental variant | `monitor_with_captcha_simulation.js` | Syntax-only; not an exposed operational workflow |

## Evidence and non-source boundaries

- `screenshots/README.md` indexes preserved evidence. Only inspect a relevant image when needed and authorized; do not collect or copy authenticated screenshots into handoffs.
- `SESSION-LEARNINGS.md` and `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md` contain historical evidence and explicit limitations. Fixture success and isolated-profile experiments do not establish authenticated production reliability.
- `archive/target-purchase-extension-2026-09-18/` is retired. Do not wire its tests or extension back into active workflows by accident.
- `.github/mcp.json` points to the authenticated CDP browser. Its presence is not authorization to use it during development.
- `.chrome-target-test/`, `.env`, runtime `data/`, and request captures may hold session-sensitive data. Do not mine them for fixtures. Use synthetic, redacted cases.
