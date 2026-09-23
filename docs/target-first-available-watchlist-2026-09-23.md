# Target first-available watchlist

## Goal and scope

Monitor the eight supplied Target products in one authenticated Chrome
session. Purchase **one unit per order when a product has a current visible,
enabled purchase action**. After each confirmed order, resume polling all
eight products, including the one just ordered. A current **Buy Now** action
takes priority over Preorder and Add to cart for that product. The
2026-09-23 overnight request authorizes repeated confirmed orders.

| Group | User label | Short link | Resolved TCIN |
| --- | --- | --- | --- |
| Initial list | Elite Trainer Box | `howl.link/99668grkawccg` | `A-1010892076` |
| Initial list | Poster Collection | `howl.link/kou0m5sh2jb1i` | `A-1010892067` |
| Initial list | Greninja ex Box | `howl.link/5pnf40xriju4t` | `A-1010892065` |
| Initial list | Tech Sticker Collection | `howl.link/eu3yhn7a7r9fd` | `A-1010892078` |
| Ascended Heroes | Booster Bundle | `howl.link/33zkvcx7vh0yu` | `A-95120834` |
| Ascended Heroes | Mega Meganium ex | `howl.link/4m2hzta20003p` | `A-1012644665` |
| Ascended Heroes | Mega Fraligatr ex | `howl.link/e63540pamwslq` | `A-1012644666` |
| Ascended Heroes | Mega Emboar ex | `howl.link/nronye46gbp6l` | `A-1012644667` |

These mappings were resolved through the supplied short links on
2026-09-23. The user labels are preserved as supplied; the TCIN controls
purchase identity.

## One-process flow

1. Validate all eight links and distinct TCINs, load the saved Target
   settings and PIN, acquire `Local\PokemonDealsPurchase`, reject any
   competing purchase worker, and reuse or start the dedicated CDP profile.
   The watchlist is separate from the three-item catalog/TUI limit.
2. Reuse a matching product tab already open for each TCIN; create one only
   when that TCIN has no tab. Preserve reused tabs when the worker exits.
   Stagger page loads and serialize availability checks through the existing
   global request queue, using a
   one-second shared cooldown with 10% jitter. Eight products therefore get
   approximately one check each every eight seconds, plus page and network
   time. Do not create a new tab on each poll or run workers in parallel.
   Respect challenge backoff. Cart-service `429` responses cool cart work
   without classifying availability polling as rate limited.
3. Reinspect the product page for exact TCIN and a visible, enabled action
   before buying. After a positive availability API response, inspect the
   existing tab first; navigate once only if no action has hydrated there.
   A positive API response is only a candidate,
   and unknown availability is not an unavailable verdict. In a tie, the
   configured list order decides which candidate is checked first.
4. The first eligible product claims the sole purchase lease. The global
   polling loop waits while its mutation and checkout run. Use Buy Now on the
   product page when present. When only Preorder or Add to cart is present,
   validate the checkout cart view before cart mutation: an empty cart permits
   the action; the exact winner already at quantity one proceeds to checkout;
   unrelated items disable cart-based fallback for this run while Buy Now
   monitoring continues. Reuse the preflight checkout tab during that
   transaction. After an uncertain cart click, keep ownership and reconcile
   from `/checkout`; if the cart is explicitly empty, retry the product action.
   Never inspect a `/cart` challenge or clear existing cart items.
5. Validate exactly one matching item, quantity one, Shipping unless a
   stricter saved preference exists, unambiguous item price and order total,
   and price ceilings immediately before submission. Because saved Target
   ceilings are unset, this watchlist uses **$100 maximum item price** and
   **$125 maximum order total**; stricter saved ceilings win.
6. Click Place order at most once for each product's transaction. Handle the
   supported Press & Hold control and saved card PIN through the existing
   guarded state machine. A successful click, PIN confirmation, and order
   confirmation are different evidence. If the worker outcome is ambiguous,
   check Target Orders read-only for the winning TCIN, quantity one, and an
   order date associated with this submission. Never replay Place order from
   a still-visible button. If success cannot be established, stop with an
   unresolved outcome rather than risk a duplicate.
7. On confirmation, release checkout ownership, discard the old checkout
   state, reload that product page, and resume all product polls in the same
   worker. Each repeat requires a new Place-order click. Keep the run active
   until stopped or an unresolved post-submit outcome prevents another
   submission.
   Record a redacted outcome in a gitignored JSONL run log. Leave unrelated
   Chrome tabs and the user's cart intact.

## Implementation and evidence

- `data/target-watchlist.json` holds names, source links, and expected TCINs
  without changing `data/deals.json`.
- `src/target-watchlist.js` verifies link destinations and applies the
  watchlist price caps. `target-watchlist-buy.js` starts the same guarded
  `target-watch.js` worker, while `scripts/run-target-watchlist.ps1` owns the
  cross-process purchase mutex.
- `target-watch.js` permits up to eight direct-buy jobs only with the
  explicit watchlist flag. The ordinary three-product cap remains. It retains
  the shared request/mutation queues and challenge solver. A confirmed order
  releases the transaction and rearms that product from a fresh page.
  `src/target-order-history.js` reads Target Orders only after an ambiguous
  Place-order attempt; it never submits an order.
- Offline tests cover distinct/changed short-link destinations, the eighth
  job, Buy Now priority, occupied-cart fallback, repeated polling after
  confirmed orders, fresh-submit evidence, shared queues, guarded
  checkout, redacted output, and read-only history matching. `npm test` and
  `npm run check` passed before the live launch. Unit tests and local
  fixtures do not prove a Target purchase.

At the initial live inspection on 2026-09-23, the worker had opened the eight
product tabs and recorded nine availability API polls. A transient unreadable
first page entered challenge backoff, then the worker independently observed
clearance and resumed. All eight main product actions were disabled in a
read-only page inspection; no purchase action or order confirmation had
occurred at that snapshot. This is a dated snapshot, not an ongoing status
claim. The worker's current status is in its gitignored `logs/` JSONL file.

## Limits

The worker can automate only the supported verification and checkout states.
Expired sign-in, an unsupported challenge, missing payment setup, an
unresolved order outcome, or retailer throttling can stop or pause the run.
This workflow does not promise a successful order regardless of Target's
state. The unattended price ceilings above are an implementation assumption
for this list and can be changed before launch if the user supplies limits.
