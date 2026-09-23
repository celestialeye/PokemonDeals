# Repository Guidelines

## Project Structure

This is a Windows-only Node.js 20+ CommonJS project. `deals.js` and `src/`
provide the shared catalog, settings, secrets, adapter, TUI, and agent-facing
engine. The root JavaScript files are the operational workers:

- `monitor.js` — Target checkout state machine.
- `preorder.js` — Target product monitor.
- `target-watchlist-buy.js` — guarded first-available Target watchlist launcher.
- `pokemoncenter-preorder.js` — Pokémon Center multi-product monitor and serialized checkout.
- `amazon-preorder.js` — guarded Amazon product/direct Buy Now URL monitor; `amazon-checkout.js` — transient checkout-URL retry worker.
- `monitor_with_captcha_simulation.js` — experimental, syntax-checked only.

`README.md` is the usage reference, `SESSION-LEARNINGS.md` records state-machine and timing decisions, and `screenshots/` contains indexed evidence. Project-specific agent notes are in `.github/copilot-instructions.md`.
The repository-level `.github/skills/amazon-buy/SKILL.md` skill provides the
explicitly invoked `/amazon-buy <Amazon product or direct Buy Now URL>`
purchase workflow.

## Build, Test, and Development Commands

```powershell
npm install
npm run check
node --check monitor.js
```

`npm install` installs Patchright, `playwright-core`, and the remaining dependencies; `npm run check` performs syntax validation on every worker; `node --check <file>` is useful for a focused preflight. There is no build step or lint script. `npm test` runs the repository's unit tests.

For AI-agent operation, prefer `pokemon list`, `pokemon settings`, and
`pokemon monitor --execution <mode>`. The engine reuses or starts the
authenticated Chrome CDP profile on `127.0.0.1:9444`. Legacy worker commands
remain available through the npm scripts; consult `README.md` before running
because active modes can place real orders.

## Operating Modes

- **AI-agent operations:** the repository-aware main agent directly
  orchestrates product catalog changes, settings inspection, worker startup,
  streamed status monitoring, and terminal cleanup. Polling defaults to
  `observe-only`; checkout preparation uses `stop-before-submit`; an exact
  purchase request permits one scoped `live-purchase` run. An explicitly
  invoked `/target-buy <url>` or `/amazon-buy <url>` uses its guarded
  single-product skill instead of the catalog.
- **URL-only Target purchase:** a new user message consisting solely of one
  valid Target product URL authorizes one quantity-one automatic purchase
  attempt for that product. The main agent uses `target-direct-buy.js` in auto
  mode, takes the shared purchase mutex, checks for competing workers, keeps
  the process attached, and reports its outcome without asking for a mode or
  routine confirmation. The event-bound `/target-buy` launcher is only for a
  literal skill invocation. A URL inside a research or discussion request is
  not this trigger. After an ambiguous Place-order outcome, check Target
  Orders read-only before any further attempt; do not blindly resubmit.
  Sign-in or unsupported verification can still prevent completion without
  user involvement. See `README.md` and
  `docs/target-direct-buy-2026-09-23.md`.
- **Target watchlist purchase:** the 2026-09-23 overnight request authorizes
  repeated quantity-one orders across the eight-product list, including
  another order for a product after its previous order is confirmed. Put the
  validated labels, short links, and expected TCINs in
  `data/target-watchlist.json`, then run `npm run target:watchlist-buy` as the
  attached single-worker operation. The launcher shares the purchase mutex,
  uses one tab per product and a serialized human-paced poll queue, prioritizes
  Buy Now, and pauses polling while one checkout owns the transaction. An
  occupied unrelated cart disables cart-based fallback without changing
  existing items. After each confirmed order, the worker resets that product
  to a fresh page and resumes polling all eight. A new Place-order click is
  required before another confirmation counts. See `README.md`
  and `docs/target-first-available-watchlist-2026-09-23.md`.
- **Full-screen TUI:** `pokemon` with no arguments opens the TUI. It is still in
  development and must not be used as the AI agent's automation interface.

