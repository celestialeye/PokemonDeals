const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  createAmazonRunLogger,
  sanitizeAmazonLogText,
} = require("../src/amazon-run-log");

test("redacts checkout URLs, offer tokens, order IDs, and session values", () => {
  const sanitized = sanitizeAmazonLogText(
    [
      "https://www.amazon.com/checkout/entry/buynow?asin=B0GW2DK37Q&offeringID=secret-token",
      "https://www.amazon.com/gp/buy/spc/handlers/display.html?purchaseId=secret-execution-id",
      "https://www.amazon.com/checkout?purchaseId=root-checkout-secret",
      "https://www.amazon.com/gp/buy?purchaseId=root-buy-secret",
      "offerListingID=another-secret",
      "ORDER # 113-1234567-1234567",
      "authorization=Bearer credential",
      "cookie=session=credential; payment=another-secret",
      '{"cookie":"json-cookie-secret","authorization":"Bearer json-auth-secret","offerListingID":"json-offer-secret"}',
    ].join("\n"),
  );

  assert.doesNotMatch(
    sanitized,
    /secret-token|secret-execution-id|root-checkout-secret|root-buy-secret|another-secret|113-1234567|credential|json-cookie-secret|json-auth-secret|json-offer-secret/,
  );
  assert.match(sanitized, /checkout\/entry\/buynow\?<redacted>/);
  assert.match(sanitized, /gp\/buy\/spc\/handlers\/display\.html\?<redacted>/);
  assert.match(sanitized, /amazon\.com\/checkout\?<redacted>/);
  assert.match(sanitized, /amazon\.com\/gp\/buy\?<redacted>/);
  assert.match(sanitized, /offerListingID=<redacted>/);
  assert.match(sanitized, /<redacted-order-id>/);
  assert.match(sanitized, /authorization=<redacted>/);
  assert.match(sanitized, /cookie=<redacted>/);
});

test("redacts sensitive metadata based on its key", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pokemon-deals-amazon-log-"),
  );
  const logPath = path.join(directory, "run.jsonl");

  try {
    const logger = createAmazonRunLogger({
      workflow: "metadata-redaction",
      metadata: {
        asin: "B0GW2DK37Q",
        cookie: "metadata-cookie-secret",
        offerListingID: "metadata-offer-secret",
      },
      logPath,
    });
    logger.write("info", ["AMAZON_TEST"]);
    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(record.asin, "B0GW2DK37Q");
    assert.equal(record.cookie, "<redacted>");
    assert.equal(record.offerListingID, "<redacted>");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("writes structured JSONL records with safe run metadata", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pokemon-deals-amazon-log-"),
  );
  const logPath = path.join(directory, "run.jsonl");

  try {
    const logger = createAmazonRunLogger({
      workflow: "amazon-direct-buy",
      metadata: {
        asin: "B0GW2DK37Q",
      },
      logPath,
    });
    logger.write("info", [
      "AMAZON_DIRECT_CHECKOUT_FOUND offeringID=secret-token",
    ]);
    logger.write("error", [
      "AMAZON_ORDER_CONFIRMATION_AMBIGUOUS ORDER # 113-1234567-1234567",
    ]);

    const records = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 2);
    assert.equal(records[0].workflow, "amazon-direct-buy");
    assert.equal(records[0].asin, "B0GW2DK37Q");
    assert.equal(records[0].event, "AMAZON_DIRECT_CHECKOUT_FOUND");
    assert.doesNotMatch(records[0].message, /secret-token/);
    assert.equal(records[1].event, "AMAZON_ORDER_CONFIRMATION_AMBIGUOUS");
    assert.doesNotMatch(records[1].message, /113-1234567-1234567/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sanitizes console output before printing or persisting it", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pokemon-deals-amazon-log-"),
  );
  const logPath = path.join(directory, "run.jsonl");
  const modulePath = path.resolve(__dirname, "../src/amazon-run-log");
  const script = [
    `process.env.AMAZON_RUN_LOG_PATH = ${JSON.stringify(logPath)};`,
    `const { installAmazonRunLogger } = require(${JSON.stringify(modulePath)});`,
    'installAmazonRunLogger({ workflow: "console-redaction" });',
    'console.error("Authorization: Bearer console-secret");',
    'console.log("https://www.amazon.com/gp/buy/spc/handlers/display.html?purchaseId=execution-secret");',
  ].join("\n");

  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const combined = `${result.stdout}\n${result.stderr}\n${fs.readFileSync(logPath, "utf8")}`;
    assert.doesNotMatch(combined, /console-secret|execution-secret/);
    assert.match(combined, /Authorization: <redacted>/);
    assert.match(combined, /gp\/buy\/spc\/handlers\/display\.html\?<redacted>/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
