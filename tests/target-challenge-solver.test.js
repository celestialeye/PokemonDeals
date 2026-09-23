const assert = require("node:assert/strict");
const test = require("node:test");
const { createSolver } = require("../target-challenge-solver");
const { resolveChallenge } = require("../target-challenge");
const { inspectChallenge } = require("../target-challenge-page");
const { fakePage, fakeTime } = require("./helpers/target-challenge-fakes");

function solver(time = fakeTime(), env = {}) {
  return createSolver({ ...time, env: {
    TARGET_CHALLENGE_TIMEOUT_MS: "1500",
    ...env,
  } });
}
const context = (page) => ({ page, kind: "press_and_hold" });

test("native hold releases and driver independently verifies same-document recovery", async () => {
  const page = fakePage();
  page.state.clearOnRelease = true;
  const result = await resolveChallenge({
    ...context(page), solver: solver(), wait: async () => {},
    verifyCleared: async () => !(await inspectChallenge(page)).detected,
  });
  assert.equal(result.outcome, "cleared");
  assert.equal(page.events[0], "hover");
  assert.deepEqual(page.events[1], ["move", 50, 40]);
  assert.equal(page.events[2], "down");
  assert.equal(page.events.at(-2), "up");
  assert.equal(page.events.at(-1), "dispose");
  assert.ok(page.events.filter((event) => Array.isArray(event)).length > 1);
});

test("discovers nested frames and both label forms", async () => {
  const leaf = fakePage({ controls: [{ name: "Press & Hold" }] });
  const page = fakePage({ controls: [], children: [fakePage({ controls: [], children: [leaf] })] });
  await solver()(context(page));
  assert.ok(page.events.includes("down"));
  assert.ok(leaf.events.includes("hover"));
});

test("supports a custom text control when no button role exists", async () => {
  const page = fakePage({ controls: [{ name: "Press & Hold", textOnly: true }] });
  await solver()(context(page));
  assert.ok(page.state.released);
});

test("does not mistake a matching paragraph for a second role button", async () => {
  const page = fakePage({ controls: [{ name: "Press & Hold" }, { name: "Press & Hold", textOnly: true }] });
  await solver()(context(page));
  assert.ok(page.state.released);
});

for (const [name, controls] of [
  ["missing", []],
  ["hidden", [{ name: "Press & Hold", visible: false }]],
  ["disabled", [{ name: "Press & Hold", enabled: false }]],
]) {
  test(`${name} controls expire without input`, async () => {
    const page = fakePage({ controls });
    await assert.rejects(() => solver()(context(page)), /CHALLENGE_CONTROL_NOT_FOUND/);
    assert.equal(page.events.length, 0);
  });
}

test("ambiguous controls are rejected without arbitrary first selection", async () => {
  const page = fakePage({ controls: [{ name: "Press & Hold" }, { name: "Press and hold" }] });
  await assert.rejects(() => solver()(context(page)), /CHALLENGE_CONTROL_AMBIGUOUS/);
  assert.equal(page.events.length, 0);
});

test("retains element identity when progress changes its label", async () => {
  const page = fakePage();
  const time = fakeTime(() => { page.nodes[0].name = "Keep holding"; });
  await solver(time)(context(page));
  assert.ok(time.now() >= 200);
  assert.ok(page.state.released);
});

test("holds through temporary control disappearance until clear evidence", async () => {
  const page = fakePage();
  const time = fakeTime(() => {
    page.nodes[0].visible = false;
    if (time.now() >= 900) {
      page.state.body = "Pokemon product";
    }
  });
  await solver(time)(context(page));
  assert.equal(time.now(), 900);
  assert.ok(page.state.released);
});

test("holds until live page evidence clears rather than a fixed duration", async () => {
  const page = fakePage();
  const time = fakeTime((elapsed) => {
    if (elapsed >= 100) page.nodes[0].name = "Processing";
    if (elapsed >= 900) {
      assert.equal(page.state.released, false);
      page.state.body = "Pokemon product";
    }
  });
  await solver(time)(context(page));
  assert.equal(time.now(), 900);
  assert.ok(page.state.released);
});

