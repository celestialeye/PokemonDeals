const assert = require("assert");
const { JSDOM } = require("jsdom");
const {
  findMainProductAction,
  getMainProductLabel,
  snapshotProductPage,
} = require("../extension/target-purchase/content/shared");
const {
  executeProductDecision,
  isProductStateForUrl,
} = require("../extension/target-purchase/content/product-monitor");

function createDocument(html) {
  return new JSDOM(html, {
    url: "https://www.target.com/p/example/-/A-1010892065",
  }).window.document;
}

let document = createDocument(`
  <main>
    <h1>Women's Iconic Cotton Cardigan - Universal Thread™ Brown XS</h1>
  </main>
`);
assert.strictEqual(
  getMainProductLabel(document),
  "women's iconic cotton cardigan - universal thread™ brown xs",
);

document = createDocument(`
  <button id="recommendation">Add to cart</button>
  <section data-test="module-product-detail-add-to-cart">
    <button id="main" disabled>Add to cart</button>
  </section>
`);
let action = findMainProductAction(document);
assert.strictEqual(action.id, "main");
assert.strictEqual(snapshotProductPage(document, document.URL).actionReady, false);

document = createDocument(`
  <section data-test="module-product-detail-add-to-cart">
    <button id="main">Preorder</button>
  </section>
`);
let snapshot = snapshotProductPage(document, document.URL);
assert.strictEqual(snapshot.actionLabel, "Preorder");
assert.strictEqual(snapshot.actionReady, true);

document = createDocument(`
  <section data-test="module-product-detail-add-to-cart">
    <button id="main">Buy now</button>
  </section>
`);
snapshot = snapshotProductPage(document, document.URL);
assert.strictEqual(snapshot.actionLabel, "Buy now");
assert.strictEqual(snapshot.actionReady, true);

document = createDocument(`
  <section data-test="module-product-detail-add-to-cart">
    <div hidden>
      <button id="hidden-buy-now">Buy now</button>
    </div>
    <button id="visible-add-to-cart">Add to cart</button>
  </section>
`);
action = findMainProductAction(document);
assert.strictEqual(action.id, "visible-add-to-cart");
snapshot = snapshotProductPage(document, document.URL);
assert.strictEqual(snapshot.actionLabel, "Add to cart");
assert.strictEqual(snapshot.actionReady, true);

document = createDocument(`
  <section data-test="module-product-detail-add-to-cart">
    <button id="main">Add to cart</button>
  </section>
  <aside data-test="recommendations">
    <p>Currently unavailable</p>
    <p>Added to cart</p>
  </aside>
`);
snapshot = snapshotProductPage(document, document.URL);
assert.strictEqual(snapshot.failureVisible, false);
assert.strictEqual(snapshot.successVisible, false);
assert.strictEqual(snapshot.actionReady, true);

document = createDocument(`
  <section data-test="module-product-detail-add-to-cart">
    <button id="main">Add to cart</button>
  </section>
  <div role="status">A recommended item is currently unavailable</div>
`);
snapshot = snapshotProductPage(document, document.URL);
assert.strictEqual(snapshot.failureVisible, false);
assert.strictEqual(snapshot.actionReady, true);

document = createDocument(`
  <div role="dialog">Item not added to cart
    <a href="/cart">View cart & check out</a>
  </div>
`);
snapshot = snapshotProductPage(document, document.URL);
assert.strictEqual(snapshot.failureVisible, true);
assert.strictEqual(snapshot.successVisible, false);

document = createDocument(`
  <div role="status" data-test="add-to-cart-toast">Added to cart</div>
  <a href="/cart">View cart & check out</a>
`);
snapshot = snapshotProductPage(document, document.URL);
assert.strictEqual(snapshot.failureVisible, false);
assert.strictEqual(snapshot.successVisible, true);
assert.strictEqual(
  isProductStateForUrl(
    {
      productId: "A-1010892065",
      url: "https://www.target.com/p/example/-/A-1010892065",
    },
    "https://www.target.com/p/example/-/A-1010892065",
  ),
  true,
);
assert.strictEqual(
  isProductStateForUrl(
    {
      productId: "A-1010892065",
      url: "https://www.target.com/p/example/-/A-1010892065",
    },
    "https://www.target.com/p/example/-/A-1010892068",
  ),
  false,
);
assert.strictEqual(
  isProductStateForUrl(
    {
      productId: "A-1010892065",
      url: "https://www.target.com/p/example/-/A-1010892065",
    },
    "https://www.target.com/p/different/-/A-1010892065",
  ),
  false,
);

