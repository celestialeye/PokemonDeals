# PokemonDeals

Playwright scripts for monitoring high-demand Pokemon product and checkout flows in an existing authenticated Chrome profile.

These scripts can add products to a cart and submit real orders. Run them only when you intend to make a purchase, verify the active cart, shipping address, payment method, and quantities first, and stop duplicate workers after one order succeeds.

## Scripts

- `monitor.js`: Target checkout state machine. Handles cart redirects, shipping retries, high-demand dialogs, PIN confirmation, and repeated order submission until confirmation.
- `target-watch.js`: End-to-end Target monitor for one to three product URLs. Uses Patchright by default, replays the page-owned fulfillment request, handles Preorder, Add to cart, and Buy now, and immediately drives checkout until explicit order confirmation.
- `preorder.js`: Target product monitor. Watches configured product pages, clicks Preorder, closes failed-add dialogs, and stops monitoring a product after it is added to the cart.
- `pokemoncenter-preorder.js`: Pokémon Center multi-product monitor. Keeps one tab per unique product, serializes shared-cart checkout, and stops after an explicit order confirmation.
- `amazon-preorder.js`: Amazon product monitor. Clicks Pre-order now, returns from unavailable-item checkout pages, retries, and submits the order when checkout becomes usable.
- `amazon-multi-preorder.js`: Amazon multi-product monitor. Keeps one dedicated tab per product and serializes shared-cart checkout actions.
- `amazon-checkout.js`: Amazon checkout monitor. Refreshes while quantity errors remain, advances with Continue, and submits the order when checkout becomes usable.
- `screenshots/`: Preserved session screenshots with a traceable evidence index.
- `archive/target-purchase-extension-2026-09-18/`: Retired Target Chrome extension source, tests, documentation, and run artifacts.

## Requirements

- Windows
- Node.js 20 or newer
- Python 3.10 or newer for Discord alerts
- Google Chrome
- Chrome started with the authenticated profile and CDP enabled on port `9444`

Install dependencies:

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
npm install
```

Validate the scripts:

```powershell
npm run check
```

## Deals purchasing engine

`npm run deals` opens the interactive control plane for the versioned
`data\deals.json` catalog. It can list, add, paste/import, edit, arm/disarm,
delete, configure settings/secrets, and run products. The main catalog contains
product metadata, non-sensitive settings, and status only. The separate ignored
`data\deals-secrets.local.json` file may contain the Target PIN and Discord
webhook; cookies, authentication, payment data, card details, addresses, and
checkout URLs are never stored by the CLI.

Quickest workflow:

```powershell
npm run deals
```

1. Choose **Paste/import grouped list** or **Add product**.
2. Select one explicit product mode: **Buy Now**, **Preorder**, or **Buy**.
   Blank or invalid import modes are rejected; type `cancel` to abort without
   saving.
3. Open **Settings** and set `target.max-item-price` and
   `target.max-order-total` before an active run.
4. In **Settings**, optionally store the Target PIN and required Discord
   webhook. They are masked unless **Reveal stored secrets** is selected.
5. Review the catalog table, then arm up to three Target products.
6. Choose **Start engine**. The initial default execution mode is
   `stop-before-submit`.

Grouped paste input uses headings ending in `:` and `Name: URL` product lines.
Missing `https://` is added before preview:

```text
30th Celebration:
Elite Trainer Box: howl.link/99668grkawccg
Poster Collection: https://www.target.com/p/example/-/A-1010892067

Other:
Future item: example.com/products/future
```

The preview is shown before the interactive import requires one product mode
and asks for armed state. Unsupported retailer URLs can be stored for future
adapters, but they cannot be armed or run.
Paste may contain blank separators between groups; submit two consecutive blank
lines to finish interactive input.

Direct commands use stable IDs; any unique ID prefix shown by `list` is
accepted:

```powershell
npm run deals -- list
npm run deals -- settings
npm run deals -- settings set target.max-item-price 49.99
npm run deals -- settings set target.max-order-total 60.00
npm run deals -- settings set target.expected-fulfillment shipping
npm run deals -- settings set target.default-run-mode observe
npm run deals -- secrets
npm run deals -- secrets set target.pin "<value>"
npm run deals -- secrets set discord.webhook-url "<value>"
npm run deals -- secrets show
npm run deals -- secrets clear target.pin
npm run deals -- add --name "Elite Trainer Box" --group "30th Celebration" --url "howl.link/99668grkawccg" --mode preorder
npm run deals -- import --file ".\products.txt" --mode buy --disarmed
Get-Content ".\products.txt" | npm run deals -- import --mode buy-now --armed
npm run deals -- edit abc123 --name "Updated name" --mode buy
npm run deals -- arm abc123 def456
npm run deals -- disable abc123
npm run deals -- remove abc123
npm run deals -- monitor --execution observe-only
npm run deals -- run --execution stop-before-submit
npm run deals -- monitor --execution live-purchase
npm run deals -- monitor --execution observe-only --no-solver
```

