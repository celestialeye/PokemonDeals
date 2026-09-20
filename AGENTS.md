# Repository Guidelines

## Project Structure

This is a Windows-only Node.js 20+ CommonJS project. `deals.js` and `src/`
provide the shared catalog, settings, secrets, adapter, TUI, and agent-facing
engine. The root JavaScript files are the operational workers:

- `monitor.js` — Target checkout state machine.
- `preorder.js` — Target product monitor.
- `pokemoncenter-preorder.js` — Pokémon Center multi-product monitor and serialized checkout.
- `amazon-preorder.js` and `amazon-checkout.js` — Amazon workflows.
- `monitor_with_captcha_simulation.js` — experimental, syntax-checked only.

`README.md` is the usage reference, `SESSION-LEARNINGS.md` records state-machine and timing decisions, and `screenshots/` contains indexed evidence. Project-specific agent notes are in `.github/copilot-instructions.md`.

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
  purchase request permits one scoped `live-purchase` run.
- **Full-screen TUI:** `pokemon` with no arguments opens the TUI. It is still in
  development and must not be used as the AI agent's automation interface.

The shared engine currently has a Target adapter only. Amazon and Pokémon
Center remain legacy direct workers; their documented commands can be
orchestrated by the main agent.

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
workers immediately after the first confirmed order.

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
| 2026-09-19 | Separate operational surfaces | `AGENTS.md`, Copilot instructions | Make AI-agent orchestration explicit while keeping the TUI marked as in development |