The shared engine currently has a Target adapter only. Target purchases use
the direct-buy worker through either the URL-only agent route or the explicit
`/target-buy <url>` skill. Amazon purchases use the explicit
`/amazon-buy <url>` skill. Pokémon Center remains a legacy direct worker.
Other documented commands include `npm run target:watchlist-buy`,
`npm run target:checkout`,
`npm run target:preorder`, `npm run pokemoncenter:preorder`, and
`npm run amazon:checkout`.

Operational requests are not development tasks. Do not route them through the
`/deals` development harness or its subagents. Do not merely return commands
for the user to run when the request and required scope are clear: the main
agent should run the direct command, keep the worker attached, monitor its
output, and report confirmation or the precise stop condition. Never start
competing workers against the shared browser profile.

## Coding Style & Naming

Keep CommonJS modules, two-space indentation, semicolons, double-quoted strings, and `async`/`await`. Use descriptive `camelCase` variables and constants for fixed URLs, patterns, and limits. Prefer resilient accessible selectors and verify that controls are visible and enabled before clicking.

## Testing Guidelines

For every JavaScript change, run `npm run check`. Behavioral changes require deliberate manual verification against the documented Chrome/CDP setup.

## Security and Configuration

Pass `TARGET_PIN`, `PRODUCT_FILTER`, and `AMAZON_*` values through the process
environment only. Never commit credentials or transient Amazon checkout URLs.
Workers share one Chrome profile, cart, and payment state; stop remaining
competing workers immediately after the first confirmed order. The explicitly
authorized Target watchlist continues within its single worker after each
confirmed order.

## Commits and Pull Requests

Use short imperative subjects consistent with the existing history (for
example, `Harden Amazon offer validation`). PRs should explain behavior
changes, list validation commands, identify new environment variables, and
include screenshots when selectors or checkout states change. Update
`README.md` or `SESSION-LEARNINGS.md` when operational behavior changes.

## Harness: PokemonDeals development

**Goal:** Maintain retailer workflows with scoped implementation, offline verification, and independent safety review; never operate checkout as a coding check.

**Trigger:** For nontrivial worker, state-machine, queue, selector, or regression work, use `/deals` (or read `.pi/prompts/deals.md` and follow it). Simple questions and low-risk edits may be handled directly. Usage and prerequisites: `.pi/README.md`.

**Change history:**
| Date | Change | Scope | Reason |
|------|--------|-------|--------|
| 2026-09-18 | Add initial development harness | `.pi/agents/`, `.pi/skills/`, `.pi/prompts/`, `.pi/tests/` | Bounded delegation, shared-session safety, and evidence-based review |
| 2026-09-18 | Reconcile Target checkout completion guidance | Maintenance/verification skills, module map, evaluation cases | Independent review detected source changes during setup; preserve runtime work and follow executable state transitions |
| 2026-09-19 | Add Amazon direct-buy skill | `.github/skills/amazon-buy/`, `amazon-preorder.js`, Amazon tests and docs | Convert a supplied product URL into a guarded direct checkout flow without cart navigation |
| 2026-09-21 | Add Target direct-buy skill | `.github/skills/target-buy/`, `target-direct-buy.js`, Target tests and docs | Convert one explicitly authorized Target product URL into a guarded autonomous purchase flow |
| 2026-09-19 | Separate operational surfaces | `AGENTS.md`, Copilot instructions | Make AI-agent orchestration explicit while keeping the TUI marked as in development |
| 2026-09-23 | Document Target direct-buy run and URL-only authorization | `AGENTS.md`, Target guide, session learnings, code comments | Preserve observed checkout and confirmation evidence and route future sole-URL requests without routine prompts |
| 2026-09-23 | Add first-available Target watchlist | `data/target-watchlist.json`, watchlist launcher, Target watch and docs | Monitor one tab per supplied URL and buy only one first eligible product |
| 2026-09-23 | Continue Target watchlist after confirmed orders | `target-watch.js`, tests and docs | Buy one unit per distinct URL and resume remaining product polls |
| 2026-09-23 | Enable overnight repeat orders | Target watchlist runner, worker, tests and docs | Resume all products after each confirmed quantity-one order with one checkout owner |
| 2026-09-23 | Recover Target watchlist transactions | Target watch, challenge code, tests and docs | Keep cart ownership through 429 and uncertain adds, reuse checkout preflight, preserve cookies, and report polling health |
