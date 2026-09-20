# Session Learnings

## Architecture that worked

Playwright connects to the persistent PokemonDeals Chrome profile through the
Chrome DevTools Protocol at `http://127.0.0.1:9444`. This avoids foreground-
input conflicts and allows multiple independent pages and workers to operate
in the same authenticated browser context without relying on Chrome's protected
default user-data directory.

The reliable sequence was:

1. Launch the non-default PokemonDeals user-data directory with
   `--remote-debugging-port=9444`.
2. Connect with `playwright-core` using `chromium.connectOverCDP`.
3. Open dedicated pages from the existing browser context.

The deals control plane now checks the CDP endpoint before a run and launches
the persistent Windows Chrome profile automatically when the endpoint is
missing. Sign-in is a one-time operator step in that profile. Patchright versus
Playwright remains a Target setting passed through `TARGET_BROWSER_DRIVER`;
Chrome startup only provides the shared CDP context.

## Deals purchasing engine and operating surfaces

The `deals.js` CLI is the shared purchasing engine with two operation surfaces.
The AI-agent surface uses direct, non-interactive subcommands and is the
recommended orchestration path: the agent owns catalog changes, starts an
explicit execution mode, monitors worker events, and reports or stops on
terminal evidence. The no-argument path lazily loads the in-development
`neo-blessed` full-screen application from `src\deals-tui.js`; direct
subcommands do not load the TUI and retain their plain-text output. Agent
operation must use an explicit execution mode rather than inheriting a stored
live default.
The engine owns the versioned `data\deals.json` catalog, retailer-scoped non-sensitive
settings, stable IDs, explicit product modes, armed state, execution-mode
choice, live status, terminal outcome, and child-process lifecycle. Retailer
adapters own URL recognition, per-retailer armed limits, setting defaults and
validation, worker arguments, secret-name validation, and output-event parsing.
This keeps retailer-specific purchase behavior out of the CLI.

The executable adapter registry currently contains Target only. Amazon and
Pokémon Center still use their legacy direct workers, so the main agent may
orchestrate them only through their documented commands and required
environment inputs.

The TUI remains a development surface. Its controller boundary is intentionally
one-way. The TUI builds product
rows and detail views, handles keyboard navigation and modal workflows, and
projects bounded control-character-stripped logs. Catalog CRUD, grouped-list
parsing, retailer metadata, settings validation, secret masking/storage,
execution preflight, worker spawning, output parsing, and runtime persistence
remain in their existing modules. `runAdapter()` emits lifecycle notifications
plus parsed product events after using the adapter parser, matching catalog
items, and persisting their state; the TUI never reparses worker output. The
old numbered readline loop is no longer the no-argument experience.
Opening the TUI with included products, or saving a new product from its Add
Product form, automatically starts the configured default run after the
catalog refresh. A live-purchase default starts directly for these automatic
runs; manually starting Live purchase still opens the typed `LIVE`
confirmation. Editing or importing products does not start a run automatically.
Ctrl+C disables automatic starts for the session until the operator starts a
run again. Only retryable Chrome/CDP startup failures schedule a five-second
automatic retry; worker exits and unknown outcomes are not replayed.
The **Run Stats** view is an additive live dashboard opened from the left
navigation, with `t` available as the in-run shortcut. It consumes the same
structured lifecycle and parsed-event notifications as the run screen,
tracking elapsed time, event categories, per-product counters, worker state,
and a bounded event feed; it does not reparse worker stdout or alter run
control.

The first registry entry is Target. User mode **Buy** maps to the existing
Target `add-to-cart` mode; **Buy Now** and **Preorder** map directly. The engine
always passes explicit `mode=url` arguments and never reimplements polling,
cart mutation, checkout, validation, or Place-order behavior from
`target-watch.js`/`target-checkout.js`. Direct Target URLs and known short links
are associated with product IDs offline; new short links are associated when
the worker emits `TARGET_SHORT_URL_RESOLVED`.

Catalog version 2 adds top-level `settings.target`. Version 1 catalogs are
migrated in memory and persist version 2 on their next write. The explicit
Target definition contains only meaningful operator controls: default run mode,
price ceilings, fulfillment, polling cadence, browser driver, solver enablement
and timing, challenge/cart backoff, and optional poll/runtime bounds. Validation
uses the existing worker defaults and limits, including timeout-at-least-hold
and maximum-backoff-at-least-base-and-cart-backoff relationships.
Timer-backed values are capped at Node's maximum reliable timer delay;
polling uses a lower ceiling that also accommodates the worker's positive
10-percent jitter so oversized settings cannot collapse into one-millisecond
loops.

Target engine runs expose challenge recovery as a first-class option. The
bundled `./target-challenge-solver.js` is enabled by default, including from the
full-screen run setup and `settings.target.solverEnabled`, and `--no-solver`
explicitly disables it for one run. The adapter sets
`TARGET_CHALLENGE_SOLVER` and, for solver-backed observe-only runs,
`TARGET_CHALLENGE_VALIDATE=1`. Existing challenge hold, timeout, settle,
attempt, and backoff environment overrides remain higher priority for
compatibility and are validated against the same safe ranges and relationships;
other non-sensitive values are built from persisted settings.
Active modes configure the solver without setting validation mode; observe-only
without the solver clears validation mode.