test("page closure mid-hold still attempts release", async () => {
  const page = fakePage();
  await assert.rejects(() => solver(fakeTime(() => { page.state.closed = true; }))(context(page)), /CHALLENGE_PAGE_UNAVAILABLE/);
  assert.ok(page.events.includes("up"));
});

test("partial pointer-down failure releases and sanitizes browser errors", async () => {
  const page = fakePage();
  page.mouse.down = async () => { throw new Error("https://secret.example/?token=secret"); };
  await assert.rejects(() => solver()(context(page)), /^Error: CHALLENGE_BROWSER_ACTION_FAILED$/);
  assert.ok(page.events.includes("up"));
});

test("browser action failures report a safe stage without exposing browser URLs", async () => {
  const page = fakePage();
  page.mouse.down = async () => { throw new Error("https://secret.example/?token=secret"); };
  const logs = [];
  await assert.rejects(() => solver()({
    ...context(page),
    log: (message) => logs.push(message),
  }), /CHALLENGE_BROWSER_ACTION_FAILED/);
  assert.ok(logs.includes("TARGET_CHALLENGE_ACTION_FAILED stage=pointer-down"));
  assert.ok(logs.every((message) => !message.includes("secret.example")));
});

test("cleanup failures are failures, not successful attempts", async () => {
  const page = fakePage();
  page.mouse.up = async () => { throw new Error("transport lost"); };
  await assert.rejects(() => solver()(context(page)), /CHALLENGE_RELEASE_FAILED/);
});

test("missing geometry performs no pointer-down", async () => {
  const page = fakePage({ controls: [{ name: "Press & Hold", noGeometry: true }] });
  await assert.rejects(() => solver()(context(page)), /CHALLENGE_CONTROL_NO_GEOMETRY/);
  assert.ok(!page.events.includes("down"));
});

test("a persistent challenge exhausts driver attempts without false success", async () => {
  const page = fakePage();
  const result = await resolveChallenge({
    ...context(page), solver: solver(), maxAttempts: 2, wait: async () => {},
    verifyCleared: async () => !(await inspectChallenge(page)).detected,
  });
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.attempts, 2);
  assert.equal(page.events.filter((event) => event === "up").length, 2);
});

test("generic challenges and closed pages receive no input", async () => {
  const page = fakePage();
  await assert.rejects(() => solver()({ page, kind: "generic" }), /CHALLENGE_KIND_UNSUPPORTED/);
  page.state.closed = true;
  await assert.rejects(() => solver()(context(page)), /CHALLENGE_PAGE_UNAVAILABLE/);
  assert.equal(page.events.length, 0);
});

for (const value of ["NaN", "Infinity", "0", "45001", "1.5", ""]) {
  test(`rejects invalid attempt timeout ${JSON.stringify(value)}`, async () => {
    await assert.rejects(() => solver(fakeTime(), { TARGET_CHALLENGE_TIMEOUT_MS: value })(context(fakePage())), /TARGET_CHALLENGE_TIMEOUT_MS/);
  });
}

test("does not require a fixed hold duration", async () => {
  const page = fakePage();
  await solver(fakeTime(), { TARGET_CHALLENGE_TIMEOUT_MS: "1000" })(context(page));
  assert.ok(page.state.released);
});

test("a hung pointer command times out and cannot start later solver stages", async () => {
  const page = fakePage();
  let finishDown;
  page.mouse.down = () => new Promise((resolve) => { finishDown = resolve; });
  const logs = [];
  const solve = createSolver({ env: { TARGET_CHALLENGE_TIMEOUT_MS: "1100" } });
  await assert.rejects(() => solve({ ...context(page), log: (line) => logs.push(line) }), /CHALLENGE_OPERATION_TIMEOUT/);
  assert.ok(page.events.includes("up"));
  finishDown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logs, ["TARGET_CHALLENGE_ACTION_FAILED stage=pointer-down"]);
});