`enable`/`disable` are aliases for `arm`/`disarm`, and `run` is an alias for
`monitor`. Direct import requires `--mode buy-now`, `--mode preorder`, or
`--mode buy` and reads either `--file` or piped stdin. Target runs enable the
bundled `./target-challenge-solver.js` by default. Use `--no-solver` (or
`--no-challenge-solver`) to disable it; `--solver` and `--challenge-solver`
explicitly enable it.

### Target settings

Non-sensitive settings are stored under the top-level `settings.target` object
in version 2 of `data\deals.json`. Existing version 1 catalogs are read with
Target defaults and are upgraded on the next write. Use the interactive
**Settings** menu or:

```powershell
npm run deals -- settings
npm run deals -- settings set target.<key> <value>
```

| Key | Default | Validation |
|---|---:|---|
| `target.default-run-mode` | `stop-before-submit` | `observe`, `stop-before-submit`, or `live` |
| `target.max-item-price` | `unset` | Positive decimal; required for active runs |
| `target.max-order-total` | `unset` | Positive decimal; required for active runs |
| `target.expected-fulfillment` | `unset` | `shipping`, `delivery`, `pickup`, `drive-up`, or `unset` |
| `target.poll-interval-ms` | `5000` | Integer from `1500` through `1952257860` (jitter-safe Node timer maximum) |
| `target.browser-driver` | `patchright` | `patchright` or `playwright` |
| `target.solver-enabled` | `true` | Boolean |
| `target.solve-attempts` | `3` | Integer, minimum `1` |
| `target.settle-ms` | `1500` | Integer from `500` through `2147483647` |
| `target.hold-ms` | `10000` | Integer from `100` through `15000` |
| `target.timeout-ms` | `20000` | Integer from `1000` through `45000`, and at least hold plus `1000` |
| `target.challenge-backoff-ms` | `300000` | Integer from `60000` through `2147483647` |
| `target.challenge-max-backoff-ms` | `1800000` | Integer through `2147483647`, and at least both base and cart-rate-limit backoffs |
| `target.cart-rate-limit-backoff-ms` | `60000` | Integer from `60000` through `2147483647` |
| `target.max-polls` | `0` | Non-negative integer; `0` is unlimited |
| `target.max-runtime-ms` | `0` | Integer from `0` through `2147483647`; `0` is unlimited |

Use `unset` for optional price or fulfillment values. The CLI maps these
settings to the existing `TARGET_*` worker environment names. Existing
challenge timing/attempt environment overrides remain higher-priority for
compatibility; other non-sensitive worker values come from the catalog
settings. Inherited overrides are validated against the same limits and
cross-setting relationships before the worker starts.

### Local secrets

Only `target.pin` and `discord.webhook-url` can be stored. They are written
atomically to `data\deals-secrets.local.json`, which is excluded by
`.gitignore`. This file is **plaintext** and is protected only by the user's
Windows account and filesystem permissions. Never commit, share, attach, or
copy it into logs or support reports. No encryption or operating-system
keychain is used.

The normal Settings screen and `npm run deals -- secrets` mask stored values and
show whether a process-environment override is present. The explicit
`npm run deals -- secrets show` command and **Reveal stored secrets** menu action
print the stored values; use them only in a private terminal. Secret-setting
commands confirm the key but do not echo the supplied value. Supplying a value
on the command line can still place it in shell history, so the interactive
Settings menu is safer for routine entry.

At runtime, explicit `TARGET_PIN` and `DISCORD_WEBHOOK_URL` process environment
values take precedence for that run. Otherwise the adapter copies the stored
values into the child environment. `DISCORD_WEBHOOK_URL` is required for active
runs; `TARGET_PIN` is needed only if Target requests it. Neither value is copied
to `data\deals.json` or included in status parsing.

Product modes map to the Target worker as follows:

| CLI label | Catalog mode | Target worker argument |
|---|---|---|
| Buy Now | `buy-now` | `buy-now=url` |
| Preorder | `preorder` | `preorder=url` |
| Buy | `buy` | `add-to-cart=url` |

Execution modes, selectable per run or through
`target.default-run-mode`:

- `observe-only`: sets `TARGET_MONITOR_OBSERVE_ONLY=1`; no purchase input is
  allowed by `target-watch.js`. When bundled challenge recovery is enabled, the
  CLI also sets `TARGET_CHALLENGE_VALIDATE=1` so independently verified
  recovery may resume polling.
- `stop-before-submit` (default): active cart/checkout execution is allowed,
  but `TARGET_STOP_BEFORE_SUBMIT=1` stops after purchase validation and before
  Place order.
- `live-purchase`: leaves both gates unset and can submit a real order.

