---
name: target-buy
description: Accept one Target product URL and autonomously place exactly one order through the guarded Target watch, checkout, and supported Press & Hold recovery flow after explicit /target-buy invocation.
---

# Target buy

Use this skill only when the user explicitly invokes
`/target-buy <target-url>`. That invocation authorizes exactly one
quantity-one order for that Target product. This event-bound skill launcher
cannot accept a bare URL. A URL-only message is a separate main-agent
purchase route under `AGENTS.md`; a URL inside discussion, research, or testing
does not authorize purchase.

## Required behavior

1. Do not infer the product URL from the transformed skill context, example
   URLs, or another session. The launcher reads the raw `user.message.data.content`
   from `events.jsonl` in the active `COPILOT_AGENT_SESSION_ID` and requires
   a matching user-invoked `skill.invoked` event for the same turn. This is
   authoritative even when the rendered skill context omits `ARGUMENTS:`.
   Never search prior sessions or pass a model-recovered URL to the launcher.
2. Accept exactly one HTTPS Target product URL containing `A-<TCIN>`, or one
   `howl.link` or `goto.target.com` Target short link. Accept
   `target.com`, `https://target.com`, and `https://www.target.com` product
   URLs, including full slugged PDP paths such as
   `/p/product-name/-/A-12345678`. If the active raw invocation does not
   contain exactly one valid URL, emit `TARGET_BUY_INPUT_MISSING` or
   `TARGET_BUY_INPUT_INVALID` and stop. Do not open a form or ask a follow-up
   question.
3. Always use the autonomous auto route. It chooses a current visible, enabled
   action in this order: **Buy Now**, **Preorder**, then **Add to cart** when
   the cart is empty. An exact one-item, quantity-one cart instead proceeds to
   guarded checkout without another cart mutation; ambiguous cart contents
   stop safely. Never ask the user to choose a purchase mode or expose an
   explicit-mode variant of this skill. Open `/checkout` for the existing-item
   check and use its live cart-view response. Never intentionally open or
   inspect `/cart`; if Target redirects there before Place order is clicked,
   return to `/checkout` without a retry count. A post-submit redirect is
   ambiguous and never authorizes another Place-order click.
4. Operate only in the PokemonDeals repository. Read the Target URL watch and
   Target checkout sections of `README.md` before launching.
5. Use the existing `target-watch.js` and `target-checkout.js` state machines.
   Do not manually click Add to cart, Buy Now, Continue, or Place order through
   browser tools.
6. Require one exact Target product, quantity one, detected fulfillment, an
   unambiguous item price, and an unambiguous order total before final
   submission. Reuse stricter configured Target limits; when either persisted
   price limit is unset, the skill applies the repository `$10000` fallback
   for that run only. If no fulfillment preference is configured, select
   **Shipping** automatically on the product page before purchase input and
   again in checkout; do not silently switch to pickup, delivery, or Drive Up.
7. Keep the bundled Press & Hold solver enabled. It may perform only its
   bounded native hold against a uniquely identified supported Target control.
   The direct-buy path uses the maximum supported 45-second per-attempt budget
   and keeps the pointer held until independent clear evidence or that safety
   deadline. After three failed attempts, refresh the worker-owned page once,
   re-inspect it, and continue the bounded recovery cycle.
   Generic CAPTCHA, access-denied, unreadable, and unresolved verification
   states must back off and require the user to complete the visible step.
8. Do not print, save, or commit Target secrets, PINs, checkout details, or
   order identifiers. The launcher prints a clickable local run-log URL and
   worker status without exposing those values.
9. Do not start beside another PokemonDeals purchase worker. If one is active,
   report the preflight block and leave it untouched.
10. Report `confidence:"unknown"` availability as **unknown**, never as
    unavailable. A successful HTTP poll alone does not prove stock status.

## Launch procedure

Run `.github\skills\target-buy\run-target-buy.ps1` in an attached asynchronous
PowerShell session using shell ID `target-buy`. Pass no URL argument: the
launcher binds the raw URL to this active user-invoked turn and refuses stale
or missing input. Never concatenate raw user input into executable command text.

```powershell
& '.github\skills\target-buy\run-target-buy.ps1'
```

The launcher:

- resolves and validates only the active session's raw user-invoked Target
  product or supported short link without echoing the raw URL;
- creates a timestamped, gitignored JSONL run log;
- installs existing dependencies only when Patchright or Playwright is absent;
- takes the shared PokemonDeals purchase mutex and refuses any competing
  purchase worker without terminating it;
- preserves Target cookies and the connected Chrome profile through
  verification recovery, including after earlier failed cycles;
- reuses CDP on port `9444`, or starts the dedicated persistent PokemonDeals
  Chrome profile through the existing control-plane bootstrap;
- launches `npm run target:direct-buy`, which invokes the existing Target watch
  in `live-purchase` mode with the bundled solver enabled and Discord alerts
  disabled; terminal output and the run log are the operator status surface.

After launch, read process output once to verify that the worker started. Do
not poll continuously; completion notifications are automatic. Do not ask for
an execution mode, confirmation, or any other preference after a valid URL is
present: launch the authorized one-product worker immediately.

## Runtime handling

- `TARGET_LOG_FILE`: retain the local file URL for later incident analysis.
- `TARGET_BUY_INPUT_ACCEPTED`: the single requested product and action policy
  were accepted.
- `TARGET_BUY_STARTED`: the autonomous Target flow is running with the
  effective item-price and order-total guards.
- `TARGET_FULFILLMENT_SELECTED shipping`: the product page independently showed
  Shipping selected after the click. `TARGET_FULFILLMENT_CLICKED shipping` in
  checkout confirms only a click; fulfillment is validated before submission.
- `TARGET_SIGN_IN_REQUIRED`: the worker is paused while you sign in visibly in
  the authenticated Chrome session. It resumes after the session clears.
  Credentials are never entered or submitted by the skill.
- `TARGET_CHALLENGE_SOLVED`: the existing driver independently verified
  clearance after a bounded supported Press & Hold recovery. The worker resumes
  from fresh page state.
- `TARGET_CHALLENGE_BACKOFF`, `VERIFICATION_REQUIRED`, or
  `CHECKOUT_BLOCKED`: tell the user to complete the visible Target step when
  applicable. The worker is paused or stopped safely; do not bypass it.
- `TARGET_ORDER_CONFIRMED` followed by `TARGET_PURCHASE_COMPLETE`: verify the
  process exits successfully and report the completed order.
- `TARGET_TERMINAL_SAFETY_STOP`,
  `PLACE_ORDER_OUTCOME_AMBIGUOUS`, or
  `TARGET_BUY_OUTCOME_UNCONFIRMED`: do not restart or submit again. Report the
  exact safe-stop outcome.

If the user says to stop, terminate only the PowerShell session with shell ID
`target-buy`.
