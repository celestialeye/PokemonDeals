---
name: amazon-buy
description: Monitor one Amazon product URL for an Amazon-sold and Amazon-shipped offer, derive its direct Buy Now checkout URL, and place exactly one order after explicit /amazon-buy invocation.
---

# Amazon buy

Use this skill only when the user explicitly invokes `/amazon-buy <product-url>`.
That invocation authorizes one quantity-one order for the ASIN in that URL. Do
not treat discussion, analysis, testing, or a bare product link as purchase
authorization.

## Required behavior

1. Treat the text after `/amazon-buy` as the Amazon product URL. Accept
   `amazon.com`, `https://amazon.com`, and `https://www.amazon.com` URLs whose
   path contains either `/dp/ASIN` or `/gp/product/ASIN`. If the argument is
   missing or contains more than one product URL, ask the user to clarify.
2. Operate only in the PokemonDeals repository. Read the Amazon direct-buy
   section of `README.md` before launching.
3. Use quantity one. Ignore return-policy text, including `Final sale` and
   `No returns`.
4. Require the selected offer to match the URL ASIN and be both sold by and
   shipped from Amazon. Never substitute a third-party offer.
5. Use the user's approved fail-safe defaults of `10000` USD for both
   `AMAZON_MAX_ITEM_PRICE` and `AMAZON_MAX_ORDER_TOTAL`.
6. If Amazon explicitly warns that the item was recently purchased or the
   order may be a duplicate, affirm the duplicate-order consent and continue
   placing this authorized order.
7. Do not manually click Add to cart, Buy Now, Continue, or Place order through
   browser tools. Launch the repository worker so one process owns the entire
   state machine.
8. Never print, save, or commit the generated direct checkout URL or its offer
   token.

## Launch procedure

Run `.github\skills\amazon-buy\run-amazon-buy.ps1` with the supplied URL in an
attached asynchronous PowerShell session using shell ID `amazon-buy`. Assign
the URL to a PowerShell variable as one quoted literal before passing it to the
script; never concatenate the raw URL into executable command text. The script:

- validates the product URL and derives its ASIN;
- creates a timestamped, gitignored JSONL run log and prints its clickable
  `AMAZON_LOG_FILE` URL;
- installs existing repository dependencies only when `playwright-core` is
  missing;
- holds an exclusive named mutex until the worker exits so two `/amazon-buy`
  invocations cannot race each other;
- refuses to launch while another Amazon purchase worker is active, preventing
  duplicate or competing orders without terminating unrelated work;
- reuses Chrome when CDP is available on port `9444`, otherwise restarts the
  documented authenticated Default profile with CDP enabled;
- launches `npm run amazon:direct-buy` with the approved fail-safe limits.

After launch, read the process output once to verify that the worker started.
Do not poll continuously; completion notifications are automatic.

## Runtime handling

- `AMAZON_PRODUCT_REFRESH`: no qualifying Amazon offer exists yet; leave the
  worker running.
- `AMAZON_LOG_FILE`: retain this local file URL for later incident analysis.
- `AMAZON_DIRECT_CHECKOUT_FOUND`: the worker found an eligible offer and
  generated the direct checkout URL without adding to cart.
- `AMAZON_CHECKOUT_REFRESH`: checkout reports unavailable inventory; leave the
  worker running while it retries and periodically reacquires the offer token.
- `AMAZON_DUPLICATE_ORDER_CONFIRMED`: the worker accepted Amazon's explicit
  duplicate-order warning and continued the same authorized order.
- `AMAZON_SIGN_IN_REQUIRED` or `AMAZON_VERIFICATION_REQUIRED`: tell the user to
  complete the visible step. The worker is already paused and resumes itself.
- `AMAZON_ORDER_CONFIRMED`: verify the process exited successfully and report
  completion.
- `AMAZON_ORDER_BLOCKED` or `AMAZON_ORDER_CONFIRMATION_AMBIGUOUS`: do not
  restart or submit again. Report the exact safe-stop reason.

If the user says to stop, terminate only the PowerShell session with shell ID
`amazon-buy`.
