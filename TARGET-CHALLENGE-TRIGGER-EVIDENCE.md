# Target Challenge Trigger Evidence

**Last updated:** 2026-09-18  
**Purpose:** document exactly what activity preceded Target verification during prior preorder and availability research, distinguish the confirmed `Press & Hold` event from other verification reports, and define what evidence must be captured during the next live occurrence.

This document records observed behavior. It is not a deterministic trigger recipe: Target's risk decision depends on request history, browser/session state, cookies, client properties, endpoint, and undisclosed server-side policy.

## Summary

Four distinct incident types are relevant:

| Incident | Activity immediately before verification | Observed result | Confidence |
|---|---|---|---|
| Repeated preorder actions | Rapid repeated automated `Preorder` attempts in the authenticated Target browser session | Target verification was reported around 1:44 AM and again around 1:47 AM local time | Moderate: timing and preceding action are known; exact request count, cadence, page, and challenge presentation were not preserved |
| Preorder discovery navigation | Rapid sequential navigation across several Target search and category pages, including search URLs shaped like `https://www.target.com/s?searchTerm=pokemon%20preorder` | A visible verification challenge appeared | Moderate-high for the association; exact page sequence and threshold were not recorded |
| Bare Redsky endpoint probing | Approximately four to five sequential requests from a plain PowerShell HTTP client to a legacy Redsky fulfillment endpoint | JSON responses changed to a confirmed PerimeterX/HUMAN `Press & Hold` interstitial | High for this host and run; it does not establish a universal threshold or policy across Target hosts |
| Isolated nonstandard-user-agent browser | Bounded single-product navigations with `PhantomJS`; a later variant also enabled Chrome automation | Real challenge presentations, one no-challenge trial, a `Please try again` rejection, then same-run verified recovery and two fresh HTTP 200 polls on retry | High for the recorded input/recovery sequence; not a deterministic trigger or normal authenticated-session reliability claim |

The Redsky probe preserved provider response identifiers. The later isolated-browser test additionally preserved real challenge screenshots and the `Human verification challenge` iframe/`px-captcha` DOM structure. The earlier browser verification reports still must not be retroactively labeled as the same presentation with certainty.

## Incident 1: repeated preorder attempts

### Recorded sequence

1. The authenticated Chrome profile was already being used by Target monitoring/preorder automation.
2. Automated `Preorder` activity was repeated rapidly.
3. Around 1:44 AM local time, the user reported that Target verification appeared after the repeated preorder attempts.
4. Automation was slowed and challenge detection was added or strengthened.
5. Around 1:47 AM, verification was reported again while rapid Target activity and retries were still occurring.
6. Target workers were stopped so the session could recover.
7. After the user reported that verification had cleared, automation resumed with slower product staggering and challenge detection.

### What this establishes

- Rapid repeated preorder actions were temporally associated with verification twice in a short period.
- Continuing activity soon after the first event did not prevent recurrence.
- The shared authenticated profile means product tabs, cart operations, and checkout activity contributed to one session-level history rather than isolated per-tab histories.

### What was not captured

- Exact product URL or TCIN for each challenged attempt.
- Number of clicks, page loads, or requests before the first challenge.
- Precise spacing between attempts.
- HTTP status and response body that rendered the challenge.
- Challenge title, iframe URL, provider identifiers, screenshot, or DOM snapshot.
- Whether the second event was a new decision or persistence of the first challenged session.

Because those details are missing, this incident cannot supply a reliable automated reproduction threshold.

## Incident 2: preorder search/category discovery

### Recorded sequence

The research process navigated rapidly and sequentially across several Target search and category pages while looking for a live preorder product. One search shape used by the later conservative discovery tool is:

```text
https://www.target.com/s?searchTerm=pokemon%20preorder
```

A visible verification challenge appeared after the sequence. Earlier bounded fulfillment polling had not produced a challenge, so the observed difference was the pattern of full-page search/category navigation rather than serialized replay of one page-owned fulfillment request.

### What this establishes

- Search/category crawling was the clearest browser-side trigger pattern observed during this research.
- One URL alone is not known to trigger verification. The evidence concerns a sequence of navigations and accumulated session activity.
- The challenge led to the conservative `target-preorder-discovery.js` design: one search navigation per run, no pagination, no candidate-page crawl, stop on challenge evidence, and persisted cooldown.

### What was not captured

- Complete ordered URL list.
- Exact number of navigations and elapsed time.
- Network request count generated by each SPA page.
- Whether the session had residual risk from earlier preorder attempts or endpoint testing.
- Exact challenge response and provider evidence.

