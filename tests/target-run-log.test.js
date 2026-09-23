const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createTargetRunLogger,
  sanitizeTargetLogText,
} = require("../src/target-run-log");

test("Target run logging redacts checkout parameters, credentials, and order IDs", () => {
  const sanitized = sanitizeTargetLogText(
    [
      "https://www.target.com/checkout?secret=checkout-token",
      "https://www.target.com/p/example/-/A-1007918679?affiliate=tracking-value",
      "Order number: ABCD-1234-SECRET",
      "cookie=session-secret",
      '{"authorization":"header-secret"}',
      'locator.fill: - fill("1234")',
    ].join("\n"),
  );

  assert.doesNotMatch(
    sanitized,
    /checkout-token|tracking-value|ABCD-1234-SECRET|session-secret|header-secret|1234/,
  );
  assert.match(sanitized, /target\.com\/checkout\?<redacted>/);
  assert.match(sanitized, /target\.com\/p\/example\/-\/A-1007918679\?<redacted>/);
  assert.match(sanitized, /<redacted-order-id>/);
  assert.match(sanitized, /cookie=<redacted>/);
  assert.match(sanitized, /authorization":"<redacted>"/);
  assert.match(sanitized, /fill\("<redacted>"\)/);
});

test("Target run logging writes structured safe events", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pokemon-deals-target-log-"),
  );
  const logPath = path.join(directory, "run.jsonl");

  try {
    const logger = createTargetRunLogger({
      workflow: "target-direct-buy",
      metadata: {
        productId: "A-1007918679",
        cookie: "metadata-secret",
      },
      logPath,
    });
    logger.write("info", [
      "TARGET_ORDER_CONFIRMED Order number: ABCD-1234-SECRET",
    ]);

    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(record.workflow, "target-direct-buy");
    assert.equal(record.event, "TARGET_ORDER_CONFIRMED");
    assert.equal(record.productId, "A-1007918679");
    assert.equal(record.cookie, "<redacted>");
    assert.doesNotMatch(record.message, /ABCD-1234-SECRET/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
