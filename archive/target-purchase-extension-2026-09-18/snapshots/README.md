# PokemonDeals

Playwright scripts for monitoring high-demand Pokemon product and checkout flows in an existing authenticated Chrome profile.

These scripts can add products to a cart and submit real orders. Run them only when you intend to make a purchase, verify the active cart, shipping address, payment method, and quantities first, and stop duplicate workers after one order succeeds.

## Scripts

- `monitor.js`: Target checkout state machine. Handles cart redirects, shipping retries, high-demand dialogs, PIN confirmation, and repeated order submission until confirmation.
- `preorder.js`: Target product monitor. Watches configured product pages, clicks Preorder, closes failed-add dialogs, and stops monitoring a product after it is added to the cart.
- `pokemoncenter-preorder.js`: Pokémon Center multi-product monitor. Keeps one tab per unique product, serializes shared-cart checkout, and stops after an explicit order confirmation.
- `amazon-preorder.js`: Amazon product monitor. Clicks Pre-order now, returns from unavailable-item checkout pages, retries, and submits the order when checkout becomes usable.
- `amazon-multi-preorder.js`: Amazon multi-product monitor. Keeps one dedicated tab per product and serializes shared-cart checkout actions.
- `amazon-checkout.js`: Amazon checkout monitor. Refreshes while quantity errors remain, advances with Continue, and submits the order when checkout becomes usable.
- `extension/target-purchase/`: Target Chrome extension with independent product-tab and checkout-tab roles.
- `scripts/target-extension-scheduler.js`: localhost scheduler that supplies configurable ticks to the extension.
- `screenshots/`: Preserved session screenshots with a traceable evidence index.

## Requirements

- Windows
- Node.js 20 or newer
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

## Start Chrome for Playwright

Chrome must be completely closed before starting it with remote debugging. Startup-only CDP flags are ignored when another Chrome browser process is already running.

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

## Target Chrome extension

The Chrome extension is the preferred Target workflow when you want one
persistent monitor per product tab and one independent checkout tab.

Install and verify:

```powershell
Set-Location 'F:\Repos\personal\temp\PokemonDeals'
powershell -ExecutionPolicy Bypass -File scripts/install-target-extension.ps1
```

If Chrome does not already have the unpacked extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked.
4. Choose `F:\Repos\personal\temp\PokemonDeals\extension\target-purchase`.

The scheduler runs on `127.0.0.1:18765`. Start it manually when needed:

```powershell
npm run target-extension:scheduler
```

Operating workflow:

1. Open each Target product URL in its own tab.
2. Open the extension and select Arm product tab in each product tab.
3. Open one Target cart or checkout tab.
4. Open the extension and select Arm checkout tab.
5. Keep the scheduler running.

The default refresh interval is 5,000 milliseconds. Change it in the extension
popup; accepted values are 3,000–300,000 milliseconds.

Product tabs refresh only while the main Add to cart or Preorder control is
unavailable. Once an action is visible and enabled, the tab stops refreshing,
clicks once, and waits for explicit success or failure. Buy Now pauses the tab
because shared-cart mode intentionally keeps checkout in the one designated
checkout tab.

The checkout tab operates independently. It validates that the cart contains
only armed Target products, handles checkout controls, and clicks Place order
once. An optional Target checkout PIN is stored only for the Chrome session and
is used only when Target displays its exact `Confirm your PIN` dialog.
Verification challenges pause automation for manual completion.

Do not run `target:preorder` or `target:checkout` while the extension is armed.
The extension and Playwright workers would share the same tabs, cart, payment
state, and account session.

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
2. Waits up to 3 seconds for Add to cart or Preorder to render.
3. Clicks the available purchase action and waits 5 seconds for the result.
4. Closes Item not added to cart dialogs before retrying.
5. Closes that product tab after a cart-add success signal.
6. Pauses on a verification challenge for manual completion.
7. Closes all active product tabs before reconnecting after an error.

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

- Verification challenges always pause automation for manual completion.
- Target and Amazon may change labels, dialogs, URLs, or markup without notice.
- Multiple workers share one Chrome profile and cart, so their actions can affect one another.
- A successful click is not treated as a completed purchase. The checkout workers wait for explicit order-confirmation text or URL signals.
- Keep secrets and transient session URLs in process environment variables only.

## Target verification recovery

The Target verification incident occurred after repeated automated Preorder clicks. The first explicit report was around 1:44 AM local time, and verification was reported again around 1:47 AM after retries continued. This establishes the timing and action immediately preceding the challenge, but not the challenge vendor or exact CAPTCHA implementation.

When Target verification appears:

1. Pause the worker attached to the challenged tab. Unaffected Target workers may continue.
2. Leave the challenged page open in the authenticated Chrome profile.
3. Complete the verification manually in the authenticated Chrome profile.
4. Confirm that the challenge URL and challenge text have disappeared and the normal Target product or checkout page is visible.
5. Resume the challenged worker after its page clears.
6. Keep the product cadence conservative: wait up to 3 seconds for Preorder and 5 seconds after clicking.
7. If verification returns, pause that worker again. Stop all Target workers only if challenges spread across multiple tabs.

Each worker checks only its own page for verification indicators. A challenged tab pauses independently and does not block unrelated Target tabs.

## Evidence

See [screenshots/README.md](./screenshots/README.md) for the complete screenshot index and the evidence boundary around the reported Target verification challenge.
