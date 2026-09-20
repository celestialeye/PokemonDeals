const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  challengeSolverOption,
  matchEventItems,
  printSettings,
  printSecrets,
  retailerLabel,
  runAdapter,
  runEngine,
  uniqueIdPrefix,
} = require("../deals");
const {
  buildTargetRun,
  normalizeExecutionMode,
  parseTargetOutput,
  productMetadata,
  resolveProductMetadata,
  targetWorkerMode,
  validateTargetEnvironment,
  validateTargetSettingsForRun,
} = require("../src/deals-adapters");
const {
  createCatalogStore,
  loadCatalog,
  resolveUniquePrefix,
  validateCatalog,
} = require("../src/deals-catalog");
const {
  modeLabel,
  normalizeMode,
  normalizeUrl,
  parseGroupedList,
} = require("../src/deals-core");
const {
  applyStoredSecretsToEnvironment,
  createSecretStore,
  emptySecrets,
  secretRows,
} = require("../src/deals-secrets");
const {
  maximumPollIntervalMs,
  maximumTimerMs,
  normalizeTargetSettings,
  setTargetSetting,
  targetSettingOptions,
  targetSettingsDefaults,
} = require("../src/target-deal-settings");

const testTimestamp = "2026-09-19T18:00:00.000Z";

function validCatalogItem(overrides = {}) {
  const productId = overrides.productId || "A-1000000001";
  const url = overrides.url || `https://www.target.com/p/-/${productId}`;
  const retailer = overrides.retailer || "target";
  return {
    id: overrides.id || `item-${productId}`,
    name: overrides.name || productId,
    group: overrides.group ?? "",
    url,
    retailer,
    mode: overrides.mode === undefined ? "buy" : overrides.mode,
    armed: overrides.armed === undefined ? false : overrides.armed,
    resolvedProductId: overrides.resolvedProductId === undefined
      ? retailer === "target" ? productId : null
      : overrides.resolvedProductId,
    resolvedUrl: overrides.resolvedUrl === undefined
      ? retailer === "target" ? url : null
      : overrides.resolvedUrl,
    lastStatus: overrides.lastStatus || "Not run",
    lastStatusAt: overrides.lastStatusAt === undefined
      ? null
      : overrides.lastStatusAt,
    terminalOutcome: overrides.terminalOutcome === undefined
      ? null
      : overrides.terminalOutcome,
    createdAt: overrides.createdAt || testTimestamp,
    updatedAt: overrides.updatedAt || testTimestamp,
  };
}

function catalogWith(items) {
  return {
    version: 2,
    settings: { target: targetSettingsDefaults },
    items,
  };
}

test("grouped-list parser handles headings, names, and missing schemes", () => {
  const parsed = parseGroupedList(`
30th Celebration:
Elite Trainer Box: howl.link/99668grkawccg
Poster Collection: https://www.target.com/p/example/-/A-1010892067

Other:
Future item: example.com/products/future
`);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    parsed.items.map(({ name, group, url }) => ({ name, group, url })),
    [
      {
        name: "Elite Trainer Box",
        group: "30th Celebration",
        url: "https://howl.link/99668grkawccg",
      },
      {
        name: "Poster Collection",
        group: "30th Celebration",
        url: "https://www.target.com/p/example/-/A-1010892067",
      },
      {
        name: "Future item",
        group: "Other",
        url: "https://example.com/products/future",
      },
    ],
  );
  assert.match(
    parseGroupedList("not a product line").errors[0],
    /expected "Name: URL"/i,
  );
  assert.deepEqual(
    parseGroupedList("https://www.target.com/p/-/A-1010892069").items[0],
    {
      name: "",
      group: "",
      url: "https://www.target.com/p/-/A-1010892069",
      sourceLine: 1,
    },
  );
});

test("URL normalization, retailer detection, and mode mapping are explicit", () => {
  assert.equal(
    normalizeUrl("howl.link/99668grkawccg"),
    "https://howl.link/99668grkawccg",
  );
  assert.deepEqual(productMetadata("target.com/p/example/-/A-1010892067"), {
    retailer: "target",
    normalizedUrl: "https://www.target.com/p/example/-/A-1010892067",
    name: "Poster Collection",
    nameSource: "known",
    resolvedProductId: "A-1010892067",
    resolvedUrl: "https://www.target.com/p/example/-/A-1010892067",
  });
  assert.equal(
    productMetadata(
      "https://www.target.com/s?searchTerm=A-1010892067",
    ).retailer,
    "unsupported",
  );
  assert.equal(productMetadata("https://example.com/future-item").name, "Future Item");
  assert.equal(productMetadata("https://example.com/item").retailer, "unsupported");
  assert.equal(normalizeMode("Buy Now"), "buy-now");
  assert.equal(normalizeMode("Preorder"), "preorder");
  assert.equal(normalizeMode("Buy"), "buy");
  assert.equal(modeLabel("buy-now"), "Buy Now");
  assert.equal(modeLabel("preorder"), "Preorder");
  assert.equal(modeLabel("buy"), "Buy");
  assert.equal(targetWorkerMode("buy"), "add-to-cart");
  assert.throws(() => normalizeMode("automatic"), /Buy Now, Preorder, or Buy/);
});

