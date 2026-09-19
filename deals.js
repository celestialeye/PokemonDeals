const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn } = require("node:child_process");
const { stdin, stdout, stderr } = require("node:process");
const {
  createCatalogStore,
  validateCatalog,
} = require("./src/deals-catalog");
const {
  adapterForRetailer,
  adapters,
} = require("./src/deals-adapters");
const {
  modeLabel,
  normalizeMode,
  parseGroupedList,
} = require("./src/deals-core");
const {
  createSecretStore,
  emptySecrets,
  secretRows,
} = require("./src/deals-secrets");

const catalogPath = path.join(__dirname, "data", "deals.json");
const secretPath = path.join(__dirname, "data", "deals-secrets.local.json");

function parseCommandLine(argv) {
  const [command = null, ...tokens] = argv;
  const options = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals > 0 ? equals : undefined);
    if (equals > 0) {
      options[key] = token.slice(equals + 1);
    } else if (tokens[index + 1] && !tokens[index + 1].startsWith("--")) {
      options[key] = tokens[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, options, positionals };
}

function optionBoolean(options, positive, negative) {
  if (options[positive] && options[negative]) {
    throw new Error(`Use either --${positive} or --${negative}, not both.`);
  }
  if (options[positive]) {
    return true;
  }
  if (options[negative]) {
    return false;
  }
  return undefined;
}

function challengeSolverOption(options, defaultValue) {
  const short = optionBoolean(options, "solver", "no-solver");
  const long = optionBoolean(
    options,
    "challenge-solver",
    "no-challenge-solver",
  );
  if (short !== undefined && long !== undefined && short !== long) {
    throw new Error("Conflicting challenge solver flags.");
  }
  return short ?? long ?? defaultValue;
}

