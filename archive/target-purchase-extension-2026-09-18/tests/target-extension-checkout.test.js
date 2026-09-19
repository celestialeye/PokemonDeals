const assert = require("assert");
const { JSDOM } = require("jsdom");
const {
  executeCheckoutDecision,
  getArmedProductIds,
  shouldRunCheckoutAction,
  snapshotCheckoutPage,
} = require("../extension/target-purchase/content/checkout-monitor");

function createDocument(html, url = "https://www.target.com/checkout") {
  return new JSDOM(html, { url }).window.document;
}

let document = createDocument(`
  <main>
    <h2>Cart total • 1 item</h2>
    <div data-test="cartItem" data-item-id="A-1010892065">
      <a href="/p/example/-/A-1010892065">Pokemon product</a>
      <select aria-label="Quantity">
        <option value="1" selected>1</option>
      </select>
    </div>
    <aside data-test="recommendations">
      <a href="/p/recommendation/-/A-9999999999">Recommendation</a>
    </aside>
    <button>Place your order</button>
  </main>
`);
let snapshot = snapshotCheckoutPage(document, document.URL);
assert.deepStrictEqual(snapshot.cartRows, [
  { productId: "A-1010892065", quantity: 1 },
]);
assert.strictEqual(snapshot.cartItemCount, 1);
assert.strictEqual(snapshot.placeOrderReady, true);
assert.strictEqual(snapshot.onCartPage, false);

document = createDocument(
  `<main>
    <div data-test="cartItem" data-item-id="A-1010892065">
      <a href="/p/example/-/A-1010892065">Pokemon product</a>
      <input aria-label="Quantity" value="1">
    </div>
  </main>`,
  "https://www.target.com/cart",
);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.onCartPage, true);

document = createDocument(
  `<main><h1>Your cart is empty</h1></main>`,
  "https://www.target.com/cart",
);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.cartItemCount, 0);

document = createDocument(
  `<main>
    <h1>Your cart is empty</h1>
    <section data-test="sfl-cart-item-1010892076">
      <a data-test="cartItem-linked-image" href="/p/-/A-1010892076">Saved item</a>
    </section>
  </main>`,
  "https://www.target.com/cart",
);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.deepStrictEqual(snapshot.cartRows, []);
assert.strictEqual(snapshot.cartItemCount, 0);

document = createDocument(`
  <div role="dialog">
    <p>Checkout is busy right now</p>
    <button>OK</button>
  </div>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.highDemandReady, true);

document = createDocument(`
  <div role="dialog">
    <h2>Confirm your PIN</h2>
    <input name="pin" aria-label="PIN" type="password">
    <button>Confirm</button>
  </div>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.pinReady, true);

