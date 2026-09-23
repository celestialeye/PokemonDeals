const assert = require("node:assert/strict");
const test = require("node:test");
const { isTargetDomain } = require("../src/target-session-reset");

test("Target session reset matches only Target domains", () => {
  assert.equal(isTargetDomain("target.com"), true);
  assert.equal(isTargetDomain(".target.com"), true);
  assert.equal(isTargetDomain("carts.target.com"), true);
  assert.equal(isTargetDomain("amazon.com"), false);
  assert.equal(isTargetDomain("not-target.com"), false);
});