function truncate(value, width) {
  const text = String(value ?? "");
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function displayUrl(url) {
  if (!stdout.isTTY || !process.env.WT_SESSION) {
    return url;
  }
  return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
}

function uniqueIdPrefix(items, id, minimum = 6) {
  for (let length = minimum; length < id.length; length += 1) {
    const prefix = id.slice(0, length);
    if (items.filter((item) => item.id.startsWith(prefix)).length === 1) {
      return prefix;
    }
  }
  return id;
}

function retailerLabel(retailer) {
  return adapterForRetailer(retailer)?.displayName || "Unsupported";
}

function printProducts(items, output = stdout) {
  if (items.length === 0) {
    output.write("No products in data\\deals.json.\n");
    return;
  }
  const rows = items.map((item) => [
    uniqueIdPrefix(items, item.id),
    item.armed ? "yes" : "no",
    retailerLabel(item.retailer),
    modeLabel(item.mode),
    truncate(item.name, 28),
    truncate(item.group || "-", 18),
    truncate(
      item.terminalOutcome
        ? `${item.lastStatus} [${item.terminalOutcome}]`
        : item.lastStatus,
      32,
    ),
    item.lastStatusAt ? item.lastStatusAt.replace("T", " ").slice(0, 19) : "-",
    displayUrl(item.url),
  ]);
  const headers = [
    "ID",
    "Armed",
    "Retailer",
    "Mode",
    "Name",
    "Group",
    "Last status",
    "Last time",
    "URL",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (row) =>
    row.map((value, index) =>
      index === row.length - 1
        ? String(value)
        : String(value).padEnd(widths[index]),
    ).join("  ");
  output.write(`${line(headers)}\n`);
  output.write(`${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of rows) {
    output.write(`${line(row)}\n`);
  }
}

function printImportPreview(items, output = stdout) {
  output.write(`Parsed ${items.length} product(s):\n`);
  for (const item of items) {
    output.write(
      `  ${item.group ? `[${item.group}] ` : ""}${item.name}: ${item.url}\n`,
    );
  }
}

async function printSettings(store, {
  secretStore = null,
  env = process.env,
  output = stdout,
} = {}) {
  for (const adapter of adapters) {
    if (!adapter.settings) {
      continue;
    }
    const settings = await store.getSettings(adapter.id);
    output.write(`\n${adapter.displayName} settings\n`);
    for (const row of adapter.settings.rows(settings)) {
      output.write(`  ${row.key} = ${row.value}\n`);
    }
  }
  if (secretStore) {
    await printSecrets(secretStore, { env, output });
  }
}

async function printSecrets(secretStore, {
  env = process.env,
  output = stdout,
  reveal = false,
} = {}) {
  output.write(`\nLocal secrets${reveal ? " (revealed)" : " (masked)"}\n`);
  const stored = await secretStore.getAll();
  for (const row of secretRows(stored, env, { reveal })) {
    output.write(
      `  ${row.key} = ${row.storedValue}; environment override: ${row.environmentOverridePresent ? "present" : "missing"} (${row.requirement})\n`,
    );
  }
}

async function readStream(stream) {
  let content = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    content += chunk;
  }
  return content;
}

async function loadImportText(options) {
  if (options.file) {
    return fs.readFile(path.resolve(String(options.file)), "utf8");
  }
  if (stdin.isTTY) {
    throw new Error("Direct import requires --file or piped stdin.");
  }
  return readStream(stdin);
}

function splitOutputLines(onLine) {
  let pending = "";
  return {
    write(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        onLine(line);
      }
    },
    flush() {
      if (pending) {
        onLine(pending);
        pending = "";
      }
    },
  };
}

function matchEventItems(items, event, activeProductId = null) {
  let matched;
  if (event.scope === "all") {
    matched = items;
  } else if (event.sourceUrl) {
    matched = items.filter((item) => item.url === event.sourceUrl);
  } else {
    const productId = event.productId || activeProductId;
    matched = productId
      ? items.filter((item) => item.resolvedProductId === productId)
      : [];
  }
  return event.scope === "all" && event.terminalOutcome
    ? matched.filter((item) => !item.terminalOutcome)
    : matched;
}

async function runAdapter(store, adapter, items, executionMode, {
  challengeSolver,
  preparedRun = null,
  spawnImpl = spawn,
  output = stdout,
  errorOutput = stderr,
  env = process.env,
  secrets = emptySecrets().secrets,
  settings = adapter.settings?.defaults || {},
} = {}) {
  const run = preparedRun || prepareAdapterRun(
    adapter,
    items,
    executionMode,
    {
      challengeSolver,
      env,
      secrets,
      settings,
    },
  );
  const solverStatus = run.challengeSolverEnabled === undefined
    ? ""
    : `; bundled challenge recovery ${run.challengeSolverEnabled ? "enabled" : "disabled"}`;
  output.write(
    `Starting ${adapter.displayName} in ${executionMode} mode${solverStatus}.\n`,
  );
  await store.updateRuntime(
    items.map((item) => item.id),
    {
      lastStatus: `Starting ${executionMode}${solverStatus}`,
      lastStatusAt: new Date().toISOString(),
      terminalOutcome: null,
    },
  );

  return new Promise((resolve, reject) => {
    const startedIds = new Set(items.map((item) => item.id));
    const child = spawnImpl(run.command, run.args, {
      cwd: __dirname,
      env: run.env,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: false,
    });
    let interrupted = false;
    let closed = false;
    let persistenceError = null;
    let activeProductId = null;
    let updateChain = Promise.resolve();
    let forceTimer = null;

    const stopChild = () => {
      if (closed) {
        return;
      }
      try {
        child.kill("SIGINT");
      } catch (error) {
        child.kill();
      }
      if (!forceTimer) {
        forceTimer = setTimeout(() => {
          if (!closed) {
            child.kill("SIGTERM");
          }
        }, 5000);
        forceTimer.unref?.();
      }
    };

    const queueUpdate = (action) => {
      updateChain = updateChain.then(action).catch((error) => {
        if (!persistenceError) {
          persistenceError = error;
          errorOutput.write(
            `Catalog update failed; stopping ${adapter.displayName} worker: ${error.message}\n`,
          );
          stopChild();
        }
      });
    };

    const handleLine = (line) => {
      const event = adapter.parseOutput(line);
      if (!event) {
        return;
      }
      if (event.productId) {
        activeProductId = event.productId;
      }
      const eventProductId = event.productId || activeProductId;
      queueUpdate(async () => {
        const currentItems = (await store.list()).filter((item) =>
          startedIds.has(item.id),
        );
        const matched = matchEventItems(currentItems, event, eventProductId);
        if (matched.length === 0) {
          return;
        }
        const patch = {
          lastStatus: event.status,
          lastStatusAt: new Date().toISOString(),
        };
        if (event.terminalOutcome) {
          patch.terminalOutcome = event.terminalOutcome;
        }
        if (event.resolvedUrl) {
          patch.resolvedUrl = event.resolvedUrl;
          patch.resolvedProductId = event.productId || null;
        }
        if (matched.length > 0) {
          await store.updateRuntime(
            matched.map((item) => item.id),
            patch,
          );
        }
      });
    };
    const stdoutLines = splitOutputLines(handleLine);
    const stderrLines = splitOutputLines(handleLine);
    child.stdout.on("data", (chunk) => {
      output.write(chunk);
      stdoutLines.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errorOutput.write(chunk);
      stderrLines.write(chunk);
    });

    const onInterrupt = () => {
      if (interrupted) {
        return;
      }
      interrupted = true;
      errorOutput.write(`\nStopping ${adapter.displayName} worker...\n`);
      stopChild();
    };
    process.once("SIGINT", onInterrupt);

    child.once("error", (error) => {
      process.removeListener("SIGINT", onInterrupt);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      updateChain
        .then(() =>
          store.updateRuntime([...startedIds], {
            lastStatus: `Worker failed to start: ${error.message}`,
            lastStatusAt: new Date().toISOString(),
            terminalOutcome: "worker-error",
          }),
        )
        .then(() => reject(error), reject);
    });
    child.once("close", (code, signal) => {
      closed = true;
      process.removeListener("SIGINT", onInterrupt);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      stdoutLines.flush();
      stderrLines.flush();
      updateChain
        .then(async () => {
          if (persistenceError) {
            throw persistenceError;
          }
          const current = await store.list();
          const unfinished = current.filter(
            (item) =>
              items.some((started) => started.id === item.id) &&
              !item.terminalOutcome,
          );
          if (unfinished.length > 0) {
            await store.updateRuntime(
              unfinished.map((item) => item.id),
              {
                lastStatus: interrupted
                  ? "Stopped by operator"
                  : code === 0
                    ? "Worker exited"
                    : `Worker failed (${code ?? signal})`,
                lastStatusAt: new Date().toISOString(),
                terminalOutcome: interrupted
                  ? "interrupted"
                  : code === 0
                    ? "exited"
                    : "worker-error",
              },
            );
          }
          resolve({ code, signal, interrupted });
        })
        .catch(reject);
    });
  });
}

function prepareAdapterRun(adapter, items, executionMode, {
  challengeSolver,
  env = process.env,
  secrets = emptySecrets().secrets,
  settings = adapter.settings?.defaults || {},
} = {}) {
  const runtimeEnv = adapter.applySecrets
    ? adapter.applySecrets(env, secrets)
    : { ...env };
  const missing = adapter.validateEnvironment(executionMode, runtimeEnv);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s) for active ${adapter.displayName} purchasing: ${missing.join(", ")}.`,
    );
  }
  const invalidSettings = adapter.settings?.validateRun(
    executionMode,
    settings,
  ) || [];
  if (invalidSettings.length > 0) {
    throw new Error(
      `Set required ${adapter.displayName} setting(s) before active purchasing: ${invalidSettings.join(", ")}.`,
    );
  }
  return adapter.buildRun(items, executionMode, {
    challengeSolver,
    env: runtimeEnv,
    settings,
  });
}

async function runEngine(store, executionMode, options = {}) {
  const catalog = validateCatalog(await store.read());
  const armed = catalog.items.filter((item) => item.armed);
  if (armed.length === 0) {
    throw new Error("No products are armed.");
  }
  const retailers = [...new Set(armed.map((item) => item.retailer))];
  const {
    adapterOptions = {},
    secretStore = null,
    ...sharedOptions
  } = options;
  const secrets = secretStore
    ? await secretStore.getAll()
    : emptySecrets().secrets;
  const plans = [];
  for (const retailer of retailers) {
    const adapter = adapterForRetailer(retailer);
    if (!adapter) {
      throw new Error(`Armed retailer "${retailer}" has no execution adapter.`);
    }
    const settings = adapter.settings
      ? adapter.settings.normalize(catalog.settings[retailer])
      : {};
    const mode = adapter.normalizeExecutionMode(
      executionMode ||
      settings.defaultRunMode ||
      adapter.defaultExecutionMode,
    );
    const retailerItems = armed.filter((item) => item.retailer === retailer);
    const adapterRunOptions = adapterOptions[retailer] || {};
    plans.push({
      adapter,
      items: retailerItems,
      mode,
      options: {
        ...sharedOptions,
        ...adapterRunOptions,
        secrets,
        settings,
      },
      run: prepareAdapterRun(adapter, retailerItems, mode, {
        ...sharedOptions,
        ...adapterRunOptions,
        secrets,
        settings,
      }),
    });
  }

  for (const plan of plans) {
    const result = await runAdapter(
      store,
      plan.adapter,
      plan.items,
      plan.mode,
      {
        ...plan.options,
        preparedRun: plan.run,
      },
    );
    if (result.interrupted || result.code !== 0) {
      return result;
    }
  }
  return { code: 0, signal: null, interrupted: false };
}

async function collectPaste(rl, output = stdout) {
  output.write(
    'Paste grouped products as "Name: URL"; headings end in ":". Submit two blank lines when finished.\n',
  );
  const lines = [];
  let blankLines = 0;
  while (true) {
    const line = await rl.question(lines.length === 0 ? "> " : "");
    if (!line.trim()) {
      blankLines += 1;
      if (blankLines === 2) {
        lines.pop();
        break;
      }
      lines.push("");
      continue;
    }
    blankLines = 0;
    lines.push(line);
  }
  return lines.join("\n");
}

function parseYesNo(value, defaultValue) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (["y", "yes"].includes(normalized)) {
    return true;
  }
  if (["n", "no"].includes(normalized)) {
    return false;
  }
  throw new Error('Enter "yes" or "no".');
}