This control-plane wiring does not reimplement challenge input or grant solver
output authority. `target-watch.js` still owns mutation-queue serialization,
independent live clearance inspection, stale-state invalidation, and the
existing backoff ladder. The CLI parses `TARGET_CHALLENGE_DETECTED`,
`TARGET_CHALLENGE_SOLVED`, and `TARGET_CHALLENGE_BACKOFF` only to persist
operator-visible item/global status. The solved event includes the product ID so
stdout/stderr interleaving cannot attribute verified recovery to another
catalog item.

Catalog and local-secret writes use same-directory temporary files followed by
rename. `data\deals.json` stores no secrets or authenticated data and is
separate from `data\target-products.json`, which remains the existing Target
reference catalog. The ignored `data\deals-secrets.local.json` may store only
`TARGET_PIN` and `DISCORD_WEBHOOK_URL`; it is plaintext, has no encryption or
keychain protection, and relies only on the user's Windows account/filesystem.
Cookies, authentication state, payment data, card details, addresses, and
checkout URLs remain outside both files. Duplicate normalized URLs and known
duplicate Target product IDs are rejected. Unsupported retailers may be stored
while disarmed, allowing future adapter work without pretending they are
executable.

The Target adapter preserves the hard maximum of three armed items while
allowing any number of disarmed catalog entries. Execution is serialized to one
retailer adapter process at a time because retailer workers share a browser
profile, cart, and payment state. The three explicit run modes are:

1. `observe-only`: sets the worker's existing no-input gate.
2. `stop-before-submit`: the default; permits active cart/checkout work but sets
   the existing pre-submit terminal safety gate.
3. `live-purchase`: permits the existing worker to submit after all of its
   safeguards pass.

Before an active mode starts, any configured item/order price ceilings are
enforced, and the engine checks for an effective Discord webhook without
logging its value. Missing ceilings are treated as unlimited. Explicit
process-environment secrets take precedence over stored values for one-off
runs. The normal settings view masks stored secrets and reports environment
override presence; only the explicit reveal action displays stored values.
Direct commands stream worker stdout/stderr unchanged; the TUI shows a
bounded, terminal-control-stripped projection so checkout errors and safety
stops remain visible without allowing worker text to control the interface.
Existing
structured and plain Target events update per-item status through product IDs
or short-link resolution; explicit confirmation and terminal safety stops are
stored distinctly. A click, cart add, ready-to-submit stop, ambiguous outcome,
and confirmed order remain different states.

Ctrl+C is owned by the control plane while a worker is active. It signals the
direct child, waits briefly, then terminates it if needed so the CLI does not
leave an orphaned retailer process. No cross-process purchase lock was added;
operators must still avoid starting independent legacy workers alongside the
engine.

Offline evidence covers parsing, URL/retailer detection, mode mapping, catalog
CRUD and atomic replacement, version migration, settings defaults/validation
and persistence, unique-prefix selection, duplicate handling, three-item
enforcement, settings-to-Target environment construction, secret-presence
redaction/reveal behavior, secret persistence and environment precedence,
`.gitignore` coverage, and Target output parsing. Those tests do not spawn
`target-watch.js`, attach to CDP, contact a retailer, send Discord alerts,
exercise a challenge, mutate a cart, or validate a live order. Pure and
synthetic tests now cover TUI rows/details, keyboard action mapping, run
defaults, grouped-import controller transitions, minimum-size projection,
bounded safe event/log projection, and Run Stats lifecycle/category
projection. Full visual rendering in Windows
Terminal, focus behavior across every `neo-blessed` widget, clickable URL
recognition, authenticated short-link resolution, Ctrl+C cleanup against a real
worker, and all three live execution modes remain deliberate operator-validation
gaps. No retailer worker or CDP session is started by the TUI tests.

## Approaches that did not work

### Accessibility-driven browser control

Background UI automation was repeatedly interrupted whenever the user interacted with any Chrome window. A separate Chrome window did not solve this because interruption detection applied to the Chrome application, not just one window.

### Cloning an active Chrome profile

Copying the live profile failed on locked SQLite databases such as `Default\Network\Cookies`. Even after Chrome was closed and the profile copied successfully, the cloned profile was not authenticated to Target. Profile-bound cookie protection is a likely explanation, but the direct observation is that copying profile files to a different user-data path did not preserve the Target session.

### Enabling CDP after Chrome was already running

Remote-debugging flags are startup-only. Launching another Chrome command with a debugging port while the normal browser was already running forwarded the request to the existing process without enabling the new port. Chrome had to be fully restarted with CDP enabled.

## Target checkout state machine

The Target checkout flow was not a simple reload-and-click loop. The durable state machine became:

1. Open checkout.
2. If redirected to `/cart`, navigate back to `/checkout`.
3. If verification appears anywhere in Target, pause all actions and wait for manual completion.
4. If a modal high-demand error appears, click its OK button.
5. If an inline busy banner appears without an OK button, leave it visible and continue checking actions.
6. If Save and continue is enabled, click it and retry after one second.
7. If Confirm your PIN appears, fill the PIN from `TARGET_PIN`, click Confirm, and return to the main loop.
8. If Place order or Place your order is enabled, click it.
9. Wait for confirmation, another PIN dialog, or another high-demand state.
10. Exit only after explicit order-confirmation evidence.

Important selector lesson: Target used both `Place order` and `Place your order`. The flexible selector `/place(?: your)? order/i` was required.

Important timing lesson: clicking Place your order immediately after PIN confirmation could collide with Target's spinner or modal overlay. Returning to the main loop after PIN confirmation allowed popup dismissal and overlay completion before the next order attempt.

## Target high-demand variants

Observed variants included:

- `High-demand item in your cart`
- `A popular item in your cart is causing a delay`
- `Checkout is busy right now`
- `We're limiting how many guests can check out due to high demand`

Some appeared as modal dialogs with an OK button. Others appeared as inline banners with only a close icon. Modal dialogs should be dismissed before retrying; inline banners should not block Place your order attempts.

## Target Buy now versus Add to cart (online research, 2026-09-18)

No reliable Target-published A/B test or public success-rate dataset was found comparing `Buy now` with `Add to cart` for high-demand Pokémon TCG drops. Target's official guidance establishes the important inventory behavior:

- Saving an item in the cart does **not** reserve or hold it: [Target cart help](https://www.target.com/help/article/000062287).
- Product quantities and availability change quickly, and Target cannot guarantee that the displayed availability is accurate: [Target product availability](https://www.target.com/help/article/000061976).
- An order can still be canceled after Target receives it if the item becomes unavailable: [Target cancellation help](https://www.target.com/help/article/000062751).

The practical conclusion is that `Buy now` is the preferred first path for one highly competitive item **only when it goes directly to checkout**. Its likely advantage is avoiding a navigation step, not earlier inventory reservation. No evidence establishes a material difference once either path reaches checkout; `Add to cart` followed immediately by checkout is therefore the fallback when `Buy now` is unavailable, errors, or selects the wrong fulfillment method. Reviewing the cart or continuing to shop is the least favorable path because the cart does not protect the item.

This is research guidance, not a verified change to the current workers: `target-watch.js` and `preorder.js` still require and act on a current enabled `Add to cart` or `Preorder` control. If a future checkout path adds `Buy now`, compare method-level outcomes using checkout readiness, order-submission success, and explicit confirmation—not cart-add success alone. Do not race both paths concurrently on the shared Target profile; duplicate cart/order attempts can interfere with one another without improving inventory odds.

## Price detection

The checkout worker uses a decimal currency pattern such as `$31.99` as a signal that checkout content has loaded. It pauses page refreshes while still polling for Save and continue or Place your order.

Requiring decimal cents avoided a false positive from an injected shopping extension that displayed a lifetime-savings value with no cents.

## Target preorder state machine

Each product worker:

1. Opens a dedicated product page.
2. Waits up to 3 seconds for Preorder.
3. Clicks Preorder.
4. Waits 5 seconds for Target's result.
5. Handles Item not added to cart before evaluating success.
6. Closes the failure dialog and retries.
7. Stops after an added-to-cart signal.

Failure detection must run before success detection because the failure dialog itself contains `View cart & check out`, which otherwise looks like a successful add-to-cart signal.

Product workers use one reusable tab per product, staggered by the configured cadence to reduce simultaneous navigation bursts. `PRODUCT_FILTER` allows separate workers without duplicating every configured product. Each product tab closes after a cart-add signal, and reconnect cleanup closes the active batch before creating replacements.

## Verification and request cadence

Very aggressive refresh and click loops coincided with repeated retailer verification. Cadences that were more stable:

- Target checkout: wait up to 1 second for actionable content, then wait 1 second before a reload when no action is available.
- Target preorder: wait up to 3 seconds for Preorder and 5 seconds after clicking.
- Amazon checkout: refresh once per second while the item-quantity error remains.

Verification is detected through URL, title, and body-text patterns. The legacy
workers pause CAPTCHA, robot-check, Press and hold, and access-denied pages for
manual handling. The Target URL watch alone supports the explicitly configured,
bounded press-and-hold solver described below; unresolved and unsupported states
still back off. Its inspection includes visible frames and fails closed on unreadable pages.

### Pokémon Center hCaptcha (live investigation)

Pokémon Center's CDN (Imperva/Incapsula) presents an **hCaptcha** widget, not a
checkbox-only provider. Live CDP inspection confirmed:

- The hCaptcha checkbox iframe (`#frame=checkbox`) and challenge iframe
  (`#frame=challenge`) are cross-origin frames on `newassets.hcaptcha.com`,
  nested inside Pokémon Center's Incapsula wrapper iframe (`#main-iframe`).
- The wrapper iframe's DOM is readable, so the checkbox's on-screen coordinates
  can be computed; the cross-origin hCaptcha frames themselves hang on
  Playwright `frame.locator()` reads/clicks and refuse CDP clicks.
- Earlier investigation confirmed that low-level input could reach the
  checkbox, but automated challenge interaction is no longer an allowed
  workflow.
- The hCaptcha sitekey is `dd6e16a7-972e-47d2-93d0-96642fb6d8de`.
- Image-tile challenges also require manual completion.

**Imperva hard block.** Rapid repeated automated requests escalated the
challenge from an hCaptcha checkbox to **"Access is temporarily restricted"**
(a temporary IP/session ban that cannot be solved by the CAPTCHA). The fix is
to stop the traffic and let it cool down, then keep polling conservative. The
Pokémon Center worker defaults were raised to a 10s retry delay and 3s product
stagger, and the verification-detection loop paced at 3s, to avoid re-triggering
this block.

### What the preserved evidence establishes

The user reported Target verification after rapid preorder attempts at approximately 1:44 AM and again at 1:47 AM local time. The preserved attachment inventory contains the high-demand, checkout-busy, PIN, item-not-added, Place your order, and Amazon quantity-error screenshots indexed in [screenshots/README.md](./screenshots/README.md).

It does not contain an image of the verification challenge itself, so the preserved session alone cannot identify its provider. A separate direct Redsky probe on 2026-09-18 returned a PerimeterX `Press & Hold` page with `_pxAppId = PXGWPp4wUS`, establishing PerimeterX protection on `redsky.target.com`. This does not prove that every earlier challenge or every Target host used the same policy. CAPTCHA, robot check, Press and hold, security check, blocked, verify, and access denied remain conservative detection patterns.

The verified production recovery response remains to stop automated actions,
have the user complete the challenge in the authenticated Chrome window, and
resume only after the challenge text and URL indicators disappear. The optional
Target URL watch solver now has an isolated same-run verified native-hold recovery
followed by two fresh HTTP 200 responses. That run used a 45-second attempt budget;
default-budget and normal authenticated-session reliability remain unverified.
See the dated live follow-ups below for both failures and the passing retry.

### Target CAPTCHA incident timeline

- Around 1:44 AM local time, repeated automated Preorder attempts were followed by Target verification. The user explicitly reported that clicking Preorder too quickly triggered verification.
- Automation was slowed and changed to pause on challenge indicators.
- Around 1:47 AM, verification was reported again while rapid Target activity was still occurring.
- All Target checkout and preorder workers were then stopped so the user could clear the challenge manually.
- After the user reported that verification was fixed, automation resumed with slower product timing and global challenge detection.

This timeline supports a strong temporal association between rapid repeated Preorder activity and the verification event. It does not prove a specific request threshold, vendor, or deterministic trigger rule.

### Target CAPTCHA classification

The preserved checkout incident remains a Target anti-automation verification challenge of unknown presentation because no screenshot was retained. Separately, the direct Redsky probe definitively identified a PerimeterX `Press & Hold` challenge on `redsky.target.com`; do not generalize that tenant or policy to every Target host without direct evidence.

The script's broader pattern list covers several possible presentations so it can pause safely.

### Recovery strategy

1. Treat HTTP 403/429, PerimeterX HTML, `Press & Hold`, or visible verification on any Target tab as a shared-session circuit-breaker event.
2. Pause all Target monitoring and cart mutations for at least five minutes; double the cooldown on repeated challenge events up to thirty minutes.
3. For the Target URL watch, invoke the configured bounded solver before backoff. If no supported solver is configured or independent verification still finds the challenge, leave it for manual completion; legacy workers remain manual-only.
4. Verify that the page has returned to a normal Target product, cart, or checkout URL before resuming.
5. Keep product polling globally serialized and stagger initial page loads.
6. Require a current enabled product action before clicking; network availability alone is only a candidate signal.
7. If verification recurs, restart the global cooldown rather than refreshing through it.

Legacy workers must not refresh through or interact with a visible challenge. The Target URL watch may invoke the explicitly configured, bounded `target-challenge-solver.js`; it must independently verify that the challenge cleared and otherwise enter backoff. Local challenge simulation is limited to the isolated fixture suite.

## Target URL watch mechanism

The URL-driven monitor accepts one to three Target product jobs and enforces a hard maximum of three. Bare URLs retain automatic Preorder/Add-to-cart selection; explicit `buy-now=url` selects Buy now without allowing the worker to substitute another action. Explicit `preorder=` and `add-to-cart=` are also accepted. Three is the initial cap because the expected release pattern is one to three products and the previous eleven-tab design produced synchronized traffic without confirmed purchases.

The monitor opens one authenticated tab per product but uses one global scheduler for fulfillment checks and one mutation queue for Add to cart, Preorder, and checkout actions. The request queue permits only one active call, starts the global cooldown after that call completes, and preserves the cooldown after failures. The production default is five seconds plus ±10% jitter; three products therefore receive a serialized round-robin rather than synchronized page activity. The worker captures and replays the page-owned request in browser context, including its HTTP method, POST body, and rotating parameters. On 2026-09-18 the live page used `POST /cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules`; legacy Redsky GET responses remain supported.

Cadence thresholds must be established with bounded observe-only runs, not inferred from one successful session. `TARGET_MONITOR_OBSERVE_ONLY=1` disables Discord and purchase actions; `TARGET_MONITOR_MAX_POLLS` bounds each sample. Calibration stops on the first challenge, non-2xx response, fetch failure, or malformed response and emits status, latency, and queue-concurrency telemetry. Test slower global cooldowns before faster ones in separate sessions. Product-count testing requires distinct products because duplicate URLs are intentionally rejected; opening more tabs does not increase request concurrency because all polls share the same queue.

Initial isolated-profile calibration on 2026-09-18 produced these bounded results: 20 requests at five seconds returned 20 HTTP 200 responses; 20 at three seconds returned 19 HTTP 200 and one parseable HTTP 206; 20 at two seconds returned 20 HTTP 200; 20 at 1.5 seconds returned 20 HTTP 200; and an extended three-product run at 1.5 seconds returned 99 HTTP 200 and one parseable HTTP 206 across 100 requests. No run produced a challenge or fetch error, and queue maximum concurrency remained one. These samples do not establish a deterministic anti-bot threshold or long-duration authenticated-session safety. The production default is five seconds because the archived extension run demonstrated that synchronized browser activity can amplify Target's own cart traffic even when the fulfillment endpoint itself appears healthy.

The URL watch uses Patchright `1.63.0` by default, with `TARGET_BROWSER_DRIVER=playwright` retaining the matching `playwright-core` fallback. Both attach to the existing Chrome CDP endpoint; Patchright changes the automation driver, not the authenticated-profile requirement or request cadence.

A positive fulfillment field is only a candidate signal. The worker reloads the product page and requires a freshly resolved, visible, enabled `Add to cart` or `Preorder` control before acting. An observe-only Patchright run against available TCIN `1007918679` returned five HTTP 200 responses, classified the monitored product as `IN_STOCK`, selected action `purchase`, and independently found an enabled `Add to cart` control during initial navigation and after every poll. No click or cart mutation occurred. This run also exposed and fixed a classification bug where a zero-valued preorder quantity caused an in-stock purchase item to be mislabeled as preorder. A separate Patchright run against unavailable TCIN `1010892076` returned five HTTP 200 responses, consistently produced `available:false`, `action:null`, and `confidence:"unavailable"`, and reported no enabled purchase control.

Rapid sequential navigation across several Target search and category pages subsequently produced a visible verification challenge. The earlier fulfillment polling samples did not, so the evidence distinguishes the observed trigger pattern as search-page crawling rather than proving any universal request threshold. `target-preorder-discovery.js` therefore permits one search query per run, performs no pagination or candidate-page navigation, stops on challenge evidence, and persists a 15-minute local cooldown with a hard five-minute floor. A live preorder product has not yet been validated; absence of a returned candidate must not be treated as proof that none exists.

The worker sends a Discord availability alert concurrently with the selected action and handles `Item not added to cart` before any success text. Add/Preorder require explicit cart evidence before the distinct prepared checkout tab takes over; Buy now requires an explicit `buy-now=` job, keeps the original PDP open, and operates the order side panel directly.

A single blank checkout tab is created for active runs but is not navigated to empty checkout. This preserves immediate readiness without repeating the archived extension failure where checkout ran against an empty cart. After a confirmed add, the tab navigates to `/checkout` immediately. The first winning product claims a global transaction lease, so all other polling/cart mutations stop until explicit order confirmation or shared challenge backoff.

The in-process transaction lease is claimed before hover/click input. The existing warning against multiple workers remains important because no cross-process lock was added. Cart handshake, challenge, and shared rate-limit policy remain unchanged, but uncertain post-input outcomes now retain the owner and reconcile that product before another purchase action can run.

Both the dedicated checkout tab and Buy-now side panel use the same state ordering: shared circuit breaker, verification, explicit confirmation, fail-closed safety states, high-demand OK, Save and continue, PIN, Place order, then loaded-page wait/bounded recovery. State, prior state, state-entry time, and last progress are tracked. Replaced non-submit controls are reacquired on the next snapshot; unchanged loaded pages, sign-in or payment setup prompts, unavailable items, empty carts, unexpected items, and a disappearing engaged Buy-now panel stop safely. The worker consumes the existing authenticated shipping/payment state and does not automate account, address, or payment-method setup.

Before the single permitted Place-order attempt, a shared validator requires exactly one expected TCIN, quantity one, detected fulfillment, an optional configured fulfillment match, one unambiguous item price, one unambiguous order total, and required `TARGET_MAX_ITEM_PRICE`/`TARGET_MAX_ORDER_TOTAL` ceilings. `TARGET_STOP_BEFORE_SUBMIT=1` returns a terminal ready-to-submit result after validation without clicking. Once Place order is clicked, page closure, snapshot failure, or any other non-confirmed outcome returns terminal `ambiguous` and does not click it again during that run.

Add-to-cart and Preorder clicks retain the existing response observer, cart reconciliation, shared backoff ladder, and passive cart-response listeners. This focused change did not alter those policies.

### Autonomous purchase completion implementation (offline, 2026-09-19)

The focused Buy-now and shared-checkout work is implemented with deterministic offline tests. The tests prove explicit Buy-now selection, original-PDP routing, distinct cart checkout routing after confirmed cart addition, fail-closed purchase validation, bounded checkout recovery, `TARGET_STOP_BEFORE_SUBMIT`, and one-shot Place-order behavior.

This work did not launch a worker, connect to CDP, contact Target or Discord, inspect a profile, or perform a purchase. Offline unit and isolated fixture-browser results do not establish that current authenticated Target markup exposes every identity, quantity, fulfillment, item-price, or total field required by the validator. Operator-run observe-only, stop-before-submit, and explicitly approved purchase validation remain separate evidence gates.

Discord credentials remain in `DISCORD_WEBHOOK_URL` and are passed to the Python `discord.py` helper through the child-process environment, never command arguments or source files.

## Target press-and-hold implementation and evidence (2026-09-18)

The opt-in `target-challenge-solver.js` uses native pointer input on a unique
visible/enabled control. It traverses visible nested/cross-origin frames using
the browser's frame tree with ancestor visibility checks (including closed-shadow
frames), with FrameLocator retained for locator-only adapters. It matches both
`Press & Hold` and `Press and hold`, and retains the
held element's identity while its progress label changes. The default maximum
hold is 10 seconds, within a 20-second action budget. Pointer release is attempted
in `finally`; bounded cleanup may add 1.5 seconds. Protocol disconnection can
prevent cleanup and is reported as failure, never success. No cookie/token
injection, DOM challenge removal, or synthetic pointer events are used.

Integration corrections:

- Post-click solving runs inside the existing mutation instead of awaiting a new
  mutation queued behind itself. Other challenge entry points still enqueue.
- Independent inspection now includes visible frames; empty, closed, unreadable,
  or excessive-frame states cannot count as clearance. Detection also recognizes
  the `Press and hold` spelling without weakening earlier patterns.
- All verified recovery paths invalidate stale request/availability state.
- Normal observe-only calibration still stops on challenged API responses. The
  explicit `TARGET_CHALLENGE_VALIDATE=1` mode defers that stop while the current
  poll attempts resolution, prevents another queued request while unresolved,
  and resumes only after verified clearance. Unrelated errors and poll/time
  limits remain terminal. Backoff values and request concurrency are unchanged.
- A runtime limit is checked between operations. `TARGET_MONITOR_KEEP_PAGE=1`
  preserves the observe-only diagnostic tab on normal exit, not an active worker.

### Local evidence, not provider evidence

The isolated browser suite covers the original 800 ms fixture, delayed controls,
changed progress labels, nested cross-origin frames, navigation, frame removal,
early-release reset, persistent blocks, disabled/ambiguous controls, and 1/10-second
holds. It checks native event trust and balanced pointer-down/up evidence. Mock
Target responses exercise initial navigation, post-click, passive-response, and
replayed-API recovery; the last path demonstrates `TARGET_CHALLENGE_SOLVED`, fresh
request capture, and a later successful 200 poll without any purchase click.
All HTTPS requests in this suite are intercepted locally. This is not a real
HUMAN widget or live Target challenge test.

The first browser run exposed two test-harness issues: the all-traffic interceptor
also blocked the local file fixture, and Patchright's isolated evaluation world
could not read page-script globals. The harness now allows its local file load
and reads DOM data attributes for fixture evidence; it does not weaken assertions.

Final checks: `npm run check` and `npm run test:unit` passed. The four challenge-related
unit suites contain 49 passing tests in total. `npm run test:challenge:e2e` passed
11/11 browser tests with Patchright and 11/11 with `TARGET_BROWSER_DRIVER=playwright`.
The existing non-challenge unit suites also passed. No new dependency was added.

### Actual Target observation

Before the live run, the two existing Target tabs were inspected without navigation;
neither showed a challenge. No other operational Node worker was found running.
A single-product Patchright/CDP observe-only run then used TCIN `1007918679`,
5-second configured cooldown, a five-poll limit, a 60-second runtime limit, and
one solver attempt if challenged. From `19:13:24.847Z` through `19:13:55.587Z`:

- 5 API polls, all HTTP 200; valid availability payloads classified shipping in stock.
- Maximum queue concurrency 1; fetch errors 0; challenge count 0; solved count 0.
- Latency P50 221 ms; P95 236 ms.
- Enabled Add to cart controls were observed only; no purchase action or order was made.
- The diagnostic tab was preserved; the monitor exited normally after five polls.

### Independent review re-run (2026-09-18, ~19:23Z)

A separate reviewer re-ran the full suite and two live Target products with the
solver configured. `npm run check` and `npm run test:unit` passed; the browser
suite `npm run test:challenge:e2e` passed 11/11 under Patchright in about 46 s.

Live observe-only Patchright/CDP runs, solver configured, validation mode on:

- Unavailable TCIN `1010892076`, 2-second cooldown, six-poll limit: 6/6 HTTP 200,
  classified `available:false`/`action:null`/`confidence:"unavailable"`, latency
  P50 220 ms and P95 226 ms, challenge count 0, solved count 0, queue maximum
  concurrency 1, no purchase control found.
- Available TCIN `1007918679`, 2.5-second cooldown, five-poll limit: 5/5 HTTP 200,
  classified `available:true`/`action:"purchase"`/`confidence:"candidate"`,
  latency P50 229 ms and P95 293 ms, challenge count 0, solved count 0, queue
  maximum concurrency 1, enabled `Add to cart` observed on every inspection.

Neither run clicked a control or mutated the cart. Wiring the solver into the
monitor therefore introduced no detection regression, no added challenge events,
and no measurable latency change on the polling path across these bounded samples.
Eleven live Target polls without a challenge is not evidence of long-session or
drop-time safety.

At that review stage, no real challenge solve had been exercised. The following
later isolated-browser test adds live evidence without changing those earlier
observations or turning mock solved events into real ones.

### Real challenge follow-up (~19:37–19:52Z)

Two separate unauthenticated Chrome sessions, each using a `PhantomJS` user agent
and one exact product navigation, displayed a real Target `Quick verification /
Press & hold` modal on TCIN `1007918679`. These were bounded diagnostic probes,
not a search crawl, preorder click sequence, or bare-HTTP burst. The normal
authenticated CDP profile was inspected only and not used for the trigger/input.
The first probe's solver found no control and its harness closed the isolated
browser; the second probe was started after the five-minute failure cooldown and
its dedicated browser was preserved for diagnosis.

The live DOM revealed the missing test case: a visible `role=button` control in a
`Human verification challenge` iframe inside a closed shadow root, with multiple
hidden iframe copies. The frame helper now enumerates browser frames directly,
checks owner/ancestor visibility, and includes each frame exactly once. This
avoids depending on driver-specific shadow-piercing behavior. No provider DOM
was changed and no screenshot coordinates were hardcoded.

On the preserved page, one automatic native hold started at **19:46:21Z** and
finished after **10315 ms**. At **19:46:34Z**, the original driver's settle check
still saw a processing indicator and reported `unresolved`, entering backoff.
A read-only observation at **19:46:53Z** found the normal product page without any
additional input or navigation. The exact server-completion latency between the
last blocked observation and this clean observation is unknown.

This exposed a second gap: the original solver treated a disappearing hold label
as the end of its transition wait even while the provider showed a spinner.
It now spends the remaining attempt budget waiting on live page evidence before
returning; the driver's separate settle/verification remains authoritative.
The default timeout remains 20 seconds; slow or unreadable completion can still
exhaust it and must remain unresolved rather than being declared successful.

After the failure cooldown, the same browser session reloaded the product once
without being challenged. A freshly captured fulfillment request returned
**HTTP 200**, valid availability JSON, at **19:52:01.295Z**, with **219 ms** latency.
Cookies and user agent were not manually changed between the hold and that poll.
No cart/purchase action occurred. The dedicated anonymous diagnostic browser was
left open, with no Node monitor running.

**Evidence boundary:** real native-input clearance plus a later successful fresh
poll is now observed. The live attempt did not emit `TARGET_CHALLENGE_CLEARED` or
`TARGET_CHALLENGE_SOLVED` because the old check returned early. The final timing
fix has local regression coverage, not a fresh successful live hold; the strict
same-run monitor acceptance gate remains open. This nonstandard-user-agent test
also does not establish normal authenticated-session reliability or a universal
trigger. See Incident 4 in `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md` and the screenshot
index for sanitized evidence.

Post-fix checks: `npm run check` and all unit suites passed, including **53** tests
across the four challenge-related unit suites. Browser E2E passed **13/13** with
Patchright and **13/13** with Playwright, including closed-shadow hidden copies
and a processing phase longer than the old settle window.

### Revised-solver live confirmation attempt (~19:59Z)

A later single-product test used one fresh unauthenticated browser, the same
nonstandard user agent, and the revised solver configured for one 10-second hold
within a 45-second attempt budget. No application source or default configuration
was changed. The product document returned HTTP 200 but did not present a challenge.
Five further read-only inspections at five-second intervals also found the page
clear; the user-agent setting was verified active. Consequently, **no solve was
attempted and no resumed API-poll sequence was exercised**. There were zero pointer
actions, zero replayed API polls, and zero observed cart-mutation requests.

This run is **not exercised**, not a passing live solver test. It does not replace
the earlier real hold/clearance evidence or close the remaining same-run acceptance
gate. The test stopped rather than escalating traffic, and its isolated diagnostic
browser was left open. The sanitized report is
`screenshots/target-live-confirmation-2026-09-18T19-58-58-091Z.json`.

### Automation-signal tuning and same-run passing retry (~20:05–20:12Z)

One subsequent fresh diagnostic browser enabled Chrome's `--enable-automation`
flag while retaining `PhantomJS` and the same product. Runtime inspection verified
`navigator.webdriver=true`. One navigation presented a real challenge. The first
native attempt did not clear within its 45-second budget, and the widget showed
`Please try again`. The driver entered backoff and the page was preserved. This
is a genuine failed solve, not merely an unexercised run or an inferred spinner.

After that failure's cooldown had expired, a single diagnostic recovery cycle
allowed two consecutive attempts, with a refresh before the second only if needed.
No extra five-minute gap was inserted between those configured attempts.
**The first retry succeeded; no retry-refresh was needed.** User agent, automation
flag, and cookies were not manually changed, and challenge markup was untouched.

Actual same-run evidence:

- **20:11:28.545Z:** challenge detected; attempt 1/2 began.
- **20:11:28.905Z:** native hold started; exactly one pointer-down/up pair was issued.
- **20:11:42.748Z:** native input plus completion waiting finished in **14054 ms**.
  The earlier diagnostic used a 10000 ms maximum continuous-hold cap; that was
  an implementation safety limit, not a provider requirement. The elapsed
  figure is total attempt time, not hold duration.
- **20:11:45.721Z:** independent driver verification emitted both
  `TARGET_CHALLENGE_CLEARED after=1` and `TARGET_CHALLENGE_SOLVED`.
- Stale request state was invalidated; one ordinary product reload captured a fresh
  template. **20:12:00.059Z** and **20:12:05.465Z** polls returned valid JSON and
  **HTTP 200**, with latencies **198 ms** and **217 ms**.
- Queue maximum concurrency was **1**; purchase clicks and observed cart mutation
  requests were **0**. Final page inspection was clean.

One additional diagnostic inspection just after the solved event was unreadable;
it was retained in the report, not counted as proof of clearance. The driver's own
verification, fresh-navigation/final inspections, two API responses, and subsequent
read-only checks at 20:13:31Z and 20:13:36Z supplied the independent recovery evidence.

This closes the requested same-run event-sequence gate **for this isolated real
Target integration test**, not for every session. It used a 45-second configured
attempt budget rather than the unchanged 20-second default. The live harness invoked
the real monitor's resolution driver and request queue; it did not run checkout or
exercise the full production CLI's authenticated/multi-product behavior. A potential
refresh-before-second-attempt policy was local to the harness, was not exercised,
and was not added to the bundled solver. Default backoff and polling rates were
not reduced. The successful browser was left open without a running Node monitor.

Reports and screenshots:

- `screenshots/target-live-automation-signal-2026-09-18T20-04-55-751Z.json` — triggered,
  but rejected with `Please try again` after the first attempt.
- `screenshots/target-live-retry-refresh-2026-09-18T20-11-28-193Z.json` — **passed**;
  actual ordered event sequence, two valid polls, and follow-up stability evidence.
- Corresponding before/after/final screenshots are indexed in `screenshots/README.md`.

No JavaScript application source changed during these live trials. The structured
passing report was validated with assertions for event ordering, balanced input,
request-template reset, two valid 200 responses, concurrency one, and zero purchase
or observed cart-mutation activity.

## Amazon checkout state machine

Amazon checkout URLs contain transient execution identifiers and can change during the flow. The current URL must be passed through `AMAZON_CHECKOUT_URL`.

The worker:

1. Opens the supplied checkout URL.
2. Detects Make updates to your items and quantity-unavailable messages.
3. Refreshes while those errors remain.
4. Treats navigation aborts caused by Amazon redirects as recoverable.
5. Clicks Continue after the item-selection error clears.
6. Clicks Place your order when enabled.
7. Waits for explicit order-confirmation text.

## Concurrency findings

Multiple checkout workers can improve retry coverage, but they share the same browser profile, cart, payment state, and Target session. They can also:

- Trigger verification faster.
- Compete over dialogs and overlays.
- Produce pointer-interception timeouts.
- Submit duplicate orders if more than one worker reaches a valid Place your order button.

Use concurrent checkout workers only deliberately, and stop every remaining worker immediately after the first confirmed order.

## Security and persistence

- Never hardcode the Target PIN.
- Never commit Amazon checkout URLs containing session or execution identifiers.
- Pass sensitive or transient values through process environment variables.
- The scripts do not store credentials.
- Browser authentication remains in the user's existing Chrome profile.

## Session handoff state

All monitoring processes were explicitly stopped before this project was moved into `PokemonDeals`. Nothing restarts automatically.