Interactive engine runs ask whether to use bundled Target Press & Hold recovery
and default to the persisted `target.solver-enabled` setting, initially
**yes**. The CLI sets `TARGET_CHALLENGE_SOLVER` to
`./target-challenge-solver.js`; disabling recovery removes both that setting and
`TARGET_CHALLENGE_VALIDATE` from the child environment. Existing
`TARGET_CHALLENGE_SOLVE_ATTEMPTS`, `TARGET_CHALLENGE_SETTLE_MS`,
`TARGET_CHALLENGE_HOLD_MS`, `TARGET_CHALLENGE_TIMEOUT_MS`, and challenge-backoff
overrides are inherited unchanged. Solver input, independent clearance
verification, mutation serialization, stale-state invalidation, and backoff
remain owned by `target-watch.js` and the existing challenge modules.

Active modes validate that the stored `target.max-item-price` and
`target.max-order-total` settings are configured and that the environment-only
or locally stored `DISCORD_WEBHOOK_URL` secret is present before the Target
worker is spawned. `TARGET_PIN` remains optional until Target actually requests
it. Secret values are not printed during normal operation. All Target checkout
validation and submission safeguards remain owned by `target-watch.js` and
`target-checkout.js`.

Target permits at most three armed catalog items. The catalog itself may contain
unlimited disarmed products. Only one retailer adapter process runs at a time
because all workers share the same Chrome profile, cart, payment state, and
session. Press Ctrl+C to stop the active child process; the catalog records an
`interrupted` terminal outcome.

The compact list displays armed state, retailer, product mode, name, group,
last status/time, and the raw URL. Windows Terminal receives an OSC 8 hyperlink
while the URL text remains visible. Common statuses mean:

- `Not run`, `Starting ...`, `Monitoring`, `Available`, or `Unavailable`:
  ordinary setup/polling state.
- `Action available`, `Added to cart; checkout started`, or
  `Buy Now checkout opened`: Target reached the corresponding guarded worker
  state; none alone means an order was confirmed.
- `Verification backoff`, `Rate-limit backoff`, `Purchase result unconfirmed`,
  or `Safety stop: ...`: input or progress stopped/paused fail closed; inspect
  the streamed worker output.
- `Verification detected` and `Verification solved after ...`: the existing
  Target challenge driver detected a supported challenge and later recorded
  independently verified clearance. A solve is not purchase confirmation.
- `Order confirmed`: the worker emitted explicit Target confirmation evidence.
- `Worker failed`, `stopped`, or `interrupted`: terminal without confirmed
  purchase.

Retailer behavior is registered in `src\deals-adapters.js`. A future retailer
requires one registry entry defining URL matching/metadata, supported modes and
armed limit, execution-mode normalization, environment validation, worker
command construction, output parsing, run-option prompts, and its namespaced
settings definition. The settings definition supplies defaults,
validation, display rows, secret-presence rows, and run validation. Catalog
CRUD, menus, direct commands, status persistence, settings commands, and
single-adapter execution do not require retailer-specific rewrites.

## Development harness (pi)

The project-local [pi harness](./.pi/README.md) provides `/deals` for scoped planning, implementation, review, and follow-up fixes. It uses offline checks by default and does not launch workers, connect to CDP, or authorize purchases. See its guide for trust/setup, agent roles, and validation commands.

## Start Chrome for Playwright

If your existing Chrome already exposes CDP on `127.0.0.1:9444`, reuse it; do not create a new profile or restart it just to run the worker. The Target URL watch opens its own product tabs in that existing context and retains its authentication/cookies.

Only when CDP is not already available, restart the intended Chrome profile with remote debugging enabled. Chrome must be completely closed before that startup step because startup-only CDP flags are ignored when another browser process for that profile is already running.

```powershell
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$userData = "$env:LOCALAPPDATA\Google\Chrome\User Data"

Start-Process -FilePath $chrome -ArgumentList `
  "--user-data-dir=$userData", `
  '--profile-directory=Default', `
  '--remote-debugging-port=9444', `
  '--remote-allow-origins=*', `
  '--restore-last-session'
```

Confirm CDP is available:

```powershell
Invoke-RestMethod 'http://127.0.0.1:9444/json/version'
```

## Target URL availability watch

Install the Discord Python dependency once:

```powershell
npm run discord:install
```

Pass one to three Target product URLs or supported `howl.link`/`goto.target.com` short URLs. Existing bare URLs retain automatic cart-action selection (`Preorder`, then `Add to cart`). Use an explicit `buy-now=url` job to select Buy now; the worker will not choose Buy now for a bare URL. Explicit `preorder=` and `add-to-cart=` prefixes are also accepted.

Set fail-closed price limits before an active run. Keep the Discord webhook and PIN only in the process environment:

```powershell
$env:DISCORD_WEBHOOK_URL = '<your Discord webhook URL>'
$env:TARGET_MAX_ITEM_PRICE = '49.99'
$env:TARGET_MAX_ORDER_TOTAL = '60.00'
$env:TARGET_EXPECTED_FULFILLMENT = 'shipping' # optional
npm run target:watch -- `
  'preorder=https://www.target.com/p/example/-/A-1010892076' `
  'buy-now=https://www.target.com/p/example/-/A-1010892065'