(async () => {
  let clicks = 0;
  let refreshes = 0;
  const reports = [];
  const productAction = {
    click() {
      clicks += 1;
    },
  };
  await executeProductDecision(
    { type: "click-product", label: "Add to cart" },
    {
      action: productAction,
      claim: async () => "product-token",
      authorize: async () => true,
      refresh: () => {
        refreshes += 1;
      },
      report: (phase, detail) => {
        reports.push({ phase, detail });
      },
    },
  );
  assert.strictEqual(clicks, 1);
  assert.strictEqual(refreshes, 0);
  assert.deepStrictEqual(reports, []);

  clicks = 0;
  reports.length = 0;
  await executeProductDecision(
    { type: "click-product", label: "Add to cart" },
    {
      action: productAction,
      claim: async () => null,
      authorize: async () => true,
      refresh: () => {
        refreshes += 1;
      },
      report: (phase, detail) => {
        reports.push({ phase, detail });
      },
    },
  );
  assert.strictEqual(clicks, 0);
  assert.deepStrictEqual(reports, []);

  await executeProductDecision(
    { type: "click-product", label: "Add to cart" },
    {
      action: productAction,
      claim: async () => "product-token",
      authorize: async () => false,
      refresh: () => {
        refreshes += 1;
      },
      report: (phase, detail) => {
        reports.push({ phase, detail });
      },
    },
  );
  assert.strictEqual(clicks, 0);
  assert.deepStrictEqual(reports, []);

  await executeProductDecision(
    { type: "pause-buy-now" },
    {
      action: productAction,
      claim: async () => "unused-token",
      authorize: async () => true,
      refresh: () => {
        refreshes += 1;
      },
      report: (phase, detail) => {
        reports.push({ phase, detail });
      },
    },
  );
  assert.strictEqual(clicks, 0);
  assert.strictEqual(refreshes, 0);
  assert.strictEqual(reports.at(-1).phase, "buy-now");

  await executeProductDecision(
    { type: "refresh", label: "Preorder" },
    {
      action: productAction,
      claim: async () => "unused-token",
      authorize: async () => true,
      refresh: () => {
        refreshes += 1;
      },
      report: (phase, detail) => {
        reports.push({ phase, detail });
      },
    },
  );
  assert.strictEqual(clicks, 0);
  assert.strictEqual(refreshes, 1);
  assert.strictEqual(reports.at(-1).phase, "monitoring");

  let dismissedFailures = 0;
  await executeProductDecision(
    { type: "cooldown", until: 15000 },
    {
      action: null,
      claim: async () => true,
      dismissFailure: async () => {
        dismissedFailures += 1;
      },
      refresh: () => {
        refreshes += 1;
      },
      report: (phase, detail) => {
        reports.push({ phase, detail });
      },
    },
  );
  assert.strictEqual(dismissedFailures, 1);
  assert.strictEqual(reports.at(-1).phase, "cooldown");

  await executeProductDecision(
    { type: "dismiss-failure-refresh" },
    {
      action: null,
      claim: async () => "unused-token",
      authorize: async () => true,
      dismissFailure: async () => {
        dismissedFailures += 1;
      },
      refresh: () => {
        refreshes += 1;
      },
      report: (phase, detail) => {
        reports.push({ phase, detail });
      },
    },
  );
  assert.strictEqual(dismissedFailures, 2);
  assert.strictEqual(refreshes, 1);

  await executeProductDecision(
    { type: "refresh" },
    {
      action: null,
      refresh: () => {
        refreshes += 1;
      },
      report: () => {},
    },
  );
  assert.strictEqual(refreshes, 2);

  console.log("target-extension-product tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
