# Target direct-buy session: checkout, PIN, and confirmation

Date: 2026-09-23 (UTC times below). This record concerns one requested Target
product, `A-90172677`, at quantity one. It contains no card PIN, checkout token,
order number, address, or other account detail. Operational commands and
current safeguards are in [README.md](../README.md#target-direct-buy).

## What happened

| Time (UTC) | Observed result | Evidence and limit |
| --- | --- | --- |
| 06:11 | The original direct-buy preflight found one matching item, then product-page inspection reported an unreadable challenge and scheduled a five-minute backoff. | The worker log contains `TARGET_CART_PREFLIGHT_MATCH` and `TARGET_CHALLENGE_BACKOFF`. Separate live frame inspection found a supported Press & Hold control on `/cart`. The worker inspected the product tab first, so it did not dispatch the cart-page control to its solver. |
| 06:24 | The checkout-only preflight validated one matching item and Shipping. Place order was clicked once. The PIN selector resolved to an Edit Shipping address link, failed three times, and the worker stopped as ambiguous. | The log contains `TARGET_CHECKOUT_PREFLIGHT_MATCH`, `TARGET_PURCHASE_VALIDATION`, `PLACE_ORDER_CLICKED`, and `PIN_CONTROL_REPLACED`. The broad `/pin/i` label pattern matched the ending of “Shipping.” A browser error printed the PIN in raw terminal output and the local JSONL log. The local log was sanitized afterward; terminal output already shown cannot be retracted. |
| 06:29 | A second checkout-only run validated the same product and quantity, clicked Place order once, and completed the PIN dialog. The worker saw Place order again and stopped as ambiguous. | The log contains `PIN_CONFIRMED` and `PLACE_ORDER_OUTCOME_AMBIGUOUS place-order-still-present`, with no in-worker `TARGET_ORDER_CONFIRMED`. Target's purchase-history API subsequently returned a Sales order dated `2026-09-23T06:29:26Z` for `A-90172677`, quantity one. The user confirmed the order was placed and reported cancelling it. Cancellation was not independently checked. |
| After 06:29 | A separate read-only diagnostic opened `/checkout`; Target redirected that diagnostic tab to `/cart`, where the challenge was visible. | The final purchase worker logged no `TARGET_CHECKOUT_CART_REDIRECT`. The diagnostic waited on `/cart` to inspect it, contrary to the operator's instruction, then closed its tab. Target's reason for redirecting was not established. |

The history record and the user's confirmation establish that the 06:29
purchase completed. The worker's terminal result alone did **not** establish
either success or failure. No later purchase attempt was made after the user
reported cancelling that order.

## Durable operating decisions

1. A user message containing **only one valid Target product URL** authorizes
   the main repository agent to attempt one quantity-one direct purchase in
   automatic mode. It should start the scoped worker and monitor the result
   without asking for a mode, fulfillment choice, or routine confirmation.
   A URL in a research, discussion, or testing request is not this trigger.
   The literal `/target-buy <url>` skill has a separate event-bound launcher;
   a URL-only message must use the main agent's direct-worker route.
2. The direct-buy preflight opens `/checkout` and reads that page's live
   cart-view response. It must not intentionally open or inspect `/cart`.
   Target may still redirect there. Before submission, return to `/checkout`
   whenever a redirect is observed; the operator specified no redirect-count
   limit. Recheck the URL after awaited page and cart-view reads because the
   redirect can occur during either one. The current preflight has no special
   pacing for a persistent redirect loop, so rate limiting remains a risk.
3. When checkout already contains exactly the requested TCIN at quantity one,
   checkout owns the transaction. Do not add another unit, and do not let an
   unreadable product tab block checkout or release a checkout verification
   pause. A collapsed “1 item” heading is insufficient: validate the cart-view
   TCIN, quantity, fulfillment, item price, and order total, and fetch current
   evidence again before submission.
4. Checkout verification must inspect visible frames. Main-page body text can
   miss a Press & Hold control inside an iframe. The bundled solver may act
   only on a uniquely identified supported control. An unreadable or
   unsupported challenge remains a stop/backoff condition. An expired sign-in
   or unsupported verification can still prevent a purchase without user
   involvement; automatic completion cannot be guaranteed.
5. Scope PIN input to the confirmation dialog and an editable input. A
   page-wide label pattern containing `pin` can match “Shipping.” Do not log
   browser exception text from a PIN fill: it can include the filled value.
   The run used raw stdout/stderr forwarding at the time of the exposure.
   Forwarding now buffers and sanitizes complete lines before terminal output,
   while sensitive actions still emit categorical errors at their source.
6. Treat `PLACE_ORDER_CLICKED`, `PIN_CONFIRMED`, an enabled Place order button,
   and `TARGET_ORDER_CONFIRMED` as different evidence. A PIN-confirmed order
   may succeed even when the button is observed again. Never submit a second time
   solely because the button is present. If the worker reports an ambiguous
   outcome after submission, inspect order history for the exact product,
   quantity, and run time before considering any new attempt. A user-reported
   cancellation ends the current purchase request.

## Code and verification

- `target-watch.js` owns checkout-only preflight, current cart-view capture,
  product versus checkout page priority, challenge ownership, and redirect
  checks after awaited reads.
- `target-checkout.js` owns frame-aware verification, dialog-scoped PIN input,
  checkout redirect handling, guarded purchase evidence, and one-shot
  submission.
- `target-direct-buy.js` now sanitizes complete worker lines before terminal
  output and requires an explicit worker confirmation event to mark its own
  run successful.
- `src/target-run-log.js` redacts fill traces in persisted JSONL and the
  direct-buy launcher's terminal output. It cannot retract the earlier
  exposure.
- Focused regression tests cover checkout-only routing, redirects before and
  during reads, cart-view identity and quantity, frame verification, PIN input
  selection, and log redaction. `npm test` and `npm run check` passed after the
  behavioral fixes. The post-cancellation redirect-read changes were checked
  offline; no purchase worker was launched to test them live.

## Open issue

The worker marked the successful 06:29 run
`PLACE_ORDER_OUTCOME_AMBIGUOUS place-order-still-present` and exited without a
confirmation event. The later Target purchase-history record established the
order, but the worker did not make that read. Future work should add bounded,
read-only post-submit confirmation that matches product, quantity, and the
current run time without exposing order identifiers or ever replaying Place
order. Until that exists, an ambiguous worker result requires independent
order verification and must not trigger an automatic second submission.