async function promptImportMode(rl, {
  errorOutput = stderr,
} = {}) {
  while (true) {
    const answer = await rl.question(
      'Mode (Buy Now, Preorder, or Buy; type "cancel" to abort): ',
    );
    if (/^cancel$/i.test(answer.trim())) {
      return null;
    }
    try {
      return normalizeMode(answer);
    } catch (error) {
      errorOutput.write(`Error: ${error.message}\n`);
    }
  }
}

async function completeInteractiveImport(store, rl, parsed, {
  output = stdout,
  errorOutput = stderr,
} = {}) {
  printImportPreview(parsed.items, output);
  const mode = await promptImportMode(rl, { errorOutput });
  if (!mode) {
    output.write("Import canceled.\n");
    return [];
  }
  const armed = /^(?:y|yes)$/i.test(
    await rl.question("Arm imported products? [y/N]: "),
  );
  if (!/^(?:y|yes)$/i.test(await rl.question("Import these products? [y/N]: "))) {
    output.write("Import canceled.\n");
    return [];
  }
  const added = await store.addMany(
    parsed.items.map((item) => ({ ...item, mode, armed })),
  );
  output.write(`Imported ${added.length} product(s).\n`);
  return added;
}

async function questionSecret(rl, prompt) {
  if (typeof rl._writeToOutput !== "function") {
    return rl.question(prompt);
  }
  const writeToOutput = rl._writeToOutput;
  stdout.write(prompt);
  rl._writeToOutput = () => {};
  try {
    return await rl.question("");
  } finally {
    rl._writeToOutput = writeToOutput;
    stdout.write("\n");
  }
}

