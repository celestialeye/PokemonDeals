const assert = require("node:assert/strict");
const test = require("node:test");
const {
  prepareWatchlistRun,
  resolveWatchlistEntries,
  watchlistSettings,
} = require("../src/target-watchlist");
const { targetSettingsDefaults } = require("../src/target-deal-settings");

const secrets = {
  target: { pin: null },
  discord: { webhookUrl: null },
};

function entry(id, suffix = id) {
  return {
    label: `Product ${id}`,
    group: "Test",
    shortUrl: `https://howl.link/${suffix}`,
    expectedProductId: `A-${id}`,
  };
}

test("watchlist resolves short links to exact distinct Target product IDs", async () => {
  const entries = [entry("1010892076"), entry("95120834")];
  const redirects = new Map([
    ["1010892076", "https://www.target.com/p/example/-/A-1010892076?tracking=private"],
    ["95120834", "https://www.target.com/p/example/-/A-95120834"],
  ]);
  const resolved = await resolveWatchlistEntries(entries, {
    fetchImpl: async (url) => ({
      headers: {
        get: (name) => name === "location"
          ? redirects.get(new URL(url).pathname.slice(1))
          : null,
      },
    }),
  });
  assert.deepEqual(resolved.map((item) => item.productId), [
    "A-1010892076",
    "A-95120834",
  ]);
  assert.deepEqual(resolved.map((item) => item.url), [
    "https://www.target.com/p/-/A-1010892076",
    "https://www.target.com/p/-/A-95120834",
  ]);
  assert.equal(JSON.stringify(resolved).includes("tracking=private"), false);
});

test("watchlist follows the observed affiliate hop but not an arbitrary host", async () => {
  const visited = [];
  const resolved = await resolveWatchlistEntries([entry("1010892076")], {
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      visited.push(host);
      const location = host === "howl.link"
        ? "https://goto.target.com/c/example"
        : host === "goto.target.com"
          ? "https://www.ojrq.net/p/example"
          : "https://www.target.com/p/-/A-1010892076";
      return { headers: { get: () => location } };
    },
  });
  assert.equal(resolved[0].productId, "A-1010892076");
  assert.deepEqual(visited, [
    "howl.link",
    "goto.target.com",
    "www.ojrq.net",
  ]);

  const unknownVisits = [];
  await assert.rejects(resolveWatchlistEntries([entry("1010892076")], {
    fetchImpl: async (url) => {
      unknownVisits.push(new URL(url).hostname);
      return {
        headers: { get: () => "https://unrelated.example/p/-/A-1010892076" },
      };
    },
  }), /destination/);
  assert.deepEqual(unknownVisits, ["howl.link"]);
});

test("watchlist rejects duplicate and changed short-link destinations", async () => {
  await assert.rejects(
    resolveWatchlistEntries([entry("1010892076"), entry("1010892076")], {
      fetchImpl: async () => {
        throw new Error("Duplicate rejection must precede fetching.");
      },
    }),
    /duplicate/i,
  );
  await assert.rejects(
    resolveWatchlistEntries([entry("1010892076")], {
      fetchImpl: async () => ({
        headers: {
          get: () => "https://www.target.com/p/-/A-1010892065",
        },
      }),
    }),
    /destination.*product ID|product ID.*destination/i,
  );
});

test("watchlist keeps stricter saved caps and bounds unset caps", () => {
  const defaults = watchlistSettings(targetSettingsDefaults);
  assert.equal(defaults.maxItemPrice, "100.00");
  assert.equal(defaults.maxOrderTotal, "125.00");
  assert.equal(defaults.expectedFulfillment, "shipping");

  const strict = watchlistSettings({
    ...targetSettingsDefaults,
    maxItemPrice: "55.00",
    maxOrderTotal: "70.00",
  });
  assert.equal(strict.maxItemPrice, "55.00");
  assert.equal(strict.maxOrderTotal, "70.00");
});

test("watchlist prepares eight direct-buy jobs with one worker and guarded limits", () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({
    productId: `A-${1010000000 + index}`,
    url: `https://www.target.com/p/-/A-${1010000000 + index}`,
  }));
  const prepared = prepareWatchlistRun({
    entries,
    secrets,
    settings: targetSettingsDefaults,
  });
  assert.equal(prepared.run.args.length, 9);
  assert.ok(prepared.run.args.slice(1).every((arg) => arg.startsWith("direct-buy=")));
  assert.equal(prepared.run.env.TARGET_MULTI_DIRECT_BUY, "1");
  assert.equal(prepared.run.env.TARGET_REPEAT_CONFIRMED_ORDERS, "1");
  assert.equal(prepared.run.env.TARGET_MAX_CONCURRENT, "8");
  assert.equal(prepared.run.env.TARGET_MONITOR_POLL_MS, "1000");
  assert.equal(prepared.run.env.TARGET_MAX_ITEM_PRICE, "100.00");
  assert.equal(prepared.run.env.TARGET_MAX_ORDER_TOTAL, "125.00");
  assert.equal(prepared.run.env.TARGET_EXPECTED_FULFILLMENT, "shipping");
  assert.equal(prepared.run.env.TARGET_CHALLENGE_SOLVER, "./target-challenge-solver.js");
  assert.equal(prepared.run.env.TARGET_STOP_BEFORE_SUBMIT, undefined);
  assert.equal(prepared.run.env.TARGET_DISABLE_DISCORD_ALERTS, "1");
});
