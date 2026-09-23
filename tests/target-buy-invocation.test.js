const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  readActiveTargetBuyInvocation,
  resolveTargetBuyInvocation,
} = require("../src/target-buy-invocation");

const currentUrl =
  "https://www.target.com/p/ge-6-outlet-power-strip-1-usb-a-1-usb-c-15w-shared-6ft-braided-cord-white/-/A-90172677";
const oldUrl = "https://www.target.com/p/old-product/-/A-95025127";
const skill = (turnId, trigger = "user-invoked") => ({
  type: "skill.invoked",
  data: { name: "target-buy", trigger, invokedAtTurn: turnId },
});
const message = (turnId, content, transformedContent = "") => ({
  type: "user.message",
  data: { turnId, content, transformedContent },
});

test("resolves the raw URL of the active invoked turn, not a prior or transformed URL", () => {
  const input = resolveTargetBuyInvocation([
    skill(0),
    message(0, `/target-buy ${oldUrl}`),
    skill(1),
    message(1, `/target-buy ${currentUrl}`, `Example: ${oldUrl}`),
  ]);
  assert.equal(input.product.id, "A-90172677");
  assert.equal(input.url, currentUrl);
});

test("refuses to reuse an earlier invocation after a different user turn", () => {
  assert.throws(
    () => resolveTargetBuyInvocation([
      skill(0),
      message(0, `/target-buy ${oldUrl}`),
      message(1, "Why is it not buying?"),
    ]),
    /TARGET_BUY_INPUT_MISSING/,
  );
});

test("requires a user-invoked skill event matching the raw user turn", () => {
  assert.throws(
    () => resolveTargetBuyInvocation([
      skill(0, "model-invoked"),
      message(0, `/target-buy ${currentUrl}`),
    ]),
    /TARGET_BUY_INPUT_MISSING/,
  );
  assert.throws(
    () => resolveTargetBuyInvocation([
      skill(0),
      message(1, `/target-buy ${currentUrl}`),
    ]),
    /TARGET_BUY_INPUT_MISSING/,
  );
});

test("rejects missing, extra, and invalid URLs without echoing input", () => {
  assert.throws(
    () => resolveTargetBuyInvocation([skill(0), message(0, "/target-buy")]),
    /TARGET_BUY_INPUT_MISSING/,
  );
  assert.throws(
    () => resolveTargetBuyInvocation([
      skill(0),
      message(0, `/target-buy ${oldUrl} ${currentUrl}`),
    ]),
    (error) => error.message.startsWith("TARGET_BUY_INPUT_INVALID") &&
      !error.message.includes(oldUrl),
  );
  assert.throws(
    () => resolveTargetBuyInvocation([
      skill(0),
      message(0, "/target-buy https://example.com/p/-/A-90172677"),
    ]),
    /TARGET_BUY_INPUT_INVALID/,
  );
});

test("reads only the active session event file, ignoring a partial trailing event", () => {
  const sessionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "target-buy-invocation-"),
  );
  const active = "0a1f1c74-2ece-47d0-87a0-9f1715c079ba";
  const previous = "973eb5fb-4ff1-48b8-9f41-3ea2e0887b61";
  try {
    for (const [sessionId, url] of [[active, currentUrl], [previous, oldUrl]]) {
      const directory = path.join(sessionRoot, sessionId);
      fs.mkdirSync(directory);
      fs.writeFileSync(
        path.join(directory, "events.jsonl"),
        `${JSON.stringify(skill(0))}\n${JSON.stringify(message(0, `/target-buy ${url}`))}\n{"type":"tool`,
      );
    }
    const input = readActiveTargetBuyInvocation({
      sessionId: active,
      sessionRoot,
    });
    assert.equal(input.product.id, "A-90172677");
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});