```

The URL watch worker:

1. Rejects non-Target URLs, unknown modes, conflicting duplicate products, and more than three jobs.
2. Opens one authenticated browser tab per product, with staggered startup.
3. Discovers and captures the page-owned fulfillment request. The current Target page uses a POST to `cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules`; legacy Redsky GET responses remain supported.
4. Queues all product polls through one global gate so only one fulfillment request is in flight at a time; the cooldown starts after the prior request finishes and still applies when that request fails.
5. Uses a five-second global cooldown by default, with ±10% jitter, so the monitor checks products in a serialized round-robin rather than issuing parallel requests.
6. Requires the current visible and enabled control matching the configured mode; a network signal or a different purchase control cannot authorize a click.
7. Claims the in-memory transaction owner before purchase input so only one product in this worker can enter checkout.
8. Keeps one blank dedicated checkout tab ready without loading an empty checkout. After confirmed Preorder/Add-to-cart evidence, only that distinct tab navigates to `/checkout`. Buy now remains on its original product tab for the full side-panel transaction.
9. Preserves the existing cart handshake, `Item not added to cart` ordering, challenge handling, and shared cart-rate-limit pause behavior. If cart input may have been sent but the result is uncertain, the owning product remains exclusive and reconciles before another purchase action can run.
10. Tracks checkout progress with bounded recovery. Sign-in, payment-setup, unavailable-item, empty-cart, unexpected-cart, exhausted recovery, and disappearing Buy-now-panel states stop fail closed. It does not configure accounts, addresses, or payment methods.
11. Reacquires replaced high-demand, shipping, and PIN controls from a fresh snapshot. High-demand and Place-order checks retain the 500 ms human-scale wait.
12. Before the only permitted Place-order click, validates exactly one expected TCIN, quantity one, a detected fulfillment method (and configured match), one unambiguous item price, one unambiguous order total, and both configured maximums. The same validator applies to cart checkout and Buy now.
13. If Place order may have been sent but confirmation is not explicit, the checkout stops as ambiguous and does not click Place order again.
14. Observes Target's `cart_items` mutation and cart-reconciliation responses around each Add-to-cart/Preorder click instead of relying only on a fixed DOM delay. It logs status and elapsed time without persisting request bodies, headers, cookies, or keys.
15. Treats any cart-service 429 as the existing shared-session circuit breaker and preserves the existing challenge-recovery contract.

Purchase configuration:

- `TARGET_PIN`: required at runtime if Target asks for the debit-card PIN. Keep it only in the process environment.
- `TARGET_MAX_ITEM_PRICE`: required for active purchasing; positive decimal maximum for the single expected item.
- `TARGET_MAX_ORDER_TOTAL`: required for active purchasing; positive decimal maximum for the complete order.
- `TARGET_EXPECTED_FULFILLMENT`: optional exact guard: `shipping`, `delivery`, `pickup`, or `drive-up`. Fulfillment must still be detected when this is unset.

Optional controls:

- `TARGET_BROWSER_DRIVER`: `patchright` by default; set to `playwright` for the `playwright-core` fallback.
- `TARGET_MAX_CONCURRENT`: lower the job cap; hard maximum is `3`.
- `TARGET_MONITOR_POLL_MS`: global cooldown after each request; default `5000`, minimum `1500`.
- `TARGET_CART_HANDSHAKE_TIMEOUT_MS`: maximum wait for the cart mutation/reconciliation response pair after Add to cart or Preorder; default `5000`, minimum `1000`.
- `TARGET_CART_RATE_LIMIT_BACKOFF_MS`: initial shared-session cooldown after a cart-service 429; default and minimum `60000`. A longer `Retry-After` takes precedence.
- `TARGET_STOP_BEFORE_SUBMIT`: set to `1` to stop terminally after all purchase validation succeeds and before Place order is clicked.
- `TARGET_DOM_REFRESH_EVERY`: refresh the product page after this many API polls; default `20`.
- `TARGET_CHALLENGE_BACKOFF_MS`: initial challenge cooldown; default `300000`.
- `TARGET_CHALLENGE_MAX_BACKOFF_MS`: maximum exponential cooldown; default `1800000`.
- `TARGET_CHALLENGE_SOLVER`: path or package name of a pluggable challenge solver module exporting `solveChallenge(context)`. When unset, a detected challenge only pauses the monitor. See `TARGET-CHALLENGE-SOLVER-HANDOVER.md`.
- `TARGET_CHALLENGE_SOLVE_ATTEMPTS`: maximum solve attempts per challenge; default `3`. Attempts run consecutively within one recovery cycle; the backoff ladder applies after that cycle fails, not between every attempt. The bundled solver does not automatically refresh between attempts.
- `TARGET_CHALLENGE_SETTLE_MS`: wait before re-verifying the page after each normally completed solve attempt; default `1500`. Thrown attempts are retried without this wait.
- `TARGET_CHALLENGE_HOLD_MS`: bundled solver's maximum continuous hold; default `10000`, integer range `100`–`15000`. It releases early when the held control disappears.
- `TARGET_CHALLENGE_TIMEOUT_MS`: bundled solver's per-attempt action budget; default `20000`, integer range `1000`–`45000`, at least the hold duration plus `1000`. Cleanup has up to `1000` ms for release and `500` ms for handle disposal beyond this budget. A lost browser connection can prevent release; that attempt fails closed.
- `TARGET_CHALLENGE_VALIDATE`: set to `1` only with observe-only mode and a configured solver to allow an API challenge to recover and polling to resume. Unresolved challenges and unrelated HTTP/fetch/parse errors still stop the run; success never overrides poll/time limits.
- `TARGET_MONITOR_MAX_RUNTIME_MS`: optional runtime limit, default `0` (unlimited). Checked between operations; an in-flight navigation/solve may finish after this deadline.
- `TARGET_MONITOR_KEEP_PAGE`: set to `1` in observe-only mode to preserve diagnostic tabs when the monitor exits normally. No input or monitoring continues after exit.
- `TARGET_MONITOR_OBSERVE_ONLY`: set to `1` to disable Discord and every Preorder/Add-to-cart/Buy-now click during cadence testing.
- `TARGET_MONITOR_MAX_POLLS`: stop after this many fulfillment API responses; `0` means unlimited.

Run a bounded, non-purchasing cadence sample with one product:

```powershell
$env:TARGET_MONITOR_OBSERVE_ONLY = '1'
$env:TARGET_MONITOR_MAX_POLLS = '30'
$env:TARGET_MONITOR_POLL_MS = '5000'
npm run target:watch -- 'https://howl.link/99668grkawccg'
```

`TARGET_STOP_BEFORE_SUBMIT=1` is a live operator safety gate, not an offline test: product/cart input may still occur, but the validated Place-order control is not clicked. This repository's implementation checks do not run it.

The worker logs one `TARGET_API_POLL` JSON record per endpoint request and a final `TARGET_CALIBRATION_SUMMARY` with status counts, challenge/error counts, latency percentiles, and maximum queue concurrency. By default, observe-only calibration stops on the first challenged API response, HTTP error, fetch failure, or malformed response. A configured solver can recover a page-level challenge before any challenged API poll is recorded. The explicit `TARGET_CHALLENGE_VALIDATE=1` mode additionally permits independently verified recovery from challenged API polls. Test slower cooldowns first and compare separate bounded runs; do not automatically ramp request frequency within one session.

Initial isolated-profile calibration on 2026-09-18 completed 100 requests across three products at the 1.5-second minimum cooldown with 99 HTTP 200 responses, one parseable HTTP 206 response, no challenge, no fetch error, and maximum request concurrency of one. A separate Patchright observe-only validation against available TCIN `1007918679` produced five HTTP 200 responses, consistently classified shipping as `IN_STOCK`, and found an enabled `Add to cart` control on every inspection without clicking it. This is bounded evidence, not a guaranteed safe rate for long-running or authenticated sessions. The production default is five seconds because archived multi-tab runs showed synchronized page traffic and sustained cart-service 429 responses.

No cadence can guarantee that Target will not challenge or throttle the browser. The conservative defaults, browser-context requests, global serialization, and circuit breaker minimize unnecessary traffic; configuring a solver does not justify raising request rates.

### Optional Target press-and-hold recovery

**Maintaining the code?** Start with [the developer guide](./TARGET-CHALLENGE-DEVELOPER-GUIDE.md) for the module map, control flow, queue ownership, timeout/cleanup rules, log meanings, and test/evidence boundaries. Shared interfaces and non-obvious decisions are also documented in the source.

`target-challenge-solver.js` is opt-in when `target-watch.js` is invoked directly;
the `deals` control plane enables the bundled solver by default and provides an
explicit disable option. **A bounded real-Target integration run now confirmed
`TARGET_CHALLENGE_SOLVED` followed by two fresh HTTP 200 availability
responses.** Retrying a preserved `Please try again` state succeeded on the
first retry without a challenge refresh. That diagnostic used an isolated
unauthenticated browser, a nonstandard user agent/automation flag, and a
45-second attempt budget; it does not establish default-budget or normal
authenticated-session reliability. Earlier attempts failed, and the initial
delayed-clearance run must not be confused with this later passing run. It finds
a unique visible/enabled control in the page or visible nested/cross-origin
frames, including frames inside closed shadow roots, uses native pointer input,
attempts release in `finally`, and returns control to the independent
verification driver. Both `Press & Hold` and `Press and hold` labels are
supported. Generic CAPTCHA/access-denied pages, ambiguous controls, and
unreadable states are not treated as solved. It does not use test tokens, alter
cookies, synthesize DOM events, or delete challenge markup. Frame discovery
checks the browser-native frame tree and ancestor visibility to exclude hidden
copies. After releasing input it waits for live clearance within the remaining
`TARGET_CHALLENGE_TIMEOUT_MS` budget, not merely for the button label to
disappear; the driver then independently verifies again.

For operational verification, use the existing authenticated CDP profile without changing its user agent, cookies, or automation flags. Separate profiles and unusual browser settings were used only for the recorded trigger experiments; they are not required by the solver and do not isolate IP reputation.

Stop other workers sharing the profile before a bounded diagnostic run. This example never clicks Add to cart or Preorder:

```powershell
$env:TARGET_MONITOR_OBSERVE_ONLY = '1'
$env:TARGET_CHALLENGE_VALIDATE = '1'
$env:TARGET_CHALLENGE_SOLVER = './target-challenge-solver.js'
$env:TARGET_CHALLENGE_SOLVE_ATTEMPTS = '2'
$env:TARGET_CHALLENGE_TIMEOUT_MS = '45000'
$env:TARGET_MONITOR_POLL_MS = '5000'
$env:TARGET_MONITOR_MAX_POLLS = '2'
$env:TARGET_MONITOR_MAX_RUNTIME_MS = '120000'
$env:TARGET_MONITOR_KEEP_PAGE = '1'
npm run target:watch -- 'https://www.target.com/p/-/A-1007918679'
```

A successful test requires `TARGET_CHALLENGE_SOLVED` followed by a successful `TARGET_API_POLL` with a valid availability response. No challenge appearing means **not exercised**, not success. Do not hammer Target search or Redsky to force verification. Deterministic real-provider testing requires an authorized HUMAN tenant and its official testing process; a testing-token result is not proof of production Target recovery.

Local tests launch an isolated installed Chrome, never CDP or your authenticated profile. All HTTPS traffic in the browser suite is intercepted locally, including mock Target API responses:

```powershell
npm run check
npm run test:unit
npm run test:challenge:e2e
$env:TARGET_BROWSER_DRIVER = 'playwright'
npm run test:challenge:e2e
Remove-Item Env:TARGET_BROWSER_DRIVER -ErrorAction SilentlyContinue
```

Disable optional recovery before restarting a worker with:

```powershell
Remove-Item Env:TARGET_CHALLENGE_SOLVER, Env:TARGET_CHALLENGE_VALIDATE -ErrorAction SilentlyContinue
```

This restores pause/backoff-only handling. Existing Target checkout/preorder, Amazon, and Pokémon Center manual-verification policies are unchanged. See `TARGET-CHALLENGE-SOLVER-HANDOVER.md`, `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md`, and `SESSION-LEARNINGS.md` for the solver contract, observed trigger sequences, evidence limits, and actual results.

### Conservative preorder discovery

Do not crawl multiple Target search/category pages to discover preorder products. Rapid full-page search navigation triggered a visible verification challenge during testing even though the serialized fulfillment polling runs did not.

Run one search query:

```powershell
npm run target:discover-preorder -- "pokemon preorder"
```

The discovery command performs one search-page navigation, waits for rendering, stops immediately on verification evidence, and prints deduplicated `TARGET_PREORDER_CANDIDATE` URLs from product cards explicitly labeled Preorder. It does not paginate, open product pages, add items, or solve challenges. A persisted local cooldown prevents another discovery navigation for 15 minutes; `TARGET_DISCOVERY_COOLDOWN_MS` may increase that interval but cannot reduce it below five minutes. Validate any returned URL with `TARGET_MONITOR_OBSERVE_ONLY=1` before enabling purchase actions.

## Target checkout

Provide the card PIN only through the process environment. Do not add it to source files, command scripts, or documentation.

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
$env:TARGET_PIN = '<your PIN>'
npm run target:checkout
```