test("product metadata retrieves a page title and follows redirects", async () => {
  const resolved = await resolveProductMetadata(
    "https://howl.link/future-box",
    {
      fetchImpl: async () => ({
        url: "https://www.target.com/p/pokemon-tcg-future-box/-/A-1099999999",
        text: async () =>
          '<meta property="og:title" content="Pokémon TCG: Future Box | Target">',
      }),
    },
  );
  assert.equal(resolved.name, "Pokémon TCG: Future Box");
  assert.equal(resolved.nameSource, "page");
  assert.equal(resolved.resolvedProductId, "A-1099999999");
});

test("catalog persistence resolves a missing product name before saving", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-deals-name-"));
  const filePath = path.join(directory, "deals.json");
  const store = createCatalogStore(filePath, {
    resolveMetadata: async (url) => ({
      ...productMetadata(url),
      name: "Retrieved Product",
      nameSource: "page",
    }),
  });
  try {
    const item = await store.add({
      url: "https://www.target.com/p/future-box/-/A-1099999999",
      mode: "buy",
      armed: true,
    });
    assert.equal(item.name, "Retrieved Product");
    assert.equal((await store.list())[0].name, "Retrieved Product");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Target settings expose validated current defaults and relationships", () => {
  assert.deepEqual(normalizeTargetSettings(), targetSettingsDefaults);
  assert.deepEqual(
    targetSettingOptions("defaultRunMode").map(({ value }) => value),
    ["observe", "stop-before-submit", "live"],
  );
  assert.match(
    targetSettingOptions("defaultRunMode")[1].description,
    /cart and checkout/i,
  );
  assert.equal(
    setTargetSetting(targetSettingsDefaults, "default-run-mode", "observe")
      .defaultRunMode,
    "observe",
  );
  assert.equal(
    setTargetSetting(targetSettingsDefaults, "poll-interval-ms", "6500")
      .pollIntervalMs,
    6500,
  );
  assert.equal(
    setTargetSetting(targetSettingsDefaults, "target.solver-enabled", "false")
      .solverEnabled,
    false,
  );
  assert.equal(
    setTargetSetting(targetSettingsDefaults, "max-item-price", "49.9")
      .maxItemPrice,
    "49.90",
  );
  assert.throws(
    () => setTargetSetting(targetSettingsDefaults, "poll-interval-ms", "1499"),
    new RegExp(`1500-${maximumPollIntervalMs}`),
  );
  assert.throws(
    () => setTargetSetting(targetSettingsDefaults, "timeout-ms", "999"),
    /1000-45000/i,
  );
  assert.throws(
    () =>
      setTargetSetting(
        targetSettingsDefaults,
        "challenge-backoff-ms",
        "1900000",
      ),
    /Maximum challenge backoff/i,
  );
  assert.throws(
    () =>
      setTargetSetting(
        targetSettingsDefaults,
        "poll-interval-ms",
        String(maximumPollIntervalMs + 1),
      ),
    new RegExp(`1500-${maximumPollIntervalMs}`),
  );
  assert.throws(
    () =>
      setTargetSetting(
        targetSettingsDefaults,
        "challenge-max-backoff-ms",
        String(maximumTimerMs + 1),
      ),
    new RegExp(`60000-${maximumTimerMs}`),
  );
  assert.throws(
    () =>
      setTargetSetting(
        targetSettingsDefaults,
        "cart-rate-limit-backoff-ms",
        String(maximumTimerMs + 1),
      ),
    new RegExp(`60000-${maximumTimerMs}`),
  );
  assert.throws(
    () =>
      setTargetSetting(
        targetSettingsDefaults,
        "cart-rate-limit-backoff-ms",
        "2000000",
      ),
    /at least cart-rate-limit-backoff-ms/i,
  );
});

test("settings display reports secret presence without exposing values", async () => {
  let rendered = "";
  const fakeSecrets = {
    target: { pin: "1234-fake-pin" },
    discord: {
      webhookUrl:
        "https://discord.com/api/webhooks/000000000000000000/fake-test-token",
    },
  };
  await printSettings(
    {
      getSettings: async () => targetSettingsDefaults,
    },
    {
      secretStore: {
        getAll: async () => fakeSecrets,
      },
      env: {
        DISCORD_WEBHOOK_URL: "environment-fake-webhook",
        TARGET_PIN: "environment-fake-pin",
      },
      output: {
        write: (value) => {
          rendered += value;
        },
      },
    },
  );
  assert.match(rendered, /target\.default-run-mode = stop-before-submit/);
  assert.match(rendered, /target\.pin = \*{8}/);
  assert.match(rendered, /discord\.webhook-url = \*{8}/);
  assert.match(rendered, /environment override: present/);
  assert.doesNotMatch(rendered, /fake-/);
});