async function interactiveSettings(store, secretStore, rl) {
  while (true) {
    await printSettings(store, { secretStore });
    stdout.write(
      "\n1. Set setting\n" +
      "2. Set secret\n" +
      "3. Clear secret\n" +
      "4. Reveal stored secrets\n" +
      "5. Back\n",
    );
    const choice = (await rl.question("Choose: ")).trim();
    if (choice === "5") {
      return;
    }
    try {
      if (choice === "1") {
        const qualifiedKey = (await rl.question(
          "Setting key (for example target.poll-interval-ms): ",
        )).trim();
        const value = await rl.question("Value: ");
        const separator = qualifiedKey.indexOf(".");
        if (separator <= 0) {
          throw new Error("Setting key must include its retailer namespace.");
        }
        const retailer = qualifiedKey.slice(0, separator).toLowerCase();
        const key = qualifiedKey.slice(separator + 1);
        await store.setSetting(retailer, key, value);
        stdout.write(`Updated ${qualifiedKey}.\n`);
      } else if (choice === "2") {
        const key = await rl.question(
          "Secret key (target.pin or discord.webhook-url): ",
        );
        const value = await questionSecret(rl, "Secret value: ");
        const storedKey = await secretStore.set(key, value);
        stdout.write(`Stored ${storedKey}.\n`);
      } else if (choice === "3") {
        const key = await rl.question(
          "Secret key (target.pin or discord.webhook-url): ",
        );
        const clearedKey = await secretStore.clear(key);
        stdout.write(`Cleared ${clearedKey}.\n`);
      } else if (choice === "4") {
        await printSecrets(secretStore, { reveal: true });
      } else {
        stderr.write("Error: Choose a number from 1 to 5.\n");
      }
    } catch (error) {
      stderr.write(`Error: ${error.message}\n`);
    }
  }
}