The search URL above is therefore a historical input, not a guaranteed test endpoint.

## Incident 3: confirmed Redsky `Press & Hold`

### Recorded sequence

A plain PowerShell `Invoke-WebRequest` client called the legacy endpoint shape:

```text
https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1
```

A complete request required runtime values such as an API key, TCIN, store ID, ZIP code, state, latitude, longitude, and required-store flags. The key was rotating and must not be hardcoded.

During the observed run:

1. Approximately four to five sequential requests returned normal JSON or endpoint-specific responses.
2. A subsequent request returned a PerimeterX block/interstitial instead of fulfillment JSON.
3. The response contained `Press & Hold` and these provider indicators:
   - `_pxAppId = PXGWPp4wUS`
   - `collector-PXGWPp4wUS.perimeterx.net`
   - `client.perimeterx.net/PXGWPp4wUS/main.min.js`

### What this establishes

- `redsky.target.com` was protected by PerimeterX/HUMAN during the run.
- A bare HTTP client without the authenticated browser's page context was challenged after a small number of sequential probes.
- The old assumption that Redsky could be polled freely outside the browser was false.

### What this does not establish

- That five requests is a fixed trigger threshold.
- That the same application ID or policy protects `www.target.com`, `carts.target.com`, or the modern CDUI endpoint.
- That repeating the sequence from another IP, profile, time, or product produces the same result.
- That the browser preorder challenges were necessarily served by the same provider or policy.

## Incident 4: isolated browser challenge and native hold (2026-09-18)

This was a bounded diagnostic test in an unauthenticated browser, not a change to
the authenticated profile or the monitor's production user agent. It made no
preorder/cart clicks, search crawl, or burst of bare HTTP requests. No testing
token, cookie injection, or challenge DOM modification was used.

### Recorded sequence (UTC)

1. **19:37:28–19:37:34:** one navigation to TCIN `1007918679` in a fresh browser
   context with user agent `PhantomJS` returned HTTP 200 HTML but rendered a real
   `Quick verification / Press & hold` modal. A challenge can therefore be present
   even when the main product document returns 200.
2. The original solver returned `CHALLENGE_CONTROL_NOT_FOUND` without pointer
   input. The screenshot showed the real control, but ordinary iframe-locator
   discovery did not expose it. That first harness closed its isolated browser.
3. After the five-minute failure cooldown, a dedicated unauthenticated diagnostic
   browser navigated to the same product once at **19:43:12** and again presented
   the challenge. The page was preserved for inspection and input.
4. Read-only inspection found the visible, enabled `role=button` control inside
   an iframe titled `Human verification challenge`, hosted in a closed shadow
   root, alongside hidden iframe copies. Browser-native frame enumeration exposed
   it; no coordinate hardcoding or DOM mutation was necessary.
5. **19:46:21–19:46:34:** after the frame-discovery fix passed local tests, the
   solver performed one native hold (10-second maximum, 20-second attempt budget).
   Logs included `TARGET_CHALLENGE_HOLD_STARTED` and `HOLD_FINISHED elapsedMs=10315`.
   The widget displayed a processing indicator. The driver's 1.5-second settle
   check still saw the challenge and correctly reported `unresolved` for that
   observation, then backoff. It did **not** log `TARGET_CHALLENGE_SOLVED`.
6. At **19:46:53**, a read-only observation found no challenge and the screenshot
   showed the normal product page. No further pointer input or navigation had
   been issued between the hold and this observation. Exact clearance latency
   within this observation interval was not measured.
7. The completion wait was corrected locally to wait for live clearance within
   the remaining attempt budget, rather than treating a disappearing control
   label/spinner as completion. Closed-shadow/hidden-copy and delayed-processing
   regression tests were added; 13/13 browser tests passed on both drivers.
8. After the failure cooldown, the same diagnostic session performed one normal
   product reload at **19:51:51** without another challenge. A fresh captured
   fulfillment request returned **HTTP 200**, valid availability JSON, at
   **19:52:01.295Z** (219 ms). User agent and cookies were not manually changed;
   no purchase action was taken. The final timing fix was not exercised by a
   new live hold because the session had already recovered.

### What this establishes—and does not

- A real Target browser challenge was triggered and visually preserved, and the
  page cleared after automated native input. Subsequent fresh server data worked.
- Both observations used a fresh/nonstandard-user-agent session. They do not prove
  which property caused the challenge, or guarantee that the same probe repeats.
