const assert = require("node:assert/strict");
const test = require("node:test");
const {
  classifyOrderHistory,
  confirmTargetOrder,
} = require("../src/target-order-history");

const submittedAt = "2026-09-23T06:29:24.000Z";
const productId = "A-90172677";

function order(date, lines = [{ tcin: "90172677", quantity: 1 }]) {
  return {
    order_date: date,
    order_type: "Sales",
    packages: [{
      order_lines: lines.map((line) => ({
        quantity: line.quantity,
        item: { tcin: line.tcin },
      })),
    }],
  };
}

test("history confirms one new order for one exact product and quantity", () => {
  const history = {
    orders: [
      order("2026-09-23T06:29:26.000Z"),
      order("2026-09-22T06:29:26.000Z"),
    ],
  };
  assert.equal(
    classifyOrderHistory(history, { productId, submittedAt }),
    "confirmed",
  );
});

test("history never uses an older or wrong-product order as confirmation", () => {
  assert.equal(classifyOrderHistory({
    orders: [order("2026-09-23T06:24:26.000Z")],
  }, { productId, submittedAt }), "absent");
  assert.equal(classifyOrderHistory({
    orders: [order("2026-09-23T06:29:14.000Z")],
  }, { productId, submittedAt }), "absent");
  assert.equal(classifyOrderHistory({
    orders: [order("2026-09-23T06:29:26.000Z", [
      { tcin: "1010892076", quantity: 1 },
    ])],
  }, { productId, submittedAt }), "absent");
});

test("duplicate and mixed-item orders are ambiguous, never success", () => {
  assert.equal(classifyOrderHistory({
    orders: [
      order("2026-09-23T06:29:26.000Z"),
      order("2026-09-23T06:29:27.000Z"),
    ],
  }, { productId, submittedAt }), "ambiguous");
  assert.equal(classifyOrderHistory({
    orders: [order("2026-09-23T06:29:26.000Z", [
      { tcin: "90172677", quantity: 1 },
      { tcin: "1010892076", quantity: 1 },
    ])],
  }, { productId, submittedAt }), "ambiguous");
});

test("ambiguous checkout checks history read-only without another order click", async () => {
  let reads = 0;
  let waits = 0;
  const result = await confirmTargetOrder({
    productId,
    submittedAt,
    attempts: 3,
    intervalMs: 1000,
    readHistory: async () => {
      reads += 1;
      return reads === 2
        ? { orders: [order("2026-09-23T06:29:26.000Z")] }
        : { orders: [] };
    },
    wait: async () => { waits += 1; },
  });
  assert.equal(result, "confirmed");
  assert.equal(reads, 2);
  assert.equal(waits, 1);
});
