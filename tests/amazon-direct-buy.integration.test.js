const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright-core");
const { findChromeExecutable } = require("../src/chrome-cdp");

process.env.AMAZON_PRODUCT_URL =
  "https://www.amazon.com/dp/B0GW2DK37Q";
process.env.AMAZON_MAX_ITEM_PRICE = "30";

const {
  readExpectedCheckoutLineItem,
} = require("../amazon-preorder");

let browser;

test.before(async () => {
  browser = await chromium.launch({
    executablePath: await findChromeExecutable(),
    headless: true,
  });
});

test.after(async () => {
  await browser?.close();
});

test("checkout line-item evidence stays scoped in a real browser DOM", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main><form>
        <div data-asin="B0007VO0DU">
          Different ordered item<span>Qty: 1</span><span>$19.99</span>
        </div>
        <aside>
          <div data-asin="B0GW2DK37Q">
            Recommended expected item<span>$26.87</span>
          </div>
        </aside>
        <button>Place your order</button>
      </form></main>
    `);
    let placeOrder = page
      .getByRole("button", { name: /place your order/i })
      .first();
    assert.equal(
      await readExpectedCheckoutLineItem(page, placeOrder),
      null,
    );

    await page.setContent(`
      <main><form>
        <div class="checkout-line-item" data-asin="B0GW2DK37Q">
          <a href="/dp/B0GW2DK37Q">Expected ordered item</a><span>Qty: 1</span><span>$26.87</span>
        </div>
        <button>Place your order</button>
      </form></main>
    `);
    placeOrder = page
      .getByRole("button", { name: /place your order/i })
      .first();
    assert.deepEqual(
      await readExpectedCheckoutLineItem(page, placeOrder),
      {
        asins: ["B0GW2DK37Q"],
        itemPrice: 26.87,
        quantity: 1,
        text: "Expected ordered item Qty: 1 $26.87",
      },
    );

    await page.setContent(`
      <main><form>
        <div data-asin="B0GW2DK37Q">
          Expected ordered item<span>Qty: 1</span><span>$26.87</span>
        </div>
        <div data-asin="B0007VO0DU">
          Second ordered item<span>$19.99</span>
        </div>
        <button>Place your order</button>
      </form></main>
    `);
    placeOrder = page
      .getByRole("button", { name: /place your order/i })
      .first();
    assert.equal(
      await readExpectedCheckoutLineItem(page, placeOrder),
      null,
    );

    await page.setContent(`
      <main><form>
        <div data-asin="B0GW2DK37Q">
          Expected ordered item<span style="display: none">Qty: 1 $1.00</span>
        </div>
        <button>Place your order</button>
      </form></main>
    `);
    placeOrder = page
      .getByRole("button", { name: /place your order/i })
      .first();
    assert.equal(
      await readExpectedCheckoutLineItem(page, placeOrder),
      null,
    );

    for (const hiddenWrapper of [
      'aria-hidden="true"',
      'style="opacity: 0"',
    ]) {
      await page.setContent(`
        <main><form>
          <div ${hiddenWrapper}>
            <div data-asin="B0GW2DK37Q">
              Expected ordered item<span>Qty: 1</span><span>$1.00</span>
            </div>
          </div>
          <button>Place your order</button>
        </form></main>
      `);
      placeOrder = page
        .getByRole("button", { name: /place your order/i })
        .first();
      assert.equal(
        await readExpectedCheckoutLineItem(page, placeOrder),
        null,
      );
    }
  } finally {
    await page.close();
  }
});