The checkout worker:

1. Opens `https://www.target.com/checkout`.
2. Returns to checkout if Target redirects to `/cart`.
3. Pauses for manual completion of CAPTCHA or verification challenges.
4. Dismisses high-demand dialogs that contain an OK button.
5. Ignores non-modal busy banners and continues checkout actions.
6. Repeatedly clicks Save and continue when available.
7. Enters `TARGET_PIN` in the Confirm your PIN dialog.
8. Clicks Place order or Place your order.
9. Refuses to submit an empty cart or a cart containing an unrecognized Target product.
10. Retries high-demand, PIN, and order states until an explicit confirmation is detected.

Do not run multiple checkout workers. They share one cart and payment state and
can submit duplicate orders or trigger anti-automation verification.

## Target preorder monitoring

Configured products:

The complete short-link and resolved Target URL catalog is recorded in
[`data/target-products.json`](./data/target-products.json):

- `A-1010892076`: Elite Trainer Box
- `A-1010892065`: Greninja ex Box
- `A-1010892068`: Sylveon ex Box
- `A-1010892078`: Tech Sticker Collection
- `A-1010892067`: Poster Collection
- `A-1010892069`: Tin
- `A-1010892070`: Knock Out Collection
- `A-1012422107`: Mini Tins
- `A-1011407490`: Booster Bundle
- `A-1010892075`: Battle Deck - Espeon ex
- `A-1010892071`: Battle Deck - Umbreon ex

