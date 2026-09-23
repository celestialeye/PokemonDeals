---
name: amazon-buy
description: Accept one Amazon product or direct Buy Now checkout URL, verify an Amazon-sold and Amazon-shipped offer, and place exactly one order after explicit /amazon-buy invocation.
---

# Amazon buy

Use this skill only when the user explicitly invokes `/amazon-buy <amazon-url>`.
That invocation authorizes one quantity-one order for the ASIN in that URL. Do
not treat discussion, analysis, testing, or a bare product link as purchase
authorization.

## Input and purchase boundaries

1. Use **exactly one** URL from the text after `/amazon-buy`. Accept
   `amazon.com`, `https://amazon.com`, or `https://www.amazon.com` with one
   `/dp/ASIN` or `/gp/product/ASIN` path, or a direct
   `/checkout/entry/buynow` URL with exactly one valid `asin`, `offeringID`,
   `quantity=1`, and `buyNow=1`. The parser requires HTTPS and a
   10-character ASIN. Ask for clarification if the URL is missing or multiple
   URLs were supplied; report other validation failures without launching.
2. Operate only from the PokemonDeals repository. Read the
   [Amazon direct-buy guide](../../../README.md#amazon-direct-buy-and-preorder)
   first. This is a **project skill**, not a global install: on another
   device, the user must have this repository and a Copilot CLI session
   rooted in it. If the skill is missing, use `/skills reload` and
   `/skills info amazon-buy` rather than improvising a purchase.
3. Require a current offer for that ASIN that is **sold by and shipped from Amazon**,
   has a usable purchase control and offer token, and stays within
   `AMAZON_MAX_ITEM_PRICE`. A supplied Buy Now URL is an input hint, **not**
   permission to use its token blindly: verify its offer token against a
   current qualifying Amazon offer before checkout. Build a new canonical
   direct Buy Now URL from the validated ASIN and current token, replacing
   a stale/different supplied token and discarding unrelated query parameters.
   If no qualifying offer exists, leave the worker monitoring; never switch
   to a third-party seller.
4. Use quantity one and `10000` USD for both `AMAZON_MAX_ITEM_PRICE` and
   `AMAZON_MAX_ORDER_TOTAL`. Ignore return-policy text, including `Final sale`
   and `No returns`; it does not relax the offer, identity, quantity, or
   price guards. Only after one guarded Place order attempt, if Amazon
   explicitly warns of a recent purchase or duplicate order, affirm its
   consent and allow one order-anyway confirmation.
5. Never manually click Add to cart, Buy Now, Continue, or Place order with
   browser tools. Run the repository worker so **one process owns the full
   state machine**. Do not use the lower-level `amazon:checkout` worker as a
   substitute: it does not revalidate the current seller, shipper, or
   checkout item/total.
6. Never print, save, share, or commit a supplied or generated checkout URL
   or offer token. Do not put one in a log, screenshot, status message, or
   source file. The worker and launcher log only redacted events.
7. The mutex and competing-worker check are **device-local**. Before starting
   on another device with the same Amazon account, stop any earlier purchase
   worker there. If it may have submitted an order, check Amazon Orders and
   resolve that outcome before running this skill again.

## Launch procedure

From the repository root, run
`.github\skills\amazon-buy\run-amazon-buy.ps1` in an **attached asynchronous**
PowerShell session using shell ID `amazon-buy`. Assign the **exact** user URL
to one single-quoted PowerShell variable before passing it to `-AmazonUrl`.
**Double any embedded apostrophes** (`'` becomes `''`) inside that literal:
PowerShell then passes the original URL unchanged. Do not splice it into
executable command text, split it at `&`, use double-quoted interpolation,
echo it, or run it via a browser tool. `-ProductUrl` is a compatibility
alias, not a different workflow. Substitute the authorized URL for the
placeholder in this shape, and pass both fail-safe limits:

```powershell
$amazonUrl = '<exact single URL supplied after /amazon-buy>'
& '.\.github\skills\amazon-buy\run-amazon-buy.ps1' -AmazonUrl $amazonUrl -MaxItemPrice 10000 -MaxOrderTotal 10000
```

Run this in the attached async shell ID `amazon-buy`; do **not** execute the
placeholder literally. The script:

- creates one timestamped JSONL log under gitignored `logs\` and prints its
  clickable `AMAZON_LOG_FILE` URL (the worker also prints that same URL);
- acquires a **device-local** named mutex for the lifetime of this
  invocation, clears inherited Amazon URL/identity inputs, then validates
  and classifies the supplied URL and derives its ASIN without printing the
  checkout URL or token;
- installs existing dependencies only if `playwright-core` is missing;
- checks for other Amazon purchase workers and refuses to launch if one is
  already running;
- reuses CDP at `127.0.0.1:9444` if available; otherwise starts a **local,
  dedicated** persistent PokemonDeals Chrome profile. It does not copy sign-in
  from another device or close unrelated Chrome windows. If this profile
  needs Amazon sign-in, the user must sign in there;
- runs `npm run amazon:direct-buy` in the attached session with both limits
  and retains the mutex until it exits.

Read process output **once** to confirm `AMAZON_INPUT_ACCEPTED` and
`AMAZON_BUY_STARTED`/`AMAZON_RUN_STARTED`. If bootstrap fails, report the
error and do not launch a different worker to work around it. If the
first read shows only launcher startup, it may still be installing dependencies
or starting Chrome: leave that attached process alone, and do not claim the
worker has started yet. Retain the `AMAZON_LOG_FILE` link. Do not poll
continuously; completion notifications are automatic. On completion, read
the process output to check its exit code and terminal event.

## Runtime handling

- `AMAZON_PRODUCT_REFRESH`: no **currently qualifying** offer (possibly
  unavailable, third-party, or missing evidence); leave monitoring running.
- `AMAZON_SUPPLIED_CHECKOUT_VERIFIED` / `AMAZON_SUPPLIED_CHECKOUT_REPLACED`:
  the supplied token matched the live eligible offer / was replaced with a
  verified current token. Neither event means an order was placed.
- `AMAZON_DIRECT_CHECKOUT_FOUND`: the worker built a direct checkout URL
  from the live offer and is navigating to it without adding to cart.
  `AMAZON_CHECKOUT_REFRESH` means Amazon reports the item
  unavailable: it retries after the one-second checkout delay **plus** the
  one-second page-settle wait and navigation time, and rechecks the product
  offer every ten such responses. `AMAZON_OFFER_TOKEN_REFRESHED` means it
  found a new live token; `AMAZON_OFFER_REVALIDATION_FAILED` means it
  discarded the old checkout and returned to product monitoring.
- `AMAZON_SIGN_IN_REQUIRED` / `AMAZON_VERIFICATION_REQUIRED`: tell the user
  to complete the **visible Chrome** step. The worker waits on that page
  and resumes automatically; don't restart it to "help."
- `AMAZON_ORDER_GUARDS_VALIDATED` / `AMAZON_PLACE_ORDER_CLICKED`: the
  final product, quantity, price and total passed / one submission was
  attempted. **Neither is confirmation.**
  `AMAZON_DUPLICATE_ORDER_CONFIRMED` is one allowed follow-up only for an
  explicit duplicate warning.
- `AMAZON_ORDER_CONFIRMED`: require the worker and launcher to exit
  successfully before reporting the order as confirmed.
- `AMAZON_ORDER_BLOCKED`, `AMAZON_ORDER_CONFIRMATION_AMBIGUOUS`, or
  `AMAZON_DUPLICATE_ORDER_CONFIRMATION_AMBIGUOUS`: report the exact safe-stop
  reason; never restart or submit again automatically. After any attempted
  click with no confirmation, check Amazon's order history before deciding
  whether a **new** purchase is wanted.

If an unfamiliar checkout page shows neither a recognized unavailable
message nor a ready Continue/Place order control, the worker waits without
clicking or refreshing. Inspect the visible page **read-only** and report
the state; never launch another worker or manually bypass the guard.

If the user says to stop, terminate **only** the attached PowerShell session
with shell ID `amazon-buy`, not Chrome or other workers. A stopped or
interrupted run is not proof that a previously attempted submission failed.
