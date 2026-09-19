const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  actionForKey,
  appendProjectedLog,
  createChunkLogSink,
  createDealsTui,
  createImportController,
  navigationItems,
  palette,
  productDetail,
  productTableHeader,
  productRows,
  projectRunEvent,
  runSetupDefaults,
  safeLogLine,
  statusColor,
  terminalSizeState,
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

function createTuiHarness(storeOverrides = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 120;
  output.rows = 40;
  output.on("data", () => {});

  let items = [];
  const calls = {
    add: [],
    addMany: [],
    update: [],
  };
  const store = {
    list: async () => items,
    getSettings: async () => ({ ...targetSettingsDefaults }),
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
    runEngine: async () => ({ code: 0, signal: null, interrupted: false }),
    input,
    output,
  });
  return { calls, store, tui };
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

test("keyboard mapping covers primary navigation and product actions", () => {
  assert.deepEqual(
    navigationItems.map((item) => item.id),
    ["products", "import", "add", "run-setup", "settings", "secrets", "help"],
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
  assert.equal(actionForKey("s"), "settings");
  assert.equal(actionForKey("escape"), "back");
  assert.equal(actionForKey("q"), "quit");
  assert.equal(actionForKey({ full: "C-c" }), "stop-run");
});

test("run setup uses armed products, stored solver choice, and safe default mode", () => {
  const items = [product(), product({ id: "two", armed: false })];
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
  assert.equal(controller.toggleArmed(), true);
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
  projected.logs = appendProjectedLog(["first", "second"], "third", 2);
  assert.deepEqual(projected.logs, ["second", "third"]);

  const lines = [];
  const sink = createChunkLogSink((line) => lines.push(line), "ERR: ");
  sink.write("one\n\u001b[32mtwo");
  sink.write("\u001b[0m\nthree");
  sink.flush();
  assert.deepEqual(lines, ["ERR: one", "ERR: two", "ERR: three"]);
});

test("focused neo-blessed form children route Add and Edit saves once", async () => {
  const { calls, tui } = createTuiHarness();
  try {
    await tui.ready;
    await tui.handleAction("add");
    const addModal = tui.state.modal;
    const [name, group, url] = addModal.children.filter(
      (child) => child.type === "textbox",
    );
    name.setValue("Added Product");
    group.setValue("Test Group");
    url.setValue("https://www.target.com/p/-/A-1000000002");
    emitKey(name, "s", { full: "C-s", ctrl: true });
    await waitFor(() => tui.state.modal === null, "Add modal save");
    assert.equal(calls.add.length, 1);
    assert.equal(calls.add[0].name, "Added Product");

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

test("focused Import children route F2, Space, Enter, and one-press Escape", async () => {
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
    let armed = previewModal.children.find((child) => child.type === "checkbox");
    emitKey(modes, "space", { ch: " " });
    assert.equal(armed.checked, true);
    emitKey(armed, "f2");

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