Monitor all configured products:

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
Remove-Item Env:PRODUCT_FILTER -ErrorAction SilentlyContinue
npm run target:preorder
```

Monitor one product:

```powershell
$env:PRODUCT_FILTER = 'A-1011407490'
npm run target:preorder
```

Monitor selected products:

```powershell
$env:PRODUCT_FILTER = 'A-1010892075,A-1010892071'
npm run target:preorder
```

The preorder worker:

1. Opens one reusable tab per selected product, staggered by 1 second by default.
2. Monitors the live product page and Target fulfillment responses in-browser to detect the availability signal before the DOM fully re-renders.
3. Waits up to 3 seconds for Add to cart or Preorder to render.
4. Clicks the available purchase action and waits 5 seconds for the result.
5. Closes Item not added to cart dialogs before retrying.
6. Closes that product tab after a cart-add success signal.
7. Pauses on a verification challenge for manual completion.
8. Closes all active product tabs before reconnecting after an error.

The monitoring loop favors browser-attached fulfillment polling over blind page reloads so the worker stays inside the authenticated Target session and avoids noisy direct polling outside the browser context.

Set `TARGET_PRODUCT_STAGGER_MS` or `TARGET_POLL_DELAY_MS` only when you
deliberately need different polling cadence. The default polling cadence is
conservative to reduce Target verification triggers.

## Pokémon Center monitoring

The deduplicated Pokémon Center catalog is recorded in
[`data/pokemoncenter-products.json`](./data/pokemoncenter-products.json).
Run the monitor with the authenticated Chrome profile:

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
$env:POKEMONCENTER_PRODUCT_FILTER = '10-10447-111'
npm run pokemoncenter:preorder
```

