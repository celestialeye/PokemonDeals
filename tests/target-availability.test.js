const assert = require("node:assert/strict");
const {
  calculateBackoffMs,
  isAvailabilityResponseUrl,
  isChallengeResponse,
  replaceEndpointProduct,
  summarizeAvailabilityPayload,
  targetProductFromUrl,
} = require("../target-availability");
const { parseProducts } = require("../target-watch");

const product = targetProductFromUrl(
  "https://www.target.com/p/pokemon-box/-/A-1010892076?preselect=123",
);
assert.deepEqual(product, {
  id: "A-1010892076",
  tcin: "1010892076",
  url: "https://www.target.com/p/pokemon-box/-/A-1010892076?preselect=123",
});
assert.equal(targetProductFromUrl("https://example.com/p/-/A-1010892076"), null);
assert.equal(targetProductFromUrl("https://www.target.com/cart"), null);

assert.equal(
  isAvailabilityResponseUrl(
    "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?tcin=1010892076",
  ),
  true,
);
assert.equal(
  isAvailabilityResponseUrl(
    "https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?tcin=1010892076",
  ),
  true,
);
assert.equal(
  isAvailabilityResponseUrl(
    "https://www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules?tcin=1010892076",
  ),
  true,
);
assert.equal(isAvailabilityResponseUrl("https://www.target.com/p/test"), false);

assert.equal(isChallengeResponse({ status: 429 }), true);
assert.equal(
  isChallengeResponse({
    status: 200,
    contentType: "text/html",
    body: "window._pxAppId = 'PXGWPp4wUS'; Press & Hold",
  }),
  true,
);
assert.equal(
  isChallengeResponse({
    status: 200,
    contentType: "application/json",
    body: '{"data":{}}',
  }),
  false,
);

const available = summarizeAvailabilityPayload(
  {
    data: {
      product: {
        fulfillment: {
          shipping_options: {
            availability_status: "IN_STOCK",
          },
        },
      },
    },
  },
  product,
);
assert.equal(available.available, true);
assert.equal(available.action, "purchase");
assert.equal(available.confidence, "candidate");

const availableWithClosedPreorder = summarizeAvailabilityPayload(
  {
    data: {
      product: {
        fulfillment: {
          pre_order_location_available_to_promise_quantity: 0,
          shipping_options: { availability_status: "IN_STOCK" },
        },
      },
    },
  },
  product,
);
assert.equal(availableWithClosedPreorder.available, true);
assert.equal(availableWithClosedPreorder.action, "purchase");

const preorder = summarizeAvailabilityPayload(
  {
    data: {
      product: {
        fulfillment: {
          preorder_eligible: true,
          availability_status: "AVAILABLE",
        },
      },
    },
  },
  product,
);
assert.equal(preorder.available, true);
assert.equal(preorder.action, "preorder");

const unavailable = summarizeAvailabilityPayload(
  {
    data: {
      product: {
        fulfillment: {
          shipping_options: {
            availability_status: "OUT_OF_STOCK",
          },
          online_purchase_validation: {
            is_valid_for_fulfillment: false,
          },
        },
      },
    },
  },
  product,
);
assert.equal(unavailable.available, false);
assert.equal(unavailable.action, null);
assert.equal(unavailable.confidence, "unavailable");

const eligibleButClosed = summarizeAvailabilityPayload(
  {
    data: {
      product: {
        fulfillment: {
          preorder_eligible: true,
          availability_status: "OUT_OF_STOCK",
        },
      },
    },
  },
  product,
);
assert.equal(eligibleButClosed.available, false);
assert.equal(eligibleButClosed.action, null);

const recommendationsDoNotOverrideProduct = summarizeAvailabilityPayload(
  {
    modules: [
      {
        module_data: {
          product: {
            tcin: "1010892076",
            fulfillment: {
              shipping_options: { availability_status: "OUT_OF_STOCK" },
            },
          },
          recommended_products: [
            {
              redsky_product: {
                tcin: "9999999999",
                fulfillment: {
                  shipping_options: { availability_status: "IN_STOCK" },
                },
              },
            },
          ],
        },
      },
    ],
  },
  product,
);
assert.equal(recommendationsDoNotOverrideProduct.available, false);
assert.equal(recommendationsDoNotOverrideProduct.confidence, "unavailable");

assert.equal(
  replaceEndpointProduct(
    "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?key=test&tcin=11111111",
    "1010892076",
  ),
  "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?key=test&tcin=1010892076",
);
assert.equal(
  replaceEndpointProduct(
    "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?key=test",
    "1010892076",
  ),
  null,
);

assert.equal(calculateBackoffMs(0, 60000, 1800000), 60000);
assert.equal(calculateBackoffMs(2, 60000, 1800000), 240000);
assert.equal(calculateBackoffMs(8, 60000, 1800000), 1800000);

assert.equal(
  parseProducts([
    "preorder=https://www.target.com/p/one/-/A-1010892076",
    "buy-now=https://www.target.com/p/two/-/A-1010892065",
  ]).length,
  2,
);
assert.throws(
  () =>
    parseProducts([
      "preorder=https://www.target.com/p/one/-/A-1010892076",
      "add-to-cart=https://www.target.com/p/duplicate/-/A-1010892076",
    ]),
  /conflicting modes/,
);
assert.throws(
  () =>
    parseProducts([
      "preorder=https://www.target.com/p/one/-/A-1010892076",
      "buy-now=https://www.target.com/p/two/-/A-1010892065",
      "add-to-cart=https://www.target.com/p/three/-/A-1010892068",
      "preorder=https://www.target.com/p/four/-/A-1010892078",
    ]),
  /maximum is 3/,
);
assert.equal(
  parseProducts([
    "https://www.target.com/p/one/-/A-1010892076",
  ])[0].requestedMode,
  "auto",
);
assert.throws(
  () =>
    parseProducts([
      "ship-it=https://www.target.com/p/one/-/A-1010892076",
    ]),
  /Unsupported/,
);

console.log("target availability tests passed");