async function interactiveRunOptions(store, rl) {
  const armed = (await store.list()).filter((item) => item.armed);
  const adapterOptions = {};
  for (const retailer of [...new Set(armed.map((item) => item.retailer))]) {
    const adapter = adapterForRetailer(retailer);
    if (!adapter) {
      continue;
    }
    const settings = await store.getSettings(retailer);
    const prompts = adapter.runOptionPrompts?.(settings) || [];
    for (const prompt of prompts) {
      adapterOptions[retailer] ||= {};
      adapterOptions[retailer][prompt.key] = parseYesNo(
        await rl.question(
          `${prompt.label} [${prompt.defaultValue ? "Y/n" : "y/N"}]: `,
        ),
        prompt.defaultValue,
      );
    }
  }
  return adapterOptions;
}

async function interactiveMenu(store, secretStore) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      stdout.write(
        "\nDeals purchasing engine\n" +
        "1. List products\n" +
        "2. Add product\n" +
        "3. Paste/import grouped list\n" +
        "4. Edit product\n" +
        "5. Arm/disarm product\n" +
        "6. Delete product\n" +
        "7. Start engine\n" +
        "8. Settings\n" +
        "9. Exit\n",
      );
      const choice = (await rl.question("Choose: ")).trim();
      try {
        if (choice === "1") {
          printProducts(await store.list());
        } else if (choice === "2") {
          const name = await rl.question("Name: ");
          const group = await rl.question("Group (optional): ");
          const url = await rl.question("URL: ");
          const mode = normalizeMode(await rl.question("Mode (Buy Now, Preorder, Buy): "));
          const armed = /^(?:y|yes)$/i.test(await rl.question("Arm now? [y/N]: "));
          const item = await store.add({ name, group, url, mode, armed });
          stdout.write(`Added ${item.id} ${item.name}.\n`);
        } else if (choice === "3") {
          const parsed = parseGroupedList(await collectPaste(rl));
          if (parsed.errors.length > 0) {
            throw new Error(parsed.errors.join("\n"));
          }
          await completeInteractiveImport(store, rl, parsed);
        } else if (choice === "4") {
          const existing = await store.get(await rl.question("Product ID or prefix: "));
          const name = await rl.question(`Name [${existing.name}]: `);
          const group = await rl.question(`Group [${existing.group || "-"}]: `);
          const url = await rl.question(`URL [${existing.url}]: `);
          const mode = await rl.question(`Mode [${modeLabel(existing.mode)}]: `);
          const updated = await store.update(existing.id, {
            name: name || existing.name,
            group: group || existing.group,
            url: url || existing.url,
            mode: mode ? normalizeMode(mode) : existing.mode,
          });
          stdout.write(`Updated ${updated.id}.\n`);
        } else if (choice === "5") {
          const id = await rl.question("Product ID or prefix: ");
          const armAction = (await rl.question("Type arm or disarm: ")).trim();
          if (!/^(?:arm|enable|disarm|disable)$/i.test(armAction)) {
            throw new Error('Enter "arm" or "disarm".');
          }
          const armed = /^(?:arm|enable)$/i.test(armAction);
          const [updated] = await store.setArmed([id], armed);
          stdout.write(`${updated.id} is now ${armed ? "armed" : "disarmed"}.\n`);
        } else if (choice === "6") {
          const id = await rl.question("Product ID or prefix: ");
          const item = await store.get(id);
          if (/^(?:y|yes)$/i.test(await rl.question(`Delete ${item.name}? [y/N]: `))) {
            await store.remove(item.id);
            stdout.write(`Deleted ${item.id}.\n`);
          }
        } else if (choice === "7") {
          const answer = await rl.question(
            "Execution mode override (observe/stop-before-submit/live; blank uses retailer settings): ",
          );
          await runEngine(store, answer || null, {
            adapterOptions: await interactiveRunOptions(store, rl),
            secretStore,
          });
        } else if (choice === "8") {
          await interactiveSettings(store, secretStore, rl);
        } else if (choice === "9") {
          return;
        } else {
          stdout.write("Choose a number from 1 to 9.\n");
        }
      } catch (error) {
        stderr.write(`Error: ${error.message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function runCommand(store, secretStore, parsed) {
  const commandAliases = {
    enable: "arm",
    disable: "disarm",
    delete: "remove",
    run: "monitor",
  };
  const command = commandAliases[parsed.command] || parsed.command;
  const { options, positionals } = parsed;

  if (!command) {
    return interactiveMenu(store, secretStore);
  }
  if (command === "list") {
    printProducts(await store.list());
    return;
  }
  if (command === "settings") {
    if (positionals.length === 0) {
      await printSettings(store, { secretStore });
      return;
    }
    if (positionals[0] !== "set") {
      throw new Error("Use settings or settings set <retailer.key> <value>.");
    }
    const qualifiedKey = positionals[1];
    const value = positionals.slice(2).join(" ");
    const separator = String(qualifiedKey || "").indexOf(".");
    if (separator <= 0 || !value) {
      throw new Error("Use settings set <retailer.key> <value>.");
    }
    const retailer = qualifiedKey.slice(0, separator).toLowerCase();
    const key = qualifiedKey.slice(separator + 1);
    await store.setSetting(retailer, key, value);
    stdout.write(`Updated ${qualifiedKey}.\n`);
    return;
  }
  if (command === "secrets") {
    const action = positionals[0] || "list";
    if (action === "list") {
      await printSecrets(secretStore);
      return;
    }
    if (action === "show") {
      await printSecrets(secretStore, { reveal: true });
      return;
    }
    if (action === "set") {
      const key = positionals[1];
      const value = positionals.slice(2).join(" ");
      if (!key || !value) {
        throw new Error("Use secrets set <key> <value>.");
      }
      const storedKey = await secretStore.set(key, value);
      stdout.write(`Stored ${storedKey}.\n`);
      return;
    }
    if (action === "clear") {
      const key = positionals[1];
      if (!key) {
        throw new Error("Use secrets clear <key>.");
      }
      const clearedKey = await secretStore.clear(key);
      stdout.write(`Cleared ${clearedKey}.\n`);
      return;
    }
    throw new Error("Use secrets, secrets show, secrets set, or secrets clear.");
  }
  if (command === "add") {
    if (!options.mode) {
      throw new Error("add requires --mode buy-now, preorder, or buy.");
    }
    const armed = optionBoolean(options, "armed", "disarmed") || false;
    const item = await store.add({
      name: options.name,
      group: options.group || "",
      url: options.url,
      mode: options.mode,
      armed,
    });
    stdout.write(`Added ${item.id} ${item.name}.\n`);
    return;
  }
  if (command === "import") {
    if (!options.mode) {
      throw new Error("Direct import requires --mode buy-now, preorder, or buy.");
    }
    const parsedList = parseGroupedList(await loadImportText(options));
    printImportPreview(parsedList.items);
    if (parsedList.errors.length > 0) {
      throw new Error(parsedList.errors.join("\n"));
    }
    const armed = optionBoolean(options, "armed", "disarmed") || false;
    const added = await store.addMany(
      parsedList.items.map((item) => ({
        ...item,
        mode: normalizeMode(options.mode),
        armed,
      })),
    );
    stdout.write(`Imported ${added.length} product(s).\n`);
    return;
  }
  if (command === "edit") {
    const id = positionals[0] || options.id;
    const changes = {};
    for (const key of ["name", "group", "url"]) {
      if (options[key] !== undefined) {
        changes[key] = options[key];
      }
    }
    if (options.mode !== undefined) {
      changes.mode = options.mode;
    }
    const armed = optionBoolean(options, "armed", "disarmed");
    if (armed !== undefined) {
      changes.armed = armed;
    }
    const item = await store.update(id, changes);
    stdout.write(`Updated ${item.id} ${item.name}.\n`);
    return;
  }
  if (command === "arm" || command === "disarm") {
    const ids = positionals.length > 0
      ? positionals
      : String(options.id || "").split(",").filter(Boolean);
    if (ids.length === 0) {
      throw new Error(`${command} requires at least one product ID or prefix.`);
    }
    const items = await store.setArmed(ids, command === "arm");
    stdout.write(
      `${command === "arm" ? "Armed" : "Disarmed"} ${items.map((item) => item.id).join(", ")}.\n`,
    );
    return;
  }
  if (command === "remove") {
    const item = await store.remove(positionals[0] || options.id);
    stdout.write(`Deleted ${item.id} ${item.name}.\n`);
    return;
  }
  if (command === "monitor") {
    const challengeSolver = challengeSolverOption(options);
    const adapterOptions = challengeSolver === undefined
      ? {}
      : { target: { challengeSolver } };
    const result = await runEngine(
      store,
      options.execution || options.mode || null,
      { adapterOptions, secretStore },
    );
    if (result.interrupted) {
      process.exitCode = 130;
    } else if (result.code !== 0) {
      process.exitCode = result.code || 1;
    }
    return;
  }
  throw new Error(
    "Unknown command. Use list, add, import, edit, arm/disarm, enable/disable, remove, settings, secrets, or monitor/run.",
  );
}

async function main() {
  const store = createCatalogStore(catalogPath);
  const secretStore = createSecretStore(secretPath);
  await runCommand(
    store,
    secretStore,
    parseCommandLine(process.argv.slice(2)),
  );
}

if (require.main === module) {
  main().catch((error) => {
    stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  challengeSolverOption,
  collectPaste,
  completeInteractiveImport,
  matchEventItems,
  parseCommandLine,
  parseYesNo,
  printProducts,
  printSecrets,
  printSettings,
  prepareAdapterRun,
  promptImportMode,
  questionSecret,
  interactiveRunOptions,
  retailerLabel,
  runAdapter,
  runCommand,
  runEngine,
  uniqueIdPrefix,
};