Omit `POKEMONCENTER_PRODUCT_FILTER` to monitor the full deduplicated catalog.

The Pokémon Center worker:

1. Opens one reusable tab per unique configured product.
2. Detects enabled Add to Cart or Pre-Order actions only within the product area.
3. Serializes cart and checkout actions because Pokémon Center uses one shared cart.
4. Verifies the expected SKU/title and visible order total before submission.
5. Pauses on hCaptcha or an Imperva block for manual completion or cooldown.
6. Stops remaining Pokémon Center tabs after explicit order confirmation or an unconfirmed submission attempt.
7. Closes product tabs on completion, reconnect, or error.

### CAPTCHA and anti-bot behavior

Pokémon Center's CDN (Imperva/Incapsula) may present an **hCaptcha** checkbox
challenge, or escalate to a temporary **"Access is temporarily restricted"**
block. Key facts:

- The hCaptcha checkbox is hosted in a cross-origin frame nested inside an
  Incapsula wrapper iframe.
- The worker must leave checkbox and image-tile challenges untouched for the
  user to complete manually.
- Rapid repeated requests cause Imperva to escalate from a checkbox to a hard
  temporary block. Keep polling cadence conservative. Set
  `POKEMONCENTER_RETRY_DELAY_MS` (default **10000**) and
  `POKEMONCENTER_PRODUCT_STAGGER_MS` (default **3000**) only to increase delays,
  never to speed the worker up.

Do not integrate automated CAPTCHA solving. Resume monitoring only after the
challenge has been completed manually and the normal retailer page is visible.