test("local secret storage is atomic, masked by default, and reveal is explicit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-secrets-"));
  const filePath = path.join(directory, "deals-secrets.local.json");
  const catalogFilePath = path.join(directory, "deals.json");
  const secretStore = createSecretStore(filePath);
  const fakePin = "1234-fake-pin";
  const fakeWebhook =
    "https://discord.com/api/webhooks/000000000000000000/fake-test-token";
  try {
    await secretStore.set("target.pin", fakePin);
    await secretStore.set("discord.webhookUrl", fakeWebhook);
    await createCatalogStore(catalogFilePath).setSetting(
      "target",
      "poll-interval-ms",
      "6000",
    );
    assert.deepEqual(await secretStore.getAll(), {
      target: { pin: fakePin },
      discord: { webhookUrl: fakeWebhook },
    });

    const masked = secretRows(await secretStore.getAll(), {}, {
      reveal: false,
    });
    assert.ok(masked.every((row) => row.storedValue === "********"));
    const revealed = secretRows(await secretStore.getAll(), {}, {
      reveal: true,
    });
    assert.equal(revealed[0].storedValue, fakePin);
    assert.equal(revealed[1].storedValue, fakeWebhook);

    let rendered = "";
    await printSecrets(secretStore, {
      env: {},
      output: { write: (value) => { rendered += value; } },
    });
    assert.doesNotMatch(rendered, /fake-/);
    await secretStore.clear("target.pin");
    assert.equal((await secretStore.getAll()).target.pin, null);
    assert.doesNotMatch(await fs.readFile(catalogFilePath, "utf8"), /fake-/);
    assert.deepEqual(
      (await fs.readdir(directory)).sort(),
      ["deals-secrets.local.json", "deals.json"],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("stored secrets populate runtime env while process overrides win", () => {
  const stored = {
    target: { pin: "1234-fake-pin" },
    discord: {
      webhookUrl:
        "https://discord.com/api/webhooks/000000000000000000/fake-test-token",
    },
  };
  assert.deepEqual(applyStoredSecretsToEnvironment({}, stored), {
    TARGET_PIN: "1234-fake-pin",
    DISCORD_WEBHOOK_URL:
      "https://discord.com/api/webhooks/000000000000000000/fake-test-token",
  });
  assert.deepEqual(
    applyStoredSecretsToEnvironment(
      {
        TARGET_PIN: "9999-one-off",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/env/override",
      },
      stored,
    ),
    {
      TARGET_PIN: "9999-one-off",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/env/override",
    },
  );
  assert.deepEqual(emptySecrets().secrets, {
    target: { pin: null },
    discord: { webhookUrl: null },
  });
  const targetAdapter = require("../src/deals-adapters")
    .adapterForRetailer("target");
  assert.deepEqual(
    targetAdapter.validateEnvironment(
      "live-purchase",
      targetAdapter.applySecrets({}, stored),
    ),
    [],
  );
});

test("local secret store is covered by gitignore", async () => {
  const gitignore = await fs.readFile(
    path.join(__dirname, "..", ".gitignore"),
    "utf8",
  );
  assert.match(gitignore, /^\/data\/deals-secrets\.local\.json$/m);
  assert.match(gitignore, /^\/data\/deals-secrets\.local\.json\.\*\.tmp$/m);
});

test("catalog CRUD is atomic, rejects duplicates, and resolves unique prefixes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-deals-"));
  const filePath = path.join(directory, "data", "deals.json");
  const ids = ["alpha0000001", "alpine000002", "bravo0000003"];
  const store = createCatalogStore(filePath, {
    idFactory: () => ids.shift(),
    now: () => "2026-09-19T18:00:00.000Z",
  });
  try {
    const first = await store.add({
      group: "30th Celebration",
      url: "howl.link/99668grkawccg",
      mode: "preorder",
      armed: false,
    });
    assert.equal(first.id, "alpha0000001");
    assert.equal(first.name, "Elite Trainer Box");
    assert.equal(first.resolvedProductId, "A-1010892076");
    assert.equal(resolveUniquePrefix(await store.list(), "alpha").id, first.id);

    const second = await store.add({
      name: "Unsupported future item",
      url: "https://example.com/future",
      mode: "buy",
      armed: false,
    });
    assert.equal(second.retailer, "unsupported");
    assert.throws(
      () => resolveUniquePrefix([first, second, { ...first, id: "alpine999999" }], "al"),
      /ambiguous/i,
    );
    await assert.rejects(
      store.setArmed([second.id], true),
      /unsupported.*retailer/i,
    );
    await assert.rejects(
      store.add({
        name: "Duplicate direct Target URL",
        url: "https://www.target.com/p/-/A-1010892076",
        mode: "buy",
        armed: false,
      }),
      /Duplicate product/i,
    );

    const updated = await store.update(first.id.slice(0, 5), {
      name: "Updated ETB",
      armed: true,
    });
    assert.equal(updated.name, "Updated ETB");
    assert.equal(updated.armed, true);
    const removed = await store.remove(second.id);
    assert.equal(removed.name, "Unsupported future item");

    const persisted = await loadCatalog(filePath);
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.settings.target, targetSettingsDefaults);
    assert.deepEqual(persisted.items.map((item) => item.id), [first.id]);

    await store.setSetting("target", "poll-interval-ms", "6500");
    await store.setSetting("target", "expected-fulfillment", "drive up");
    const settings = await store.getSettings("target");
    assert.equal(settings.pollIntervalMs, 6500);
    assert.equal(settings.expectedFulfillment, "drive-up");
    assert.equal(
      (await loadCatalog(filePath)).settings.target.pollIntervalMs,
      6500,
    );
    const directoryFiles = await fs.readdir(path.dirname(filePath));
    assert.deepEqual(directoryFiles, ["deals.json"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("confirmed products remain excluded until explicitly re-armed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-deals-"));
  const filePath = path.join(directory, "deals.json");
  const store = createCatalogStore(filePath, {
    idFactory: () => "confirmed0001",
  });
  try {
    const added = await store.add({
      name: "Confirmed Product",
      url: "https://www.target.com/p/-/A-1010892067",
      mode: "buy",
      armed: true,
    });
    await store.updateRuntime([added.id], {
      lastStatus: "Order confirmed",
      terminalOutcome: "confirmed",
    });

    const edited = await store.update(added.id, { name: "Edited Product" });
    assert.equal(edited.terminalOutcome, "confirmed");

    const rearmed = await store.setArmed([added.id], true);
    assert.equal(rearmed[0].terminalOutcome, null);
    assert.equal(rearmed[0].lastStatus, "Not run");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("version 1 catalogs migrate to namespaced default settings", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-deals-"));
  const filePath = path.join(directory, "deals.json");
  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, items: [] }),
      "utf8",
    );
    const catalog = await loadCatalog(filePath);
    assert.equal(catalog.version, 2);
    assert.deepEqual(catalog.settings.target, targetSettingsDefaults);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("catalog load rejects malformed items and duplicate invariants", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-catalog-"));
  const filePath = path.join(directory, "deals.json");
  const cases = [
    {
      name: "non-boolean armed",
      items: [validCatalogItem({ armed: "true" })],
      pattern: /armed must be boolean/i,
    },
    {
      name: "missing mode",
      items: [validCatalogItem({ mode: null })],
      pattern: /invalid or missing mode/i,
    },
    {
      name: "duplicate IDs",
      items: [
        validCatalogItem({ id: "duplicate", productId: "A-1000000001" }),
        validCatalogItem({ id: "DUPLICATE", productId: "A-1000000002" }),
      ],
      pattern: /Duplicate catalog item ID/i,
    },
    {
      name: "duplicate canonical URLs",
      items: [
        validCatalogItem({ id: "one" }),
        validCatalogItem({ id: "two" }),
      ],
      pattern: /Duplicate retailer URL/i,
    },
    {
      name: "duplicate retailer products",
      items: [
        validCatalogItem({
          id: "one",
          url: "https://www.target.com/p/one/-/A-1000000001",
          resolvedUrl: "https://www.target.com/p/one/-/A-1000000001",
        }),
        validCatalogItem({
          id: "two",
          url: "https://www.target.com/p/two/-/A-1000000001",
          resolvedUrl: "https://www.target.com/p/two/-/A-1000000001",
        }),
      ],
      pattern: /Duplicate retailer product/i,
    },
    {
      name: "unsupported armed retailer",
      items: [
        validCatalogItem({
          id: "unsupported",
          url: "https://example.com/item",
          retailer: "unsupported",
          armed: true,
          resolvedProductId: null,
          resolvedUrl: null,
        }),
      ],
      pattern: /unsupported armed retailer/i,
    },
    {
      name: "armed count above adapter limit",
      items: [
        validCatalogItem({ id: "one", productId: "A-1000000001", armed: true }),
        validCatalogItem({ id: "two", productId: "A-1000000002", armed: true }),
        validCatalogItem({ id: "three", productId: "A-1000000003", armed: true }),
        validCatalogItem({ id: "four", productId: "A-1000000004", armed: true }),
      ],
      pattern: /at most 3 armed items/i,
    },
  ];
  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 2, settings: [], items: [] }),
    );
    await assert.rejects(loadCatalog(filePath), /Expected version 2/i);

    await fs.writeFile(
      filePath,
      JSON.stringify(catalogWith([
        validCatalogItem({ createdAt: "09/19/2026" }),
      ])),
    );
    await assert.rejects(loadCatalog(filePath), /createdAt must be an ISO timestamp/i);

    await fs.writeFile(
      filePath,
      JSON.stringify(catalogWith([
        validCatalogItem({ createdAt: "2026-02-30T00:00:00.000Z" }),
      ])),
    );
    await assert.rejects(loadCatalog(filePath), /createdAt must be an ISO timestamp/i);

    assert.throws(
      () => validateCatalog({
        version: 2,
        settings: { target: new Date(0) },
        items: [],
      }),
      /settings for target must be an object/i,
    );

    for (const entry of cases) {
      await fs.writeFile(filePath, JSON.stringify(catalogWith(entry.items)));
      await assert.rejects(
        loadCatalog(filePath),
        entry.pattern,
        entry.name,
      );
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("run preflight rejects malformed catalogs before spawning", async () => {
  let spawnCount = 0;
  await assert.rejects(
    runEngine(
      {
        read: async () => catalogWith([
          validCatalogItem({ armed: "true" }),
        ]),
      },
      "observe",
      {
        spawnImpl: () => {
          spawnCount += 1;
        },
      },
    ),
    /armed must be boolean/i,
  );
  assert.equal(spawnCount, 0);
});

test("run preflight rejects later unsupported armed item before Target spawn", async () => {
  let spawnCount = 0;
  await assert.rejects(
    runEngine(
      {
        read: async () => catalogWith([
          validCatalogItem({
            id: "valid-target",
            productId: "A-1000000001",
            armed: true,
          }),
          validCatalogItem({
            id: "later-unsupported",
            url: "https://example.com/item",
            retailer: "unsupported",
            armed: true,
            resolvedProductId: null,
            resolvedUrl: null,
          }),
        ]),
      },
      "observe",
      {
        spawnImpl: () => {
          spawnCount += 1;
        },
      },
    ),
    /unsupported armed retailer/i,
  );
  assert.equal(spawnCount, 0);
});

test("Target enforces at most three armed catalog items", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-deals-"));
  const filePath = path.join(directory, "deals.json");
  let sequence = 0;
  const store = createCatalogStore(filePath, {
    idFactory: () => `target${String(++sequence).padStart(6, "0")}`,
  });
  try {
    const items = [];
    for (const productId of [
      "A-1000000001",
      "A-1000000002",
      "A-1000000003",
      "A-1000000004",
    ]) {
      items.push(await store.add({
        name: productId,
        url: `https://www.target.com/p/-/${productId}`,
        mode: "buy",
        armed: false,
      }));
    }
    await store.setArmed(items.slice(0, 3).map((item) => item.id), true);
    await assert.rejects(
      store.setArmed([items[3].id], true),
      /at most 3 armed items/i,
    );
    assert.equal((await store.list()).filter((item) => item.armed).length, 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Target run arguments and environment cover every execution mode", () => {
  const items = [
    {
      mode: "buy-now",
      url: "https://www.target.com/p/-/A-1000000001",
    },
    {
      mode: "preorder",
      url: "https://www.target.com/p/-/A-1000000002",
    },
    {
      mode: "buy",
      url: "https://www.target.com/p/-/A-1000000003",
    },
  ];
  const baseEnv = {
    KEEP: "yes",
    TARGET_CHALLENGE_SOLVER: "stale-solver",
    TARGET_CHALLENGE_VALIDATE: "stale-validation",
    TARGET_CHALLENGE_SOLVE_ATTEMPTS: "7",
    TARGET_CHALLENGE_TIMEOUT_MS: "42000",
    TARGET_MONITOR_OBSERVE_ONLY: "stale",
    TARGET_STOP_BEFORE_SUBMIT: "stale",
  };
  const observe = buildTargetRun(items, "observe-only", {
    env: baseEnv,
    rootDir: "C:\\repo",
    settings: {
      ...targetSettingsDefaults,
      maxItemPrice: "49.99",
      maxOrderTotal: "60.00",
      expectedFulfillment: "shipping",
      pollIntervalMs: 6000,
      browserDriver: "playwright",
      cartRateLimitBackoffMs: 90000,
      maxPolls: 12,
      maxRuntimeMs: 120000,
    },
  });
  assert.deepEqual(observe.args.slice(1), [
    "buy-now=https://www.target.com/p/-/A-1000000001",
    "preorder=https://www.target.com/p/-/A-1000000002",
    "add-to-cart=https://www.target.com/p/-/A-1000000003",
  ]);
  assert.equal(observe.env.TARGET_MONITOR_OBSERVE_ONLY, "1");
  assert.equal(observe.env.TARGET_STOP_BEFORE_SUBMIT, undefined);
  assert.equal(
    observe.env.TARGET_CHALLENGE_SOLVER,
    "./target-challenge-solver.js",
  );
  assert.equal(observe.env.TARGET_CHALLENGE_VALIDATE, "1");
  assert.equal(observe.env.TARGET_CHALLENGE_SOLVE_ATTEMPTS, "7");
  assert.equal(observe.env.TARGET_CHALLENGE_TIMEOUT_MS, "42000");
  assert.equal(observe.env.TARGET_MAX_ITEM_PRICE, "49.99");
  assert.equal(observe.env.TARGET_MAX_ORDER_TOTAL, "60.00");
  assert.equal(observe.env.TARGET_EXPECTED_FULFILLMENT, "shipping");
  assert.equal(observe.env.TARGET_MONITOR_POLL_MS, "6000");
  assert.equal(observe.env.TARGET_BROWSER_DRIVER, "playwright");
  assert.equal(observe.env.TARGET_CART_RATE_LIMIT_BACKOFF_MS, "90000");
  assert.equal(observe.env.TARGET_MONITOR_MAX_POLLS, "12");
  assert.equal(observe.env.TARGET_MONITOR_MAX_RUNTIME_MS, "120000");

  const guarded = buildTargetRun(items, "stop-before-submit", {
    env: baseEnv,
    rootDir: "C:\\repo",
  });
  assert.equal(guarded.env.TARGET_MONITOR_OBSERVE_ONLY, undefined);
  assert.equal(guarded.env.TARGET_STOP_BEFORE_SUBMIT, "1");
  assert.equal(
    guarded.env.TARGET_CHALLENGE_SOLVER,
    "./target-challenge-solver.js",
  );
  assert.equal(guarded.env.TARGET_CHALLENGE_VALIDATE, undefined);

  const live = buildTargetRun(items, "live-purchase", {
    env: baseEnv,
    rootDir: "C:\\repo",
  });
  assert.equal(live.env.TARGET_MONITOR_OBSERVE_ONLY, undefined);
  assert.equal(live.env.TARGET_STOP_BEFORE_SUBMIT, undefined);
  assert.equal(
    live.env.TARGET_CHALLENGE_SOLVER,
    "./target-challenge-solver.js",
  );
  assert.equal(live.env.TARGET_CHALLENGE_VALIDATE, undefined);

  const settingsDisabled = buildTargetRun(items, "observe-only", {
    env: {},
    rootDir: "C:\\repo",
    settings: {
      ...targetSettingsDefaults,
      solverEnabled: false,
    },
  });
  assert.equal(settingsDisabled.challengeSolverEnabled, false);
  assert.equal(settingsDisabled.env.TARGET_CHALLENGE_SOLVER, undefined);
  assert.equal(settingsDisabled.env.TARGET_CHALLENGE_VALIDATE, undefined);

  const settingsDefaultRun = buildTargetRun(items, null, {
    env: {},
    rootDir: "C:\\repo",
    settings: {
      ...targetSettingsDefaults,
      defaultRunMode: "observe",
    },
  });
  assert.equal(settingsDefaultRun.env.TARGET_MONITOR_OBSERVE_ONLY, "1");
  assert.equal(settingsDefaultRun.env.TARGET_CHALLENGE_VALIDATE, "1");
  assert.equal(settingsDefaultRun.env.TARGET_CHALLENGE_SOLVE_ATTEMPTS, "3");
  assert.equal(settingsDefaultRun.env.TARGET_CHALLENGE_TIMEOUT_MS, "20000");

  const disabled = buildTargetRun(items, "observe-only", {
    challengeSolver: false,
    env: baseEnv,
    rootDir: "C:\\repo",
  });
  assert.equal(disabled.env.TARGET_CHALLENGE_SOLVER, undefined);
  assert.equal(disabled.env.TARGET_CHALLENGE_VALIDATE, undefined);
  assert.equal(disabled.env.TARGET_CHALLENGE_SOLVE_ATTEMPTS, "7");
  assert.equal(challengeSolverOption({}), undefined);
  assert.equal(challengeSolverOption({}, true), true);
  assert.equal(challengeSolverOption({ "no-solver": true }), false);
  assert.equal(challengeSolverOption({ solver: true }), true);
  assert.equal(normalizeExecutionMode("live"), "live-purchase");
  assert.deepEqual(validateTargetEnvironment("observe-only", {}), []);
  assert.deepEqual(validateTargetEnvironment("live-purchase", {}), [
    "DISCORD_WEBHOOK_URL",
  ]);
  assert.deepEqual(
    validateTargetSettingsForRun("live-purchase", targetSettingsDefaults),
    [],
  );
  assert.deepEqual(
    validateTargetSettingsForRun("live-purchase", {
      ...targetSettingsDefaults,
      maxItemPrice: "49.99",
      maxOrderTotal: "60.00",
    }),
    [],
  );
  assert.throws(
    () =>
      buildTargetRun(items, "observe-only", {
        env: {
          TARGET_CHALLENGE_SETTLE_MS: String(maximumTimerMs + 1),
        },
        rootDir: "C:\\repo",
      }),
    new RegExp(`500-${maximumTimerMs}`),
  );
  assert.throws(
    () =>
      buildTargetRun(items, "observe-only", {
        env: {
          TARGET_CHALLENGE_BACKOFF_MS: "60000",
          TARGET_CHALLENGE_MAX_BACKOFF_MS: "60000",
        },
        rootDir: "C:\\repo",
        settings: {
          ...targetSettingsDefaults,
          cartRateLimitBackoffMs: 90000,
        },
      }),
    /at least cart-rate-limit-backoff-ms/i,
  );
});

test("Target output parser maps product, resolution, status, and terminal events", () => {
  assert.deepEqual(
    parseTargetOutput(
      "TARGET_SHORT_URL_RESOLVED https://howl.link/item -> https://www.target.com/p/-/A-1000000001",
    ),
    {
      sourceUrl: "https://howl.link/item",
      resolvedUrl: "https://www.target.com/p/-/A-1000000001",
      productId: "A-1000000001",
      status: "URL resolved",
    },
  );
  assert.deepEqual(
    parseTargetOutput(
      'TARGET_API_POLL {"productId":"A-1000000001","status":200,"outcome":"response"}',
    ),
    {
      productId: "A-1000000001",
      status: "Monitoring (HTTP 200)",
      important: false,
    },
  );
  assert.deepEqual(
    parseTargetOutput(
      'TARGET_ORDER_CONFIRMED {"productId":"A-1000000001","mode":"buy-now"}',
    ),
    {
      productId: "A-1000000001",
      status: "Order confirmed",
      terminalOutcome: "confirmed",
    },
  );
  assert.deepEqual(
    parseTargetOutput(
      'TARGET_TERMINAL_SAFETY_STOP {"reason":"ready-to-submit","productId":"A-1000000001"}',
    ),
    {
      productId: "A-1000000001",
      status: "Safety stop: ready-to-submit",
      terminalOutcome: "ready-to-submit",
      important: true,
    },
  );
  assert.deepEqual(parseTargetOutput("TARGET_PURCHASE_COMPLETE"), {
    scope: "active",
    status: "Purchase complete",
    terminalOutcome: "confirmed",
  });
  assert.deepEqual(
    parseTargetOutput(
      "TARGET_CHALLENGE_DETECTED kind=press_and_hold product=A-1000000001 reason=test",
    ),
    {
      productId: "A-1000000001",
      status: "Verification detected",
      important: true,
    },
  );
  assert.deepEqual(
    parseTargetOutput(
      'TARGET_CHALLENGE_SOLVED {"at":"2026-09-19T18:00:00.000Z","kind":"press_and_hold","attempts":2,"productId":"A-1000000001"}',
    ),
    {
      productId: "A-1000000001",
      status: "Verification solved after 2 attempt(s)",
    },
  );
  assert.deepEqual(
    parseTargetOutput(
      "TARGET_CHALLENGE_PAGE_CLEARED product=A-1000000001",
    ),
    {
      productId: "A-1000000001",
      status: "Verification cleared",
    },
  );
  assert.deepEqual(
    parseTargetOutput(
      "TARGET_CHALLENGE_BACKOFF 300000ms availability challenge 403 for A-1000000001",
    ),
    {
      productId: "A-1000000001",
      status: "Verification backoff",
      important: true,
    },
  );
  assert.deepEqual(
    parseTargetOutput("TARGET_CHALLENGE_BACKOFF 300000ms unreadable page"),
    {
      scope: "all",
      status: "Verification backoff",
      important: true,
    },
  );
  assert.deepEqual(
    parseTargetOutput("TARGET_MONITOR_PAUSED 2984894ms"),
    {
      scope: "all",
      status: "Verification backoff",
      backoffMs: 2984894,
      important: true,
    },
  );
});

test("status matching and displayed ID prefixes stay scoped and unambiguous", () => {
  const items = [
    { id: "abcdef100000", resolvedProductId: "A-1000000001" },
    { id: "abcdef200000", resolvedProductId: "A-1000000002" },
  ];
  assert.equal(uniqueIdPrefix(items, items[0].id), "abcdef1");
  assert.deepEqual(
    matchEventItems(items, { productId: "A-1000000002" }),
    [items[1]],
  );
  const terminalItems = [
    { ...items[0], terminalOutcome: "ready-to-submit" },
    { ...items[1], terminalOutcome: null },
  ];
  assert.deepEqual(
    matchEventItems(
      terminalItems,
      { scope: "all", terminalOutcome: "stopped" },
    ),
    [terminalItems[1]],
  );
  assert.equal(retailerLabel("target"), "Target");
  assert.equal(retailerLabel("future"), "Unsupported");
});

test("run adapter emits already-parsed matched events without changing output", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const item = {
    id: "item1",
    retailer: "target",
    armed: true,
    resolvedProductId: "A-1000000001",
    terminalOutcome: null,
  };
  let current = { ...item };
  const notifications = [];
  const lifecycle = [];
  let output = "";
  const adapter = {
    id: "target",
    displayName: "Target",
    validateEnvironment: () => [],
    buildRun: () => ({
      command: process.execPath,
      args: ["synthetic-worker.js"],
      env: {},
    }),
    parseOutput: parseTargetOutput,
  };
  const store = {
    updateRuntime: async (ids, patch) => {
      if (ids.includes(current.id)) {
        current = { ...current, ...patch };
      }
    },
    list: async () => [current],
  };
  const result = runAdapter(
    store,
    adapter,
    [item],
    "observe-only",
    {
      spawnImpl: () => {
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(
              'TARGET_API_POLL {"productId":"A-1000000001","status":200,"outcome":"response"}\n',
            ),
          );
          setImmediate(() => child.emit("close", 0, null));
        });
        return child;
      },
      output: { write: (chunk) => { output += chunk; } },
      errorOutput: { write: () => {} },
      env: {},
      onRunEvent: (event) => notifications.push(event),
      onLifecycle: (event) => lifecycle.push(event),
    },
  );
  assert.deepEqual(await result, {
    code: 0,
    signal: null,
    interrupted: false,
  });
  assert.match(output, /TARGET_API_POLL/);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event.status, "Monitoring (HTTP 200)");
  assert.deepEqual(notifications[0].itemIds, ["item1"]);
  assert.deepEqual(
    lifecycle.map((event) => event.type),
    ["starting", "closed"],
  );
});

