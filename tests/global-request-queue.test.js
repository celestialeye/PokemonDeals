const assert = require("node:assert/strict");
const { GlobalRequestQueue } = require("../global-request-queue");

async function main() {
  let nowMs = 0;
  const starts = [];
  const queue = new GlobalRequestQueue({
    cooldownMs: 100,
    jitterRatio: 0,
    now: () => nowMs,
    wait: async (delayMs) => {
      nowMs += delayMs;
    },
  });

  const actions = [0, 1, 2].map((index) =>
    queue.enqueue(async () => {
      starts.push({ index, at: nowMs });
      nowMs += 5;
      return index;
    }),
  );
  assert.deepEqual(await Promise.all(actions), [0, 1, 2]);
  assert.deepEqual(starts, [
    { index: 0, at: 0 },
    { index: 1, at: 105 },
    { index: 2, at: 210 },
  ]);
  assert.deepEqual(queue.snapshot(), {
    completed: 3,
    active: 0,
    maximumActive: 1,
    lastCompletedAt: 215,
  });

  const failed = queue.enqueue(async () => {
    nowMs += 5;
    throw new Error("expected failure");
  });
  const recovered = queue.enqueue(async () => {
    starts.push({ index: 4, at: nowMs });
    return "recovered";
  });
  await assert.rejects(failed, /expected failure/);
  assert.equal(await recovered, "recovered");
  assert.equal(starts.at(-1).at, 420);
  assert.equal(queue.snapshot().maximumActive, 1);

  console.log("global request queue tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
