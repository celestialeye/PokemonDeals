const assert = require("node:assert/strict");
const test = require("node:test");
const {
  challengeKind,
  detectChallenge,
  loadChallengeSolver,
  resolutionOutcome,
  resolveChallenge,
} = require("../target-challenge");

const noWait = async () => {};

test("detects press & hold from the quick verification copy", () => {
  const result = detectChallenge({
    url: "https://www.target.com/p/-/A-1007918679",
    title: "Target",
    body: "Quick verification\nPress & Hold to confirm you are\na human (and not a bot).",
  });
  assert.equal(result.detected, true);
  assert.equal(result.kind, challengeKind.pressAndHold);
});

test("classifies other blocks as generic challenges", () => {
  const result = detectChallenge({
    url: "https://www.target.com/blocked",
    body: "Access Denied",
  });
  assert.equal(result.detected, true);
  assert.equal(result.kind, challengeKind.generic);
});

test("a normal product page is not a challenge", () => {
  const result = detectChallenge({
    url: "https://www.target.com/p/-/A-1007918679",
    title: "Pokemon Card Game",
    body: "Add to cart\nShip it\nPreorder",
  });
  assert.equal(result.detected, false);
  assert.equal(result.kind, challengeKind.none);
});

test("returns unsupported when no solver is injected", async () => {
  const result = await resolveChallenge({
    solver: null,
    verifyCleared: async () => true,
  });
  assert.equal(result.outcome, resolutionOutcome.unsupported);
  assert.equal(result.attempts, 0);
});

test("clears once verification confirms the page recovered", async () => {
  let solverCalls = 0;
  let cleared = false;
  const result = await resolveChallenge({
    solver: async () => {
      solverCalls += 1;
      if (solverCalls === 2) {
        cleared = true;
      }
    },
    wait: noWait,
    verifyCleared: async () => cleared,
  });
  assert.equal(result.outcome, resolutionOutcome.cleared);
  assert.equal(result.attempts, 2);
  assert.equal(solverCalls, 2);
});

test("a solver that claims success but leaves the page blocked stays unresolved", async () => {
  const result = await resolveChallenge({
    solver: async () => true,
    maxAttempts: 2,
    wait: noWait,
    verifyCleared: async () => false,
  });
  assert.equal(result.outcome, resolutionOutcome.unresolved);
  assert.equal(result.attempts, 2);
});

test("solver exceptions are retried and reported as failed", async () => {
  const result = await resolveChallenge({
    solver: async () => {
      throw new Error("hold interrupted");
    },
    maxAttempts: 3,
    wait: noWait,
    verifyCleared: async () => false,
  });
  assert.equal(result.outcome, resolutionOutcome.failed);
  assert.equal(result.attempts, 3);
  assert.equal(result.error, "hold interrupted");
});

test("an unsupported challenge uses one attempt per recovery cycle", async () => {
  let calls = 0;
  const result = await resolveChallenge({
    solver: async () => {
      calls += 1;
      throw new Error("CHALLENGE_KIND_UNSUPPORTED");
    },
    maxAttempts: 3,
    wait: noWait,
    verifyCleared: async () => false,
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.outcome, resolutionOutcome.failed);
});

test("verifyCleared is mandatory", async () => {
  await assert.rejects(
    () => resolveChallenge({ solver: async () => true }),
    /verifyCleared/,
  );
});

test("loads function and object exports, rejects invalid modules, and supports unset", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "target-solver-loader-"));
  try {
    for (const [name, source] of [
      ["function", "module.exports = async () => {};"],
      ["object", "module.exports = { solveChallenge: async () => {} };"],
      ["invalid", "module.exports = {};"],
    ]) {
      fs.writeFileSync(path.join(directory, `${name}.cjs`), source);
    }
    assert.equal(loadChallengeSolver(""), null);
    assert.equal(typeof loadChallengeSolver(path.join(directory, "function.cjs")), "function");
    assert.equal(typeof loadChallengeSolver(path.join(directory, "object.cjs")), "function");
    assert.equal(typeof loadChallengeSolver("./target-challenge-solver.js"), "function");
    assert.throws(() => loadChallengeSolver(path.join(directory, "invalid.cjs")), /must export/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