document = createDocument(`
  <div role="dialog">
    <p>Before you confirm your PIN, enter your account password.</p>
    <input name="password" type="password">
    <button>Confirm</button>
  </div>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.pinReady, false);

document = createDocument(`<h1>Thank you for your order</h1>`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.confirmationVisible, true);

document = createDocument(
  `<div>Order details are loading</div>`,
  "https://www.target.com/order-confirmation?referenceId=102003775258007",
);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.confirmationVisible, true);

document = createDocument(`
  <main>
    <div data-test="cartItem"><span>Unknown product</span></div>
    <button>Place your order</button>
  </main>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.deepStrictEqual(snapshot.cartRows, [
  { productId: null, quantity: null },
]);

document = createDocument(`
  <main>
    <h2>Cart total • 2 items</h2>
    <div data-test="cartItem" data-item-id="A-1010892065">
      <a href="/p/example/-/A-1010892065">Known product</a>
      <select aria-label="Quantity"><option value="1" selected>1</option></select>
    </div>
    <section>
      <a href="/p/unknown/-/A-9999999999">Unknown cart product</a>
      <span>Quantity 1</span>
    </section>
  </main>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.deepStrictEqual(snapshot.cartRows, [
  { productId: "A-1010892065", quantity: 1 },
  { productId: "A-9999999999", quantity: null },
]);

document = createDocument(`
  <main>
    <h2>Cart total • 2 items</h2>
    <div data-test="cartItem" data-item-id="A-1010892065">
      <a href="/p/example/-/A-1010892065">Known product</a>
      <select aria-label="Quantity"><option value="1" selected>1</option></select>
    </div>
    <article class="new-cart-row-markup">
      <span>Mystery item</span>
      <span>Qty 1</span>
    </article>
    <button>Place your order</button>
  </main>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.deepStrictEqual(snapshot.cartRows, [
  { productId: "A-1010892065", quantity: 1 },
  { productId: null, quantity: 1 },
]);
assert.strictEqual(snapshot.cartItemCount, 2);
assert.deepStrictEqual(
  require("../extension/target-purchase/lib/core").classifyCheckoutPage(
    snapshot,
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "blocked-cart" },
);

document = createDocument(`
  <div>
    <h2>Cart $25.34 total • 1 item</h2>
    <img alt="Women's Iconic Cotton Cardigan - Universal Thread™ Brown XS quantity 1">
    <button>Place your order</button>
  </div>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.deepStrictEqual(snapshot.cartRows, [
  {
    productId: null,
    productLabel:
      "women's iconic cotton cardigan - universal thread™ brown xs",
    quantity: 1,
  },
]);
assert.deepStrictEqual(
  require("../extension/target-purchase/lib/core").classifyCheckoutPage(
    snapshot,
    {
      phase: "monitoring",
      armedProductIds: [],
      armedProductLabels: [
        "women's iconic cotton cardigan - universal thread™ brown xs",
      ],
    },
  ),
  { type: "place-order" },
);

document = createDocument(`
  <main>
    <div data-test="cartItem" data-item-id="A-1010892065">
      <a href="/p/example/-/A-1010892065">Known product</a>
      <select aria-label="Quantity"><option value="1" selected>1</option></select>
    </div>
    <section class="line-item">
      <span>Mystery item</span>
      <span>Qty 1</span>
    </section>
    <button>Place your order</button>
  </main>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.cartItemCount, null);
assert.deepStrictEqual(
  require("../extension/target-purchase/lib/core").classifyCheckoutPage(
    snapshot,
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "blocked-cart" },
);

document = createDocument(`
  <main style="display: none">
    <div data-test="cartItem" data-item-id="A-1010892065">
      <select aria-label="Quantity"><option value="1" selected>1</option></select>
    </div>
    <button>Place your order</button>
  </main>
`);
snapshot = snapshotCheckoutPage(document, document.URL);
assert.strictEqual(snapshot.placeOrderReady, false);

assert.deepStrictEqual(
  getArmedProductIds({
    "1": { role: "product", phase: "monitoring", productId: "A-1010892065" },
    "2": { role: "product", phase: "stopped", productId: "A-1010892068" },
    "3": { role: "checkout", phase: "monitoring", productId: null },
  }),
  ["A-1010892065"],
);
assert.strictEqual(
  shouldRunCheckoutAction(
    { type: "save-continue", at: 1000 },
    "save-continue",
    5000,
  ),
  false,
);
assert.strictEqual(
  shouldRunCheckoutAction(
    { type: "save-continue", at: 1000 },
    "confirm-pin",
    5000,
  ),
  true,
);
assert.strictEqual(
  shouldRunCheckoutAction(
    { type: "save-continue", at: 1000 },
    "save-continue",
    12000,
  ),
  false,
);

(async () => {
  const calls = [];
  await executeCheckoutDecision(
    { type: "place-order" },
    {
      controls: {
        placeOrder: {
          click: async () => calls.push("place-order"),
        },
      },
      claim: async () => "checkout-token",
      authorize: async () => true,
      getPin: async () => "",
      markPending: () => {},
      navigate: (url) => calls.push(url),
      refresh: () => calls.push("refresh"),
      report: async (phase) => calls.push(`report:${phase}`),
    },
  );
  assert.deepStrictEqual(calls, ["place-order"]);

  calls.length = 0;
  await executeCheckoutDecision(
    { type: "place-order" },
    {
      controls: {
        placeOrder: {
          click: async () => calls.push("place-order"),
        },
      },
      claim: async () => null,
      authorize: async () => true,
      getPin: async () => "",
      markPending: () => {},
      navigate: () => {},
      refresh: () => {},
      report: async (phase) => calls.push(`report:${phase}`),
    },
  );
  assert.deepStrictEqual(calls, []);

  await executeCheckoutDecision(
    { type: "place-order" },
    {
      controls: {
        placeOrder: {
          click: async () => calls.push("place-order"),
        },
      },
      claim: async () => "checkout-token",
      authorize: async () => false,
      getPin: async () => "",
      markPending: () => {},
      navigate: () => {},
      refresh: () => {},
      report: async (phase) => calls.push(`report:${phase}`),
    },
  );
  assert.deepStrictEqual(calls, []);

  calls.length = 0;
  await executeCheckoutDecision(
    { type: "place-order" },
    {
      controls: {
        placeOrder: {
          click: async () => calls.push("place-order"),
        },
      },
      claim: async () => "checkout-token",
      authorize: async () => true,
      finalValidate: async () => false,
      getPin: async () => "",
      markPending: () => {},
      navigate: () => {},
      refresh: () => {},
      report: async (phase) => calls.push(`report:${phase}`),
    },
  );
  assert.deepStrictEqual(calls, []);

  calls.length = 0;
  await executeCheckoutDecision(
    { type: "confirm-pin" },
    {
      controls: {
        pinInput: {
          value: "",
          dispatchEvent() {},
        },
        pinConfirm: {
          click: async () => calls.push("pin-confirm"),
        },
      },
      claim: async () => "unused-token",
      authorize: async () => true,
      getPin: async () => "2468",
      markPending: (type) => calls.push(`pending:${type}`),
      navigate: () => {},
      refresh: () => {},
      report: async (phase) => calls.push(`report:${phase}`),
    },
  );
  assert.deepStrictEqual(calls, [
    "pending:confirm-pin",
    "pin-confirm",
  ]);

  calls.length = 0;
  await executeCheckoutDecision(
    { type: "confirm-pin" },
    {
      controls: {
        pinInput: {
          value: "",
          dispatchEvent() {},
        },
        pinConfirm: {
          click: async () => calls.push("pin-confirm"),
        },
      },
      claim: async () => "unused-token",
      authorize: async () => true,
      getPin: async () => "",
      markPending: () => {},
      navigate: () => {},
      refresh: () => {},
      report: async (phase, detail) =>
        calls.push(`report:${phase}:${detail}`),
    },
  );
  assert.deepStrictEqual(calls, [
    "report:blocked:Target checkout PIN is required.",
  ]);

  calls.length = 0;
  await executeCheckoutDecision(
    { type: "blocked-cart" },
    {
      controls: {},
      claim: async () => "unused-token",
      authorize: async () => true,
      getPin: async () => "",
      markPending: () => {},
      navigate: () => {},
      refresh: () => {},
      report: async (phase) => calls.push(`report:${phase}`),
    },
  );
  assert.deepStrictEqual(calls, ["report:blocked"]);

  console.log("target-extension-checkout tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
