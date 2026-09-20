const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  actionForKey,
  appendProjectedLog,
  createChunkLogSink,
  createDealsTui,
  createImportController,
  createRunProjection,
  navigationItems,
  palette,
  productDetail,
  productTableHeader,
  productRows,
  projectRunLifecycle,
  projectRunEvent,
  runSetupDefaults,
  safeLogLine,
  statusColor,
  terminalSizeState,
  formatRunElapsed,
} = require("../src/deals-tui");
const { targetSettingsDefaults } = require("../src/target-deal-settings");

function product(overrides = {}) {
  return {
    id: overrides.id || "product-one",
    name: overrides.name || "Elite Trainer Box",
    group: overrides.group ?? "30th Celebration",
    url: overrides.url || "https://www.target.com/p/-/A-1000000001",
    retailer: overrides.retailer || "target",
    mode: overrides.mode || "preorder",
    armed: overrides.armed ?? true,
    resolvedProductId: overrides.resolvedProductId || "A-1000000001",
    resolvedUrl:
      overrides.resolvedUrl || "https://www.target.com/p/-/A-1000000001",
    lastStatus: overrides.lastStatus || "Monitoring (HTTP 200)",
    lastStatusAt:
      overrides.lastStatusAt || "2026-09-19T18:00:00.000Z",
    terminalOutcome: overrides.terminalOutcome ?? null,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function emitKey(widget, name, options = {}) {
  widget.emit("keypress", options.ch || null, {
    name,
    full: options.full || name,
    ctrl: Boolean(options.ctrl),
    shift: Boolean(options.shift),
  });
}

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}.`);
}

function createTuiHarness(
  storeOverrides = {},
  {
    initialItems = [],
    autoStart = true,
    autoRestartDelayMs = 5000,
    runEngine = null,
  } = {},
) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 120;
  output.rows = 40;
  output.on("data", () => {});

  let items = [...initialItems];
  const calls = {
    add: [],
    addMany: [],
    run: [],
    setSetting: [],
    update: [],
  };
  const store = {
    list: async () => items,
    getSettings: async () => ({ ...targetSettingsDefaults }),
    setSetting: async (retailer, key, value) => {
      calls.setSetting.push({ retailer, key, value });
      return value;
    },
    add: async (inputValue) => {
      calls.add.push(inputValue);
      const saved = product({ ...inputValue, id: `item-${calls.add.length}` });
      items = [...items, saved];
      return saved;
    },
    update: async (id, inputValue) => {
      calls.update.push({ id, input: inputValue });
      const saved = product({ ...items.find((item) => item.id === id), ...inputValue, id });
      items = items.map((item) => item.id === id ? saved : item);
      return saved;
    },
    addMany: async (inputValues) => {
      calls.addMany.push(inputValues);
      const added = inputValues.map((inputValue, index) =>
        product({
          ...inputValue,
          id: `imported-${calls.addMany.length}-${index}`,
        }));
      items = [...items, ...added];
      return added;
    },
    ...storeOverrides,
  };
  const tui = createDealsTui({
    store,
    secretStore: {
      getAll: async () => ({}),
      set: async () => {},
      clear: async () => {},
    },
    runEngine: runEngine || (async (...args) => {
      calls.run.push(args);
      return { code: 0, signal: null, interrupted: false };
    }),
    input,
    output,
    autoStart,
    autoRestartDelayMs,
  });
  return { calls, store, tui };
}

function findWidget(root, name) {
  if (root?.name === name) {
    return root;
  }
  for (const child of root?.children || []) {
    const match = findWidget(child, name);
    if (match) {
      return match;
    }
  }
  return null;
}

test("TUI product rows and detail preserve operator-facing state and raw URLs", () => {
  const item = product({ terminalOutcome: "ready-to-submit" });
  const [row] = productRows([item], { width: 140 });
  assert.deepEqual(row.cells.slice(0, 3), ["[x]", "Preorder", "Target"]);
  assert.match(row.text, /Elite Trainer Box/);
  assert.equal(row.terminalOutcome, "ready-to-submit");
  assert.equal(statusColor(item), palette.orange);
  assert.equal(
    statusColor(product({
      lastStatus: "Order confirmed",
      terminalOutcome: "confirmed",
    })),
    palette.green,
  );
  assert.equal(
    statusColor(product({
      lastStatus: "Purchase result unconfirmed",
      terminalOutcome: null,
    })),
    palette.red,
  );
  assert.ok(productRows([item], { width: 66 })[0].text.length <= 66);
  assert.ok(productTableHeader(66).length <= 66);
  assert.deepEqual(productDetail(item), {
    id: "product-one",
    name: "Elite Trainer Box",
    group: "30th Celebration",
    rawUrl: "https://www.target.com/p/-/A-1000000001",
    resolvedProductId: "A-1000000001",
    resolvedUrl: "https://www.target.com/p/-/A-1000000001",
    status: "Monitoring (HTTP 200)",
    lastChecked: "2026-09-19 18:00:00Z",
    terminalOutcome: "ready-to-submit",
  });
});

test("focused pane uses a distinct background from inactive selections", async () => {
  const { tui } = createTuiHarness({
    list: async () => [product()],
  }, { autoStart: false });
  try {
    await tui.ready;
    const navigation = findWidget(tui.screen, "navigation");
    const productTable = findWidget(tui.screen, "product-table");
    assert.equal(navigation.style.selected.bg, palette.panelAlt);
    assert.equal(productTable.style.selected.bg, palette.focus);

    await tui.handleAction("focus-navigation");
    assert.equal(tui.state.focus, "navigation");
    assert.equal(navigation.style.selected.bg, palette.focus);
    assert.equal(
      findWidget(tui.screen, "product-table").style.selected.bg,
      palette.panelAlt,
    );
  } finally {
    tui.destroy();
  }
});

test("navigation position survives switching focus to content", async () => {
  const { tui } = createTuiHarness();
  try {
    await tui.ready;
    await tui.handleAction("focus-navigation");
    await tui.handleAction("next");
    await tui.handleAction("next");
    await tui.handleAction("next");
    assert.equal(tui.screen.children.find((child) => child.name === "navigation").selected, 3);

    await tui.handleAction("focus-content");
    assert.equal(tui.state.focus, "content");
    assert.equal(tui.screen.children.find((child) => child.name === "navigation").selected, 3);

    await tui.handleAction("settings");
    assert.equal(tui.state.view, "settings");
    assert.equal(tui.screen.children.find((child) => child.name === "navigation").selected, 5);
  } finally {
    tui.destroy();
  }
});

test("keyboard mapping covers primary navigation and product actions", () => {
  assert.deepEqual(
    navigationItems.map((item) => item.id),
    [
      "products",
      "import",
      "add",
      "run-setup",
      "run-stats",
      "settings",
      "secrets",
      "help",
    ],
  );
  assert.equal(actionForKey("up"), "previous");
  assert.equal(actionForKey({ full: "j" }), "next");
  assert.equal(actionForKey("enter"), "activate");
  assert.equal(actionForKey("space"), "toggle-armed");
  assert.equal(actionForKey("a"), "add");
  assert.equal(actionForKey("e"), "edit");
  assert.equal(actionForKey("i"), "import");
  assert.equal(actionForKey("d"), "delete");
  assert.equal(actionForKey("r"), "run");
  assert.equal(actionForKey("t"), "run-stats");
  assert.equal(actionForKey("s"), "settings");
  assert.equal(actionForKey("escape"), "back");
  assert.equal(actionForKey("q"), "quit");
  assert.equal(actionForKey({ full: "C-c" }), "stop-run");
});

test("run setup uses armed products, stored solver choice, and safe default mode", () => {
  const items = [
    product(),
    product({ id: "two", armed: false }),
    product({ id: "confirmed", terminalOutcome: "confirmed" }),
  ];
  assert.deepEqual(
    runSetupDefaults(items, targetSettingsDefaults),
    {
      products: [items[0]],
      executionMode: "stop-before-submit",
      challengeSolver: true,
    },
  );
  assert.equal(
    runSetupDefaults(items, {
      defaultRunMode: "observe",
      solverEnabled: false,
    }).executionMode,
    "observe-only",
  );
});

test("TUI starts the configured run when it opens with included products", async () => {
  const { calls, tui } = createTuiHarness({}, {
    initialItems: [product({ id: "existing-product" })],
  });
  try {
    await tui.ready;
    await waitFor(
      () => calls.run.length === 1 && !tui.state.running,
      "startup auto-run",
    );
    assert.equal(calls.run[0][1], "stop-before-submit");
    assert.equal(tui.state.view, "run");
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    tui.destroy();
  }
});

test("choice settings use described selectors instead of free text", async () => {
  const { calls, tui } = createTuiHarness();
  try {
    await tui.ready;
    await tui.handleAction("settings");
    await tui.handleAction("activate");
    const modal = tui.state.modal;
    const choices = modal.children.find((child) => child.type === "list");
    assert.ok(choices);
    assert.equal(
      modal.children.some((child) => child.type === "textbox"),
      false,
    );
    assert.match(
      choices.children.find((child) => /Observe/.test(child.content)).content,
      /Observe.*Monitor availability/i,
    );
    choices.select(2);
    emitKey(choices, "enter");
    await waitFor(() => tui.state.modal === null, "setting selector save");
    assert.deepEqual(calls.setSetting[0], {
      retailer: "target",
      key: "default-run-mode",
      value: "live",
    });
  } finally {
    tui.destroy();
  }
});

test("import controller requires a valid preview and explicit product mode", async () => {
  const persisted = [];
  const controller = createImportController({
    addMany: async (items) => {
      persisted.push(...items);
      return items;
    },
  });
  assert.equal(controller.preview("invalid"), false);
  assert.match(controller.state.error, /Name: URL/i);
  assert.equal(
    controller.preview(
      "30th Celebration:\nElite Trainer Box: target.com/p/-/A-1000000001",
    ),
    true,
  );
  await assert.rejects(controller.confirm(), /Select Buy Now, Preorder, or Buy/);
  controller.selectMode("Preorder");
  assert.equal(controller.state.armed, true);
  const added = await controller.confirm();
  assert.equal(added.length, 1);
  assert.deepEqual(
    persisted.map(({ name, group, mode, armed }) => ({
      name,
      group,
      mode,
      armed,
    })),
    [{
      name: "Elite Trainer Box",
      group: "30th Celebration",
      mode: "preorder",
      armed: true,
    }],
  );
});

test("minimum-size state replaces overlapping UI with actionable guidance", () => {
  assert.equal(terminalSizeState(120, 40).tooSmall, false);
  const small = terminalSizeState(89, 27);
  assert.equal(small.tooSmall, true);
  assert.match(small.message, /at least 90x28/);
  assert.match(small.message, /89x27/);
});

test("run event and log projection is bounded and strips terminal controls", () => {
  assert.equal(safeLogLine("\u001b[31mFAIL\u001b[0m\u0000"), "FAIL");
  let projected = projectRunEvent(
    { statuses: {}, logs: [] },
    {
      retailer: "target",
      itemIds: ["product-one"],
      event: {
        status: "Safety stop: ready-to-submit",
        terminalOutcome: "ready-to-submit",
        important: true,
      },
      at: "2026-09-19T18:01:00.000Z",
    },
  );
  assert.deepEqual(projected.statuses["product-one"], {
    status: "Safety stop: ready-to-submit",
    terminalOutcome: "ready-to-submit",
    at: "2026-09-19T18:01:00.000Z",
    important: true,
  });
  assert.match(projected.logs[0], /Safety stop/);
  projected = projectRunEvent(projected, {
    retailer: "target",
    itemIds: ["product-one"],
    event: {
      status: "Verification backoff",
      backoffMs: 2984894,
      important: true,
    },
    at: "2026-09-19T18:01:00.000Z",
  });
  assert.equal(
    projected.backoffUntil,
    new Date(Date.parse("2026-09-19T18:01:00.000Z") + 2984894).toISOString(),
  );
  projected.logs = appendProjectedLog(["first", "second"], "third", 2);
  assert.deepEqual(projected.logs, ["second", "third"]);

  const lines = [];
  const sink = createChunkLogSink((line) => lines.push(line), "ERR: ");
  sink.write("one\n\u001b[32mtwo");
  sink.write("\u001b[0m\nthree");
  sink.flush();
  assert.deepEqual(lines, ["ERR: one", "ERR: two", "ERR: three"]);
});

test("run stats projection tracks live event categories and lifecycle", () => {
  const started = "2026-09-19T18:00:00.000Z";
  const checked = "2026-09-19T18:00:05.000Z";
  let projected = projectRunLifecycle(createRunProjection(), {
    type: "starting",
    retailer: "target",
    mode: "observe-only",
    itemIds: ["product-one"],
    at: started,
  });
  projected = projectRunEvent(projected, {
    retailer: "target",
    itemIds: ["product-one"],
    event: {
      status: "Monitoring (HTTP 200)",
    },
    at: checked,
  });
  projected = projectRunEvent(projected, {
    retailer: "target",
    itemIds: ["product-one"],
    event: {
      status: "Verification detected",
      important: true,
    },
    at: "2026-09-19T18:00:06.000Z",
  });
  projected = projectRunEvent(projected, {
    retailer: "target",
    itemIds: ["product-one"],
    event: {
      status: "Safety stop: ready-to-submit",
      terminalOutcome: "ready-to-submit",
      important: true,
    },
    at: "2026-09-19T18:00:07.000Z",
  });
  projected = projectRunLifecycle(projected, {
    type: "closed",
    retailer: "target",
    mode: "observe-only",
    itemIds: ["product-one"],
    code: 0,
    signal: null,
    interrupted: false,
    at: "2026-09-19T18:00:08.000Z",
  });

  assert.equal(projected.eventCount, 3);
  assert.equal(projected.pollCount, 1);
  assert.equal(projected.verificationCount, 1);
  assert.equal(projected.errorCount, 1);
  assert.equal(projected.terminalCount, 1);
  assert.equal(projected.productStats["product-one"].polls, 1);
  assert.equal(projected.productStats["product-one"].errors, 1);
  assert.equal(projected.productStats["product-one"].terminalOutcome, "ready-to-submit");
  assert.equal(projected.workers.target.status, "completed");
  assert.equal(projected.startedAt, started);
  assert.equal(projected.endedAt, "2026-09-19T18:00:08.000Z");
  assert.equal(formatRunElapsed(started, projected.endedAt), "00:08");
});

test("Run Stats view renders bounded live panels", async () => {
  const { tui } = createTuiHarness({}, {
    autoStart: false,
    initialItems: [product()],
  });
  try {
    await tui.ready;
    await tui.handleAction("run-stats");
    assert.equal(tui.state.view, "run-stats");
    assert.ok(findWidget(tui.screen, "run-stats-activity"));
    assert.ok(findWidget(tui.screen, "run-stats-events"));
    assert.ok(findWidget(tui.screen, "run-stats-feed"));
  } finally {
    tui.destroy();
  }
});

test("Run Stats remains selected through active-run completion", async () => {
  const pendingRun = deferred();
  const { tui } = createTuiHarness({}, {
    initialItems: [product({ id: "live-stats-product" })],
    runEngine: async (...args) => {
      args[2].onLifecycle({
        type: "starting",
        retailer: "target",
        mode: "observe-only",
        itemIds: ["live-stats-product"],
      });
      await pendingRun.promise;
      return { code: 0, signal: null, interrupted: false };
    },
  });
  try {
    await tui.ready;
    await waitFor(() => tui.state.running, "active stats run");
    await tui.handleAction("run-stats");
    assert.equal(tui.state.view, "run-stats");
    pendingRun.resolve();
    await waitFor(() => !tui.state.running, "stats run completion");
    assert.equal(tui.state.view, "run-stats");
  } finally {
    tui.destroy();
  }
});

test("focused neo-blessed form children route Add and Edit saves once", async () => {
  const { calls, tui } = createTuiHarness();
  try {
    await tui.ready;
    await tui.handleAction("add");
    const addModal = tui.state.modal;
    const [url] = addModal.children.filter(
      (child) => child.type === "textbox",
    );
    url.setValue("https://www.target.com/p/-/A-1000000002");
    emitKey(url, "s", { full: "C-s", ctrl: true });
    await waitFor(
      () => tui.state.modal === null && !tui.state.running,
      "Add modal save and run",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.add.length, 1);
    assert.equal(calls.add[0].name, "");
    assert.equal(calls.add[0].group, "");
    assert.equal(calls.add[0].armed, true);
    assert.equal(calls.run.length, 1);

    await tui.handleAction("edit");
    const editModal = tui.state.modal;
    const editName = editModal.children.find((child) => child.type === "textbox");
    editName.setValue("Edited Product");
    emitKey(editName, "s", { full: "C-s", ctrl: true });
    await waitFor(() => tui.state.modal === null, "Edit modal save");
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].input.name, "Edited Product");
  } finally {
    tui.destroy();
  }
});

test("focused Import children route F2, Enter, and one-press Escape", async () => {
  const { calls, tui } = createTuiHarness();
  try {
    await tui.ready;
    await tui.handleAction("import");
    let textarea = tui.state.modal.children.find(
      (child) => child.type === "textarea",
    );
    textarea.setValue(
      "Test Group:\nImported Product: target.com/p/-/A-1000000003",
    );
    emitKey(textarea, "f2");

    let previewModal = tui.state.modal;
    let modes = previewModal.children.find((child) => child.type === "list");
    assert.equal(
      previewModal.children.some((child) => child.type === "checkbox"),
      false,
    );
    emitKey(modes, "f2");

    const pasteModal = tui.state.modal;
    assert.notEqual(pasteModal, previewModal);
    textarea = pasteModal.children.find((child) => child.type === "textarea");
    emitKey(textarea, "f2");
    previewModal = tui.state.modal;
    modes = previewModal.children.find((child) => child.type === "list");
    emitKey(modes, "enter");
    await waitFor(() => tui.state.modal === null, "Import confirmation");
    assert.equal(calls.addMany.length, 1);
    assert.equal(calls.addMany[0][0].mode, "buy-now");
    assert.equal(calls.addMany[0][0].armed, true);

    await tui.handleAction("add");
    const escapeModal = tui.state.modal;
    const focusedInput = escapeModal.children.find(
      (child) => child.type === "textbox",
    );
    emitKey(focusedInput, "escape");
    assert.equal(tui.state.modal, null);
  } finally {
    tui.destroy();
  }
});

test("product form Tab moves through add controls", async () => {
  const { tui } = createTuiHarness();
  try {
    await tui.ready;
    await tui.handleAction("add");
    const modal = tui.state.modal;
    const url = modal.children.find((child) => child.type === "textbox");
    const modes = modal.children.find((child) => child.type === "list");
    assert.equal(modal.screen.focused, url);
    emitKey(url, "tab");
    assert.equal(modal.screen.focused, modes);
    emitKey(modes, "tab");
    assert.equal(modal.screen.focused, url);
  } finally {
    tui.destroy();
  }
});

test("product form Enter saves from the mode list and starts the configured run", async () => {
  const { calls, tui } = createTuiHarness();
  try {
    await tui.ready;
    await tui.handleAction("add");
    const modal = tui.state.modal;
    const url = modal.children.find((child) => child.type === "textbox");
    const modes = modal.children.find((child) => child.type === "list");
    url.setValue("https://www.target.com/p/-/A-1000000004");
    modes.select(2);
    emitKey(modes, "enter");
    await waitFor(
      () => tui.state.modal === null && !tui.state.running && tui.state.view === "run",
      "Enter product save and run",
    );
    assert.equal(calls.add.length, 1);
    assert.equal(calls.add[0].url, "https://www.target.com/p/-/A-1000000004");
    assert.equal(calls.add[0].mode, "buy");
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0][1], "stop-before-submit");
    assert.match(tui.state.notice, /Run completed/);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    tui.destroy();
  }
});

test("live-purchase default starts automatically without confirmation", async () => {
  const { calls, tui } = createTuiHarness({
    getSettings: async () => ({
      ...targetSettingsDefaults,
      defaultRunMode: "live",
    }),
  });
  try {
    await tui.ready;
    await tui.handleAction("add");
    const addModal = tui.state.modal;
    const url = addModal.children.find((child) => child.type === "textbox");
    url.setValue("https://www.target.com/p/-/A-1000000005");
    emitKey(url, "enter");
    await waitFor(
      () => calls.run.length === 1 && !tui.state.running && tui.state.modal === null,
      "live auto-run",
    );
    assert.equal(calls.run[0][1], "live-purchase");
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    tui.destroy();
  }
});

test("automatic runs retry retryable startup failures until explicitly stopped", async () => {
  let attempts = 0;
  const { tui } = createTuiHarness({}, {
    initialItems: [product({ id: "retry-product" })],
    autoRestartDelayMs: 5,
    runEngine: async () => {
      attempts += 1;
      const error = new Error("Chrome CDP unavailable");
      error.retryable = true;
      throw error;
    },
  });
  try {
    await tui.ready;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(attempts >= 2, `Expected a retry, got ${attempts} attempt(s).`);
    await tui.handleAction("stop-run");
    assert.equal(tui.state.autoRunEnabled, false);
    const stoppedAttempts = attempts;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(attempts, stoppedAttempts);
  } finally {
    tui.destroy();
  }
});

test("pending modal submission blocks re-entry and ignores stale errors", async () => {
  const pendingAdd = deferred();
  let addCalls = 0;
  const { tui } = createTuiHarness({
    add: async () => {
      addCalls += 1;
      return pendingAdd.promise;
    },
  });
  try {
    await tui.ready;
    await tui.handleAction("add");
    const submittedModal = tui.state.modal;
    const name = submittedModal.children.find((child) => child.type === "textbox");
    name.setValue("Deferred Product");
    emitKey(name, "s", { full: "C-s", ctrl: true });
    assert.equal(submittedModal.submissionPending, true);
    emitKey(name, "s", { full: "C-s", ctrl: true });
    emitKey(name, "escape");
    assert.equal(addCalls, 1);
    assert.equal(tui.state.modal, submittedModal);

    const oldError = submittedModal.children.find(
      (child) => child.name === "modal-error",
    );
    oldError.setContent = () => assert.fail("stale modal error was updated");
    submittedModal.destroy();
    tui.state.modal = null;
    await tui.handleAction("import");
    const newerModal = tui.state.modal;
    pendingAdd.reject(new Error("deferred failure"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tui.state.modal, newerModal);
    assert.equal(newerModal.destroyed, undefined);
  } finally {
    tui.destroy();
  }
});

test("deferred modal success cannot close a newer modal", async () => {
  const pendingAdd = deferred();
  const { tui } = createTuiHarness({
    add: async () => pendingAdd.promise,
  });
  try {
    await tui.ready;
    await tui.handleAction("add");
    const submittedModal = tui.state.modal;
    const name = submittedModal.children.find((child) => child.type === "textbox");
    name.setValue("Deferred Product");
    emitKey(name, "s", { full: "C-s", ctrl: true });

    submittedModal.destroy();
    tui.state.modal = null;
    await tui.handleAction("import");
    const newerModal = tui.state.modal;
    pendingAdd.resolve(product({ id: "deferred-product" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tui.state.modal, newerModal);
    assert.equal(newerModal.destroyed, undefined);
  } finally {
    tui.destroy();
  }
});
