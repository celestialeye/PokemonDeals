const assert = require("node:assert/strict");
const test = require("node:test");
const { inspectChallenge, visibleScopes } = require("../target-challenge-page");
const { fakePage } = require("./helpers/target-challenge-fakes");

test("detects an iframe-only challenge through nested visible scopes", async () => {
  const leaf = fakePage({ body: "Press and hold" });
  const page = fakePage({ body: "", children: [fakePage({ body: "", children: [leaf] })] });
  assert.equal((await inspectChallenge(page)).kind, "press_and_hold");
});

test("hidden stale frames do not block an otherwise readable product page", async () => {
  const child = fakePage();
  child.visible = false;
  const page = fakePage({ body: "Pokemon product Add to cart", children: [child] });
  assert.equal((await inspectChallenge(page)).detected, false);
});

test("normal product is clear but empty, closed, and unreadable pages are blocked", async () => {
  assert.equal((await inspectChallenge(fakePage({ body: "Pokemon product" }))).detected, false);
  for (const page of [fakePage({ body: "" }), fakePage({ readError: true }), fakePage({ body: "Product", url: "about:blank" })]) {
    assert.equal((await inspectChallenge(page)).unreadable, true);
  }
  const closed = fakePage({ body: "Product" });
  closed.state.closed = true;
  assert.equal((await inspectChallenge(closed)).unreadable, true);
});

test("an unreadable visible frame cannot produce false clearance", async () => {
  const page = fakePage({ body: "Product", children: [fakePage({ readError: true })] });
  assert.equal((await inspectChallenge(page)).unreadable, true);
});

test("inspection deadline handles stalled page reads without trusting blank evidence", async () => {
  const page = fakePage();
  page.title = () => new Promise(() => {});
  assert.equal((await inspectChallenge(page, { timeoutMs: 20 })).unreadable, true);
});

test("excessive visible frame trees fail closed", async () => {
  const page = fakePage({ body: "Product", children: Array.from({ length: 33 }, () => fakePage()) });
  assert.equal((await inspectChallenge(page)).unreadable, true);
});

function browserFrame({ closed = true, visible = true, parent } = {}) {
  const frame = fakePage();
  frame.parentFrame = () => parent;
  frame.frameElement = async () => ({
    isVisible: async () => visible,
    evaluate: async () => closed,
    dispose: async () => {},
  });
  return frame;
}

test("browser frame enumeration includes visible scopes once and excludes hidden copies", async () => {
  const page = fakePage({ body: "Product", controls: [] });
  const main = { parentFrame: () => null };
  const visible = browserFrame({ parent: main });
  const hidden = browserFrame({ parent: main, visible: false });
  const ordinary = browserFrame({ parent: main, closed: false });
  page.frames = () => [main, visible, hidden, ordinary];
  const scopes = await visibleScopes(page, (operation) => operation());
  assert.deepEqual(scopes, [page, visible, ordinary]);
  assert.equal((await inspectChallenge(page)).kind, "press_and_hold");
});

test("a closed-shadow frame inside a hidden ancestor is excluded", async () => {
  const page = fakePage({ body: "Product", controls: [] });
  const main = { parentFrame: () => null };
  const hiddenParent = browserFrame({ parent: main, visible: false, closed: false });
  const child = browserFrame({ parent: hiddenParent });
  page.frames = () => [main, hiddenParent, child];
  assert.deepEqual(await visibleScopes(page, (operation) => operation()), [page]);
  assert.equal((await inspectChallenge(page)).detected, false);
});

test("browser frame enumeration remains bounded", async () => {
  const page = fakePage({ body: "Product" });
  page.frames = () => Array.from({ length: 65 }, () => ({}));
  assert.equal((await inspectChallenge(page)).unreadable, true);
});