test("runtime persistence failure stops the child before rejecting", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal || "default");
    setImmediate(() => child.emit("close", 1, signal || null));
    return true;
  };
  const adapter = {
    displayName: "Target",
    validateEnvironment: () => [],
    buildRun: () => ({
      command: process.execPath,
      args: ["target-watch.js"],
      env: {},
    }),
    parseOutput: () => ({
      scope: "all",
      status: "Monitoring",
    }),
  };
  let updateCalls = 0;
  const store = {
    updateRuntime: async () => {
      updateCalls += 1;
    },
    list: async () => {
      throw new Error("catalog unavailable");
    },
  };
  const result = runAdapter(
    store,
    adapter,
    [{ id: "item1", retailer: "target", armed: true }],
    "observe-only",
    {
      spawnImpl: () => {
        setImmediate(() => child.stdout.emit("data", Buffer.from("event\n")));
        return child;
      },
      output: { write: () => {} },
      errorOutput: { write: () => {} },
      env: {},
    },
  );
  await assert.rejects(result, /catalog unavailable/);
  assert.equal(updateCalls, 1);
  assert.deepEqual(signals, ["SIGINT"]);
});

test("repeated stop requests remain intercepted until the child closes", async () => {
  const child = new EventEmitter();
  const signalSource = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal || "default");
    return true;
  };
  const adapter = {
    id: "target",
    displayName: "Target",
    validateEnvironment: () => [],
    buildRun: () => ({
      command: process.execPath,
      args: ["synthetic-worker.js"],
      env: {},
    }),
    parseOutput: () => null,
  };
  const item = {
    id: "item1",
    retailer: "target",
    armed: true,
    terminalOutcome: null,
  };
  let current = { ...item };
  const store = {
    updateRuntime: async (ids, patch) => {
      if (ids.includes(current.id)) {
        current = { ...current, ...patch };
      }
    },
    list: async () => [current],
  };
  const resultPromise = runAdapter(
    store,
    adapter,
    [item],
    "observe-only",
    {
      spawnImpl: () => child,
      output: { write: () => {} },
      errorOutput: { write: () => {} },
      env: {},
      signalSource,
    },
  );
  await waitForSignalListener(signalSource, 1);
  signalSource.emit("SIGINT");
  signalSource.emit("SIGINT");
  assert.deepEqual(signals, ["SIGINT"]);
  assert.equal(signalSource.listenerCount("SIGINT"), 1);

  let settled = false;
  resultPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  child.emit("close", 0, "SIGINT");
  assert.deepEqual(await resultPromise, {
    code: 0,
    signal: "SIGINT",
    interrupted: true,
  });
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
});

async function waitForSignalListener(signalSource, expectedCount) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (signalSource.listenerCount("SIGINT") === expectedCount) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${expectedCount} SIGINT listener(s).`);
}
