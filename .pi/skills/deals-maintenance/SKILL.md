---
name: deals-maintenance
description: "Maintain PokemonDeals retailer workers, product catalogs, state machines, queues, offer guards, selectors, and challenge recovery. Load for Target, Amazon, or Pokemon Center code changes, debugging, plans, reviews, and follow-up fixes in this repository. Not for shopping research, operating a worker, or unrelated prose edits."
---

# Retailer maintenance

## Establish scope

1. Read the repository's `AGENTS.md` and `.github/copilot-instructions.md`. Find the relevant sections of `README.md` and `SESSION-LEARNINGS.md`; they distinguish current behavior from historical experiments.
2. Read [the module map](references/module-map.md) for the affected flow. Resolve that link relative to this skill; paths inside the map are repository-relative.
3. Search named source files, `src/`, and `tests/` before widening scope. Exclude browser profiles (especially `.chrome-target-test/`), `.env`, `node_modules/`, generated artifacts, and `archive/` unless the task explicitly concerns an archived implementation. Do not recursively search the whole working copy for secrets or session data.
4. Trace the caller, callee, corresponding test, and relevant documented behavior together. State what is observed versus inferred. Flag conflicting docs/code rather than silently choosing a new purchase policy.

## Development-only boundary

This skill authorizes source maintenance, not shopping. Authenticated workers share a profile, cart, and payment state; even a monitor can perform mutations.

- Do not launch workers, contact retailer endpoints or CDP, invoke browser/MCP tools, send Discord notifications, or run discovery as part of coding verification. Observe-only still contacts a retailer and is not an offline test.
- Leave live verification to a separately approved, bounded operator procedure. Approval to implement or review is not approval to operate, purchase, change a profile, or stop processes. Do not grant such approval to subagents.
- Do not read, print, or persist credentials, cookies, request templates/headers, PINs, webhook URLs, transient checkout URLs, or authenticated page dumps. Use environment-variable **names** and redacted examples only, including in handoffs and logs.
- Preserve the existing manual-verification policy outside the explicitly opt-in Target URL watch solver. Do not accelerate polling, deliberately provoke challenges, or alter identities/cookies to make a test pass.
- Do not commit, push, create a PR, merge, install dependencies, or deploy unless explicitly requested. Tool allowlists and these instructions are not a sandbox.

## Preserve contracts

### Common state machines

Map `input evidence -> classification -> guard -> action -> independent outcome -> retry/stop`. Check verification before actions, visible/enabled controls before clicks, and explicit outcome evidence afterward. A click, cleared challenge, cart-add signal, and confirmed order are four different events.

Keep bounded waits, retry limits, reconnect/page cleanup, and conservative cadence. Shared state requires serialized mutation and explicit lock recovery on errors; do not release an uncertain in-flight purchase merely to allow another submission. Never infer purchase success from the absence of an error alone.

### Target

- URL watch: separate the global polling gate (cooldown after completion, including failures) from the shared mutation queue. Network availability alone cannot authorize a cart click.
- Handle `Item not added to cart` before cart-success text. Trace actual flag assignments and consumers rather than trusting historical comments: current watch sets `addedToCart` on cart evidence, while `continueCheckout()` sets `completed` and shared order-confirmed state only after the checkout runner returns `"confirmed"`. A cart-only or nonconfirmed checkout result must not be promoted to completion.
- Read `target-checkout.js` with its watch callers and `tests/target-checkout.test.js`. Preserve the single winning transaction, expected-product/quantity checks, dedicated checkout-tab versus Buy now side-panel handling, and explicit confirmation. Helper unit coverage does not certify a live purchase.
- Challenge changes: read `TARGET-CHALLENGE-DEVELOPER-GUIDE.md`, then the affected source/test pair. Independent live inspection owns clearance; unreadable means blocked. Preserve stale-state invalidation, backoff, terminal stop flags, and poll/runtime limits.
- Post-click recovery already owns the non-reentrant mutation queue. Preserve ownership signaling; enqueueing behind the current operation can deadlock. Keep native-input release/cleanup bounded even after failures.
- Legacy checkout: preserve decimal-currency load detection and its grace period, shipping/PIN/high-demand handling, manual verification, and explicit confirmation. Legacy preorder keeps its per-tab verification and reconnect cleanup.

### Amazon

Preserve expected ASIN/title checks, Amazon-sold **and** Amazon-shipped checks, item-price and order-total caps, expected-item cart selection, checkout lock ownership, and explicit confirmation. Read `src/amazon-offers.js` and `src/amazon-cart.js` alongside their consumers. Do not assume the transient-URL checkout worker has the preorder worker's product guards.

The multi-product worker intentionally continues remaining products after each confirmed order; the general instruction to stop competing workers prevents duplicate purchases. Treat this distinction as explicit behavior, not permission to change shutdown semantics without discussing it.

### Pokemon Center

Preserve deduplication/product identity, one reusable tab per product, serialized shared-cart actions, total checks, manual verification/sign-in pauses, and explicit confirmation. Catalog tests do not prove live checkout correctness.

## Change discipline

- Use CommonJS, two spaces, semicolons, double quotes, and async/await. Keep Patchright confined to the documented Target watch driver switch and its tests, with the Playwright fallback intact.
- Reuse existing accessible selectors and fake-page/clock seams. Prove a regression offline before broad refactors; do not import a root worker until its startup guard has been checked.
- Read exact surrounding text, edit the smallest coherent block, and preserve unrelated changes. Stay inside assigned files; return a scope request if more files are needed.
- Read `.pi/skills/deals-verification/SKILL.md` before running checks. Operational behavior, environment variables, selectors, or timing changes require matching usage/learnings updates and a clearly marked manual-verification gap.

## Handoff

Return a concise report; read-only agents return text and the coordinator persists it:

```text
## HANDOFF
- STATUS: PASS | FAIL | BLOCKED
- CONTEXT: task, scope, and assumptions
- OUTPUT: changed/reviewed paths and main result
- EVIDENCE: file:line references; commands actually run and exit results
- OPEN: unresolved risks and unverified live behavior
- NEXT: next bounded action, or none
```

On follow-up, read the specified prior handoff and current files; do not assume an old PASS remains valid. Missing access, uncertain purchase intent, or conflicting safety requirements are BLOCKED, not permission to invent results.
