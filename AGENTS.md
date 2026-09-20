# Repository Guidelines

## Project Structure

This is a Windows-only Node.js 20+ CommonJS project. The root JavaScript files are the operational workers:

- `monitor.js` — Target checkout state machine.
- `preorder.js` — Target product monitor.
- `pokemoncenter-preorder.js` — Pokémon Center multi-product monitor and serialized checkout.
- `amazon-preorder.js` — Amazon product-URL direct-buy monitor; `amazon-checkout.js` — transient checkout-URL retry worker.
- `monitor_with_captcha_simulation.js` — experimental, syntax-checked only.

`README.md` is the usage reference, `SESSION-LEARNINGS.md` records state-machine and timing decisions, and `screenshots/` contains indexed evidence. Project-specific agent notes are in `.github/copilot-instructions.md`.
The repository-level `.github/skills/amazon-buy/SKILL.md` skill provides the
explicitly invoked `/amazon-buy <Amazon product URL>` purchase workflow.

## Build, Test, and Development Commands

```powershell
npm install
npm run check
node --check monitor.js
```

`npm install` installs Patchright, `playwright-core`, and the remaining dependencies; `npm run check` performs syntax validation on every worker; `node --check <file>` is useful for a focused preflight. There is no build step or lint script. `npm test` runs the repository's unit tests.

Operational commands are `npm run target:checkout`, `npm run target:preorder`, `npm run pokemoncenter:preorder`, `npm run amazon:direct-buy` (`amazon:preorder` alias), and `npm run amazon:checkout`. They require an authenticated Chrome profile exposed through CDP on `127.0.0.1:9444`; consult `README.md` for environment variables and warnings before running because checkout workers can place real orders.

## Coding Style & Naming

Keep CommonJS modules, two-space indentation, semicolons, double-quoted strings, and `async`/`await`. Use descriptive `camelCase` variables and constants for fixed URLs, patterns, and limits. Prefer resilient accessible selectors and verify that controls are visible and enabled before clicking.

## Testing Guidelines

For every JavaScript change, run `npm run check`. Behavioral changes require deliberate manual verification against the documented Chrome/CDP setup.

## Security and Configuration

Pass `TARGET_PIN`, `PRODUCT_FILTER`, and `AMAZON_*` values through the process environment only. Never commit credentials or transient Amazon checkout URLs. Workers share one Chrome profile, cart, and payment state; stop remaining workers immediately after the first confirmed order.

## Commits and Pull Requests

No Git history is present in this working copy, so no existing commit convention could be verified. Use short imperative subjects (for example, `Harden Amazon offer validation`). PRs should explain behavior changes, list validation commands, identify new environment variables, and include screenshots when selectors or checkout states change. Update `README.md` or `SESSION-LEARNINGS.md` when operational behavior changes.

## Harness: PokemonDeals development

**Goal:** Maintain retailer workflows with scoped implementation, offline verification, and independent safety review; never operate checkout as a coding check.

**Trigger:** For nontrivial worker, state-machine, queue, selector, or regression work, use `/deals` (or read `.pi/prompts/deals.md` and follow it). Simple questions and low-risk edits may be handled directly. Usage and prerequisites: `.pi/README.md`.

**Change history:**
| Date | Change | Scope | Reason |
|------|--------|-------|--------|
| 2026-09-18 | Add initial development harness | `.pi/agents/`, `.pi/skills/`, `.pi/prompts/`, `.pi/tests/` | Bounded delegation, shared-session safety, and evidence-based review |
| 2026-09-18 | Reconcile Target checkout completion guidance | Maintenance/verification skills, module map, evaluation cases | Independent review detected source changes during setup; preserve runtime work and follow executable state transitions |
| 2026-09-19 | Add Amazon direct-buy skill | `.github/skills/amazon-buy/`, `amazon-preorder.js`, Amazon tests and docs | Convert a supplied product URL into a guarded direct checkout flow without cart navigation |