- The original monitor attempt reported `unresolved` before delayed clearance.
  Do not fabricate a `TARGET_CHALLENGE_SOLVED` event or claim the strict same-run
  monitor-resume acceptance sequence passed. The revised completion wait still
  needs that live acceptance, particularly in a normal authenticated session.
- The permanent diagnostic browser was left open, with no Node monitor running.
  Screenshots redact/crop reference identifiers and location information; see
  [the evidence index](./screenshots/README.md#live-target-challenge-evidence-2026-09-18).

### Revised-solver live confirmation attempt (~19:59Z)

A fresh, unauthenticated diagnostic browser repeated one exact product navigation
with the nonstandard user agent, after the earlier session had recovered. The
revised solver was configured for one attempt, a 10-second maximum hold, a
45-second attempt budget, and up to two subsequent polls at a five-second cadence.
The product document returned **HTTP 200 without a challenge**. Five later
read-only observations, spaced five seconds apart from **19:59:35.459Z** through
**19:59:55.646Z**, also found no challenge; the `PhantomJS` user agent was explicitly
confirmed active. There were no additional navigations, no solver input, no replayed
API polls, and no observed cart-mutation requests.

Outcome: **`not_exercised_no_challenge`**, not passed. The same-run
`TARGET_CHALLENGE_SOLVED` → fresh successful poll gate remains open. This is direct
negative evidence against treating the nonstandard user agent as a deterministic
Target trigger. The test stopped without increasing traffic; the diagnostic page
was left open. Sanitized settings, counts, and follow-up observations are saved in
[the live confirmation report](./screenshots/target-live-confirmation-2026-09-18T19-58-58-091Z.json).

### Automation-signal variant (~20:05Z)

The next bounded probe retained `PhantomJS`, the same product, and a fresh
unauthenticated profile, but enabled Chrome's `--enable-automation` flag. Runtime
inspection confirmed both the configured user agent and `navigator.webdriver=true`.
One product navigation returned HTTP 200 and displayed a real press-and-hold
challenge at **20:05:00.569Z**, more than five minutes after the previous probe.
No request-rate increase, search crawl, or cart action was used.

The revised solver issued one pointer-down and one pointer-up with a 10-second
maximum hold, then waited within its 45-second attempt budget. At **20:05:47Z**,
independent verification still found the challenge; the screenshot explicitly
showed **`Please try again`**, not merely a processing spinner. The driver reported
`unresolved`, activated 300000 ms backoff, and did not resume polling.

This trial establishes a successful trigger observation and a **failed solve**,
not a deterministic trigger or proof that the automation flag alone caused either
outcome. The page was preserved. See the
[structured report](./screenshots/target-live-automation-signal-2026-09-18T20-04-55-751Z.json),
[before image](./screenshots/target-live-automation-signal-2026-09-18T20-04-55-751Z-before.png),
and [retry-message image](./screenshots/target-live-automation-signal-2026-09-18T20-04-55-751Z-unresolved.png).

### Same-run retry confirmation: passed (~20:11–20:12Z)

The preserved `Please try again` page was retried without changing its user agent,
automation flag, cookies, or DOM. The preceding failure cooldown had already
expired. The diagnostic harness allowed two consecutive attempts, with one refresh
before attempt 2 only if necessary—no extra five-minute delay between those attempts.

**The first retry succeeded. The retry-refresh fallback was never used.** The
harness called the existing native solver, `handleChallenge()` verification driver,
and serialized request queue; no verification or backoff logic was bypassed.

| UTC | Actual event |
|---|---|
| 20:11:28.545 | `TARGET_CHALLENGE_DETECTED kind=press_and_hold`, attempt 1/2 |
| 20:11:28.905 | `TARGET_CHALLENGE_HOLD_STARTED` |
| 20:11:42.748 | `TARGET_CHALLENGE_HOLD_FINISHED elapsedMs=14054` (input plus completion waiting, not a 14-second continuous hold) |
| 20:11:45.721 | `TARGET_CHALLENGE_CLEARED after=1` and `TARGET_CHALLENGE_SOLVED` |
| 20:12:00.059 | Fresh valid availability JSON, HTTP 200, 198 ms |
| 20:12:05.465 | Second valid availability JSON, HTTP 200, 217 ms |

The run used a 10-second maximum hold, a 45-second attempt budget, a 1500 ms driver
settle interval, and 5000 ms polling cadence. There was exactly one pointer-down/up
pair, zero retry refreshes, one post-clearance product reload to recapture the
request template, and no purchase clicks or observed cart mutations. Queue maximum
concurrency was one. Default production backoff and timeout settings were unchanged.

One additional diagnostic inspection immediately after the solved event returned
`unreadable`; that observation was not treated as clearance. The driver's own
verification had passed, the subsequent fresh-navigation and final inspections
were clean, both polls returned valid data, and two later read-only checks at
20:13:31Z and 20:13:36Z were also clean. The raw report retains that transient state.

The required same-run event sequence is now **observed in an isolated real-Target
integration run**. This does not establish long-running reliability, performance
with the default 20-second budget, an authenticated production-profile result,
or success of the unexercised refresh fallback. The refresh-before-second-attempt
policy was local to the diagnostic harness; it was not added to the bundled solver.

Evidence: [structured report](./screenshots/target-live-retry-refresh-2026-09-18T20-11-28-193Z.json),
[before](./screenshots/target-live-retry-refresh-2026-09-18T20-11-28-193Z-attempt-1-before.png),
[after input](./screenshots/target-live-retry-refresh-2026-09-18T20-11-28-193Z-attempt-1-after.png),
and [final recovered page](./screenshots/target-live-retry-refresh-2026-09-18T20-11-28-193Z-final.png).

## Negative-control evidence

The following bounded tests did **not** trigger verification:

- 20 serialized browser-context requests at a five-second cooldown: 20 HTTP 200 responses.
- 20 at three seconds: 19 HTTP 200 responses and one parseable HTTP 206.
- 20 at two seconds: 20 HTTP 200 responses.
- 20 at 1.5 seconds: 20 HTTP 200 responses.
- Three products, globally serialized, 1.5-second cooldown: 99 HTTP 200 responses and one parseable HTTP 206 across 100 requests.
- Later solver-enabled observe-only runs: six HTTP 200 polls for unavailable TCIN `1010892076` and five HTTP 200 polls for available TCIN `1007918679`, with no challenges.

These samples show that the prior challenge was not reproduced by globally serialized in-browser fulfillment polling under the tested conditions. They do not prove long-duration or drop-time safety.

## Reproduction and testing implications

### Deterministic local test

Use the repository fixture and browser integration suite:

```text
file:///F:/Repos/personal/temp/PokemonDeals/tests/fixtures/target-press-and-hold.html
```

```powershell
npm run test:challenge:e2e
```

This validates native pointer hold, cross-origin/nested frame traversal, independent post-solve verification, request-template reset, resumed polling, bounded retries, and pointer cleanup. It does not validate Target's live PerimeterX deployment.

### Real-provider acceptance test

A production claim requires one of these:

1. An authorized HUMAN/PerimeterX integration environment where the tester controls the challenge policy and testing token; or
2. A naturally occurring Target challenge during a bounded observe-only run.

For a natural Target occurrence, preserve the page and allow the configured solver to run. Success requires:

1. `TARGET_CHALLENGE_DETECTED kind=press_and_hold`
2. `TARGET_CHALLENGE_HOLD_STARTED`
3. `TARGET_CHALLENGE_CLEARED`
4. `TARGET_CHALLENGE_SOLVED`
5. A later successful `TARGET_API_POLL` using a freshly captured request
6. No purchase/cart mutation in observe-only mode

Deliberately repeating the prior rapid-click, search-crawl, or bare-HTTP patterns is not a reliable reproduction method and risks invalidating the authenticated Target session before useful diagnostics are captured.

## Evidence to capture on the next live challenge

Capture these fields before the page is closed or refreshed:

- UTC and local timestamps.
- Current page URL and originating product TCIN.
- Last 20 monitor state-transition log lines.
- Last 20 availability poll records, including status and latency.
- Current page title and sanitized visible challenge text.
- Visible frame URLs/hosts, excluding sensitive query values.
- HTTP status, content type, and sanitized response signature for the triggering request.
- Provider identifiers such as `_pxAppId`, when present.
- Screenshot of the challenge with account, address, payment, and order data redacted.
- Solver attempt number, configured hold/timeout values, categorical failure, and elapsed time.
- Post-solve URL/title and the first successful fresh poll.

Do not record cookies, authorization headers, API keys, payment data, address information, checkout URLs, or complete challenge tokens.

## Current conclusion

Historical preorder/search navigation and bare Redsky probing remain associations, not deterministic trigger thresholds. Isolated live testing now includes both failed and successful native hold attempts. The revised solver produced the required same-run `TARGET_CHALLENGE_SOLVED` event followed by two fresh successful polls when retrying a preserved `Please try again` state. This is bounded real-provider evidence with a 45-second configured attempt budget, not proof of a guaranteed trigger, refresh-fallback success, default-budget performance, or normal authenticated-session reliability.
