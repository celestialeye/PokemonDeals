const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  defaultTargetBuyLimit,
  executeTargetBuyWorker,
  prepareTargetBuyRun,
  targetBuySettings,
} = require("../target-direct-buy");
const { targetSettingsDefaults } = require("../src/target-deal-settings");

const secrets = {
  target: { pin: null },
  discord: { webhookUrl: null },
};

test("Target direct buy uses a transient auto route with guards and solver enabled", () => {
  const prepared = prepareTargetBuyRun({
    targetUrl: "https://www.target.com/p/example/-/A-1007918679",
    secrets,
    settings: targetSettingsDefaults,
  });

  assert.equal(prepared.input.product.id, "A-1007918679");
  assert.equal(prepared.requestedMode, "direct-buy");
  assert.equal(prepared.effectiveSettings.maxItemPrice, defaultTargetBuyLimit);
  assert.equal(prepared.effectiveSettings.maxOrderTotal, defaultTargetBuyLimit);
  assert.match(
    prepared.run.args.at(-1),
    /^direct-buy=https:\/\/www\.target\.com\/p\/example\/-\/A-1007918679$/,
  );
  assert.equal(
    prepared.run.env.TARGET_CHALLENGE_SOLVER,
    "./target-challenge-solver.js",
  );
  assert.equal(prepared.run.env.TARGET_CHALLENGE_VALIDATE, undefined);
  assert.equal(prepared.run.env.TARGET_STOP_BEFORE_SUBMIT, undefined);
  assert.equal(prepared.run.env.TARGET_MAX_ITEM_PRICE, defaultTargetBuyLimit);
  assert.equal(prepared.run.env.TARGET_MAX_ORDER_TOTAL, defaultTargetBuyLimit);
  assert.equal(prepared.run.env.TARGET_EXPECTED_FULFILLMENT, "shipping");
  assert.equal(prepared.run.env.TARGET_CHALLENGE_TIMEOUT_MS, "45000");
  assert.equal(prepared.run.env.TARGET_MONITOR_POLL_MS, "1000");
  assert.equal(prepared.run.env.TARGET_SESSION_RESET_ON_STUCK, "0");
  assert.equal(prepared.run.env.TARGET_BUY_PRODUCT_URL, undefined);
  assert.equal(prepared.run.env.TARGET_BUY_MODE, undefined);
  assert.equal(prepared.run.env.TARGET_DISABLE_DISCORD_ALERTS, "1");
  assert.equal(prepared.run.env.DISCORD_WEBHOOK_URL, undefined);
});

test("Target direct buy preserves stricter configured guards and explicit actions", () => {
  const prepared = prepareTargetBuyRun({
    targetUrl: "https://www.target.com/p/example/-/A-1007918679",
    mode: "buy-now",
    secrets,
    settings: {
      ...targetSettingsDefaults,
      maxItemPrice: "49.99",
      maxOrderTotal: "60.00",
      expectedFulfillment: "shipping",
    },
  });

  assert.equal(prepared.requestedMode, "buy-now");
  assert.match(prepared.run.args.at(-1), /^buy-now=/);
  assert.equal(prepared.run.env.TARGET_MAX_ITEM_PRICE, "49.99");
  assert.equal(prepared.run.env.TARGET_MAX_ORDER_TOTAL, "60.00");
  assert.equal(prepared.run.env.TARGET_EXPECTED_FULFILLMENT, "shipping");
});

test("Target direct buy setting defaults do not weaken configured limits", () => {
  const settings = targetBuySettings({
    ...targetSettingsDefaults,
    maxItemPrice: "12.34",
    maxOrderTotal: "56.78",
  });

  assert.equal(settings.maxItemPrice, "12.34");
  assert.equal(settings.maxOrderTotal, "56.78");
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function fakeRun() {
  return {
    command: process.execPath,
    args: [],
    env: {},
  };
}

test("Target direct buy succeeds only after explicit order confirmation", async () => {
  const child = fakeChild();
  const logged = [];
  const completed = executeTargetBuyWorker(
    fakeRun(),
    { write: (_level, values) => logged.push(values.join(" ")) },
    {
      spawnImpl: () => child,
      output: { write: () => {} },
      errorOutput: { write: () => {} },
    },
  );

  child.stdout.emit(
    "data",
    Buffer.from('TARGET_ORDER_CONFIRMED {"productId":"A-1007918679"}\n'),
  );
  child.emit("close", 0, null);

  await completed;
  assert.ok(logged.some((line) => line.startsWith("TARGET_ORDER_CONFIRMED")));
});

test("Target direct buy fails closed when the worker exits without confirmation", async () => {
  const child = fakeChild();
  const completed = executeTargetBuyWorker(
    fakeRun(),
    { write: () => {} },
    {
      spawnImpl: () => child,
      output: { write: () => {} },
      errorOutput: { write: () => {} },
    },
  );

  child.emit("close", 0, null);

  await assert.rejects(completed, /TARGET_BUY_OUTCOME_UNCONFIRMED/);
});

test("a later safety stop overrides an earlier confirmed order", async () => {
  const child = fakeChild();
  const completed = executeTargetBuyWorker(
    fakeRun(),
    { write: () => {} },
    {
      spawnImpl: () => child,
      output: { write: () => {} },
      errorOutput: { write: () => {} },
    },
  );
  child.stdout.emit(
    "data",
    Buffer.from('TARGET_ORDER_CONFIRMED {"productId":"A-1007918679"}\n'),
  );
  child.stderr.emit(
    "data",
    Buffer.from('TARGET_TERMINAL_SAFETY_STOP {"reason":"checkout-blocked"}\n'),
  );
  child.emit("close", 0, null);
  await assert.rejects(completed, /TARGET_TERMINAL_SAFETY_STOP/);
});

test("Target worker streaming redacts split PIN fill traces before terminal output", async () => {
  const child = fakeChild();
  const printed = [];
  const events = [];
  const completed = executeTargetBuyWorker(
    fakeRun(),
    { write: () => {} },
    {
      spawnImpl: () => child,
      output: { write: (text) => printed.push(text) },
      errorOutput: { write: (text) => printed.push(text) },
      onLine: (level, line) => events.push({ level, line }),
    },
  );
  child.stderr.emit("data", Buffer.from('PIN_CONTROL_REPLACED fill("12'));
  child.stderr.emit("data", Buffer.from('34")\n'));
  child.stdout.emit(
    "data",
    Buffer.from('TARGET_ORDER_CONFIRMED {"productId":"A-1007918679"}\n'),
  );
  child.emit("close", 0, null);
  await completed;
  assert.doesNotMatch(printed.join(""), /1234/);
  assert.match(printed.join(""), /fill\("<redacted>"\)/);
  assert.ok(events.some((event) =>
    event.level === "info" && event.line.startsWith("TARGET_ORDER_CONFIRMED")));
});