## Amazon preorder

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
$env:AMAZON_PRODUCT_URL = '<Amazon product URL>'
$env:AMAZON_EXPECTED_ASIN = '<10-character Amazon ASIN>'
$env:AMAZON_EXPECTED_TITLE = '<exact expected product title>'
$env:AMAZON_MAX_ITEM_PRICE = '30'
$env:AMAZON_MAX_ORDER_TOTAL = '40'
npm run amazon:preorder
```

The Amazon preorder worker:

1. Opens the supplied product URL.
2. Clicks Pre-order now when enabled.
3. If the direct button is absent, opens See All Buying Options or falls back to Amazon's offer-listing page.
4. Selects only an offer that is both shipped from and sold by Amazon and does not exceed `AMAZON_MAX_ITEM_PRICE`.
5. Rejects direct Pre-order now offers unless their buy box also confirms Amazon as both shipper and seller within the price limit.
6. Selects only the expected ASIN in the active cart and deselects every other cart item.
7. Refuses to enter checkout or place an order unless the expected ASIN or exact expected title is present.
8. Refreshes and retries when no qualifying Amazon offer is available.
9. Clicks Go back when Amazon reports that the item is currently unavailable.
10. Returns to the product page and retries after a conservative delay.
11. Clicks Continue or Continue shopping on Amazon retry/interstitial pages.
12. Pauses for manual completion of robot checks or CAPTCHA challenges.
13. Blocks final submission unless the checkout order total is detected and does not exceed `AMAZON_MAX_ORDER_TOTAL`.
14. Proceeds to checkout and clicks Place your order when checkout becomes usable.
15. Stops only after detecting an Amazon order confirmation.

## Amazon multi-product monitoring

Use the multi-product worker when several Amazon product pages must remain
active at once:

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
$env:AMAZON_PRODUCTS_JSON = @'
[
  {
    "label": "Poster Collection",
    "url": "https://www.amazon.com/dp/B0H77W4411",
    "asin": "B0H77W4411",
    "title": "Pokémon TCG: 30th Celebration Poster Collection"
  },
  {
    "label": "Greninja & Sylveon ex Boxes",
    "url": "https://www.amazon.com/dp/B0H7818RCM",
    "asin": "B0H7818RCM",
    "title": "Pokémon TCG: 30th Celebration Pokémon ex Box"
  },
  {
    "label": "Tech Sticker Collections",
    "url": "https://www.amazon.com/dp/B0H77VZBX4",
    "asin": "B0H77VZBX4",
    "title": "Pokémon TCG: 30th Celebration Tech Sticker Collection"
  },
  {
    "label": "Knockout Collection",
    "url": "https://www.amazon.com/dp/B0H7FDBNSB",
    "asin": "B0H7FDBNSB",
    "title": "Pokémon TCG: 30th Celebration Knock Out Collection"
  }
]
'@
$env:AMAZON_MAX_ITEM_PRICE = '30'
$env:AMAZON_MAX_ORDER_TOTAL = '40'
npm run amazon:multi-preorder
```

The multi-product worker opens one dedicated tab per product, refreshes each
tab independently, and serializes cart and checkout actions because all tabs
share the authenticated Amazon profile, cart, and payment state. It accepts
only offers both sold by and shipped from Amazon, keeps the configured price
limits, pauses for manual completion of verification challenges, and continues monitoring
the remaining tabs after each product's confirmed order.

## Amazon checkout

Amazon checkout URLs contain short-lived execution identifiers. Supply the current complete URL through the environment for each run; do not save it in source control.

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
$env:AMAZON_CHECKOUT_URL = '<current Amazon checkout URL>'
npm run amazon:checkout
```

The Amazon worker:

1. Opens the supplied checkout URL.
2. Refreshes once per second while quantity/update errors remain.
3. Pauses for manual completion of robot checks or CAPTCHA challenges.
4. Clicks Continue when the checkout flow requires it.
5. Clicks Place your order when enabled.
6. Stops only after detecting an Amazon order confirmation.

## Stopping workers

Use `Ctrl+C` in each process, or terminate the specific process that launched the worker. Do not kill every Chrome process just to stop a monitor; the scripts are separate Node.js processes attached to Chrome over CDP.
The multi-product worker leaves its dedicated Amazon tabs open when the Node
process stops.

## Important operational limits

- Verification challenges pause automation for manual completion unless the Target URL watch's optional press-and-hold solver is explicitly enabled. Failed or unsupported recovery still backs off; other workers remain manual.
- Target and Amazon may change labels, dialogs, URLs, or markup without notice.
- Multiple workers share one Chrome profile and cart, so their actions can affect one another.
- A successful click is not treated as a completed purchase. The checkout workers wait for explicit order-confirmation text or URL signals.
- Keep secrets and transient session URLs in process environment variables only.

## Target verification recovery

The Target verification incident occurred after repeated automated Preorder clicks. The first explicit report was around 1:44 AM local time, and verification was reported again around 1:47 AM after retries continued. This establishes the timing and action immediately preceding the challenge, but not the challenge vendor or exact CAPTCHA implementation. `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md` contains the complete incident sequence, search-navigation event, confirmed Redsky `Press & Hold` response, negative-control runs, and the evidence that was not preserved.

For the legacy Target checkout/preorder workers, or when automated recovery is unavailable, use manual recovery:

1. Pause the worker attached to the challenged tab. Unaffected Target workers may continue.
2. Leave the challenged page open in the authenticated Chrome profile.
3. Complete the verification manually in the authenticated Chrome profile.
4. Confirm that the challenge URL and challenge text have disappeared and the normal Target product or checkout page is visible.
5. Resume the challenged worker after its page clears.
6. Keep the product cadence conservative: wait up to 3 seconds for Preorder and 5 seconds after clicking.
7. If verification returns, pause that worker again. Stop all Target workers only if challenges spread across multiple tabs.

Legacy workers check their own page and pause independently. The Target URL watch instead pauses all of its product jobs on unresolved challenges; its optional solver runs on the shared mutation queue and checks the main page plus visible frames.

## Evidence

See [screenshots/README.md](./screenshots/README.md) for the complete screenshot index and the evidence boundary around the reported Target verification challenge.
