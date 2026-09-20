const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeMode, normalizeUrl } = require("./deals-core");
const {
  adapterForRetailer,
  adapters,
  defaultRetailerSettings,
  normalizeRetailerSettings,
  productMetadata,
  resolveProductMetadata,
} = require("./deals-adapters");

const catalogVersion = 2;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyCatalog() {
  return {
    version: catalogVersion,
    settings: defaultRetailerSettings(),
    items: [],
  };
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`Catalog item ${field} must be a ${allowEmpty ? "" : "non-empty "}string.`);
  }
  return allowEmpty ? value : value.trim();
}

function optionalString(value, field) {
  if (value === null) {
    return null;
  }
  return requireString(value, field);
}

function optionalTimestamp(value, field) {
  if (value === null) {
    return null;
  }
  const timestamp = requireString(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new Error(`Catalog item ${field} must be an ISO timestamp or null.`);
  }
  return timestamp;
}

function requiredTimestamp(value, field) {
  const timestamp = optionalTimestamp(value, field);
  if (timestamp === null) {
    throw new Error(`Catalog item ${field} must be an ISO timestamp.`);
  }
  return timestamp;
}

function validateCatalogItem(item, index) {
  if (!isPlainObject(item)) {
    throw new Error(`Catalog item ${index + 1} must be an object.`);
  }
  const id = requireString(item.id, "id");
  const name = requireString(item.name, "name");
  const group = requireString(item.group, "group", { allowEmpty: true });
  const inputUrl = requireString(item.url, "url");
  const metadata = productMetadata(inputUrl);
  const url = metadata.normalizedUrl;
  const retailer = requireString(item.retailer, "retailer").toLowerCase();
  if (retailer !== metadata.retailer) {
    throw new Error(
      `Catalog item ${id} retailer does not match its canonical URL.`,
    );
  }
  let mode;
  try {
    mode = normalizeMode(item.mode);
  } catch (error) {
    throw new Error(`Catalog item ${id} has an invalid or missing mode.`);
  }
  if (typeof item.armed !== "boolean") {
    throw new Error(`Catalog item ${id} armed must be boolean.`);
  }
  const adapter = adapterForRetailer(retailer);
  if (adapter && !adapter.supportedModes.has(mode)) {
    throw new Error(`Catalog item ${id} mode is unsupported by ${retailer}.`);
  }
  if (item.armed && !adapter) {
    throw new Error(
      `Catalog item ${id} uses an unsupported armed retailer.`,
    );
  }

  const resolvedProductId = optionalString(
    item.resolvedProductId,
    "resolvedProductId",
  );
  const resolvedUrl = item.resolvedUrl === null
    ? null
    : normalizeUrl(requireString(item.resolvedUrl, "resolvedUrl"));
  if (Boolean(resolvedProductId) !== Boolean(resolvedUrl)) {
    throw new Error(
      `Catalog item ${id} resolved product ID and URL must both be set or null.`,
    );
  }
  if (
    metadata.resolvedProductId &&
    resolvedProductId !== metadata.resolvedProductId
  ) {
    throw new Error(`Catalog item ${id} resolved product does not match its URL.`);
  }
  if (resolvedProductId) {
    const resolvedMetadata = productMetadata(resolvedUrl);
    if (
      resolvedMetadata.retailer !== retailer ||
      resolvedMetadata.resolvedProductId !== resolvedProductId
    ) {
      throw new Error(
        `Catalog item ${id} resolved URL does not match its retailer product.`,
      );
    }
  }

  return {
    id,
    name,
    group,
    url,
    retailer,
    mode,
    armed: item.armed,
    resolvedProductId,
    resolvedUrl,
    lastStatus: requireString(item.lastStatus, "lastStatus"),
    lastStatusAt: optionalTimestamp(item.lastStatusAt, "lastStatusAt"),
    terminalOutcome: optionalString(item.terminalOutcome, "terminalOutcome"),
    createdAt: requiredTimestamp(item.createdAt, "createdAt"),
    updatedAt: requiredTimestamp(item.updatedAt, "updatedAt"),
  };
}

function validateCatalogItems(items) {
  const validated = items.map(validateCatalogItem);
  const ids = new Set();
  const urls = new Map();
  const products = new Map();
  for (const item of validated) {
    const normalizedId = item.id.toLowerCase();
    if (ids.has(normalizedId)) {
      throw new Error(`Duplicate catalog item ID: ${item.id}.`);
    }
    ids.add(normalizedId);

    const urlKey = `${item.retailer}|${item.url}`;
    if (urls.has(urlKey)) {
      throw new Error(
        `Duplicate retailer URL: ${item.id} conflicts with ${urls.get(urlKey)}.`,
      );
    }
    urls.set(urlKey, item.id);

    if (item.resolvedProductId) {
      const productKey = `${item.retailer}|${item.resolvedProductId}`;
      if (products.has(productKey)) {
        throw new Error(
          `Duplicate retailer product: ${item.id} conflicts with ${products.get(productKey)}.`,
        );
      }
      products.set(productKey, item.id);
    }
  }
  enforceArmedState(validated);
  return validated;
}

function validateCatalog(catalog) {
  if (
    isPlainObject(catalog) &&
    catalog.version === 1 &&
    Array.isArray(catalog.items)
  ) {
    return {
      version: catalogVersion,
      settings: defaultRetailerSettings(),
      items: validateCatalogItems(catalog.items),
    };
  }
  if (
    !isPlainObject(catalog) ||
    catalog.version !== catalogVersion ||
    !Array.isArray(catalog.items) ||
    !isPlainObject(catalog.settings)
  ) {
    throw new Error(
      `Unsupported deals catalog. Expected version ${catalogVersion}.`,
    );
  }
  for (const [retailer, settings] of Object.entries(catalog.settings)) {
    const adapter = adapterForRetailer(retailer);
    if (!adapter) {
      throw new Error(`Unknown retailer settings namespace: ${retailer}.`);
    }
    if (!isPlainObject(settings)) {
      throw new Error(`Retailer settings for ${retailer} must be an object.`);
    }
  }
  return {
    version: catalogVersion,
    settings: normalizeRetailerSettings(catalog.settings),
    items: validateCatalogItems(catalog.items),
  };
}

async function loadCatalog(filePath) {
  try {
    return validateCatalog(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyCatalog();
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Deals catalog is not valid JSON: ${filePath}`);
    }
    throw error;
  }
}

async function writeCatalogAtomic(filePath, catalog) {
  const validated = validateCatalog(catalog);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function duplicateFor(items, candidate, excludedId = null) {
  return items.find((item) => {
    if (item.id === excludedId) {
      return false;
    }
    if (normalizeUrl(item.url) === candidate.url) {
      return true;
    }
    return (
      candidate.resolvedProductId &&
      item.retailer === candidate.retailer &&
      item.resolvedProductId === candidate.resolvedProductId
    );
  });
}

function enforceArmedState(items) {
  for (const item of items.filter((entry) => entry.armed)) {
    const adapter = adapterForRetailer(item.retailer);
    if (!adapter) {
      throw new Error(
        `${item.name} uses an unsupported retailer and cannot be armed.`,
      );
    }
    if (!item.mode || !adapter.supportedModes.has(item.mode)) {
      throw new Error(`${item.name} needs a supported purchase mode before arming.`);
    }
  }

  for (const adapter of adapters) {
    const armed = items.filter(
      (item) => item.armed && item.retailer === adapter.id,
    );
    if (armed.length > adapter.maximumArmed) {
      throw new Error(
        `${adapter.displayName} supports at most ${adapter.maximumArmed} armed items; ${armed.length} were requested.`,
      );
    }
  }
}

function resolveUniquePrefix(items, value) {
  const prefix = String(value || "").trim().toLowerCase();
  if (!prefix) {
    throw new Error("A product ID is required.");
  }
  const exact = items.find((item) => item.id.toLowerCase() === prefix);
  if (exact) {
    return exact;
  }
  const matches = items.filter((item) => item.id.toLowerCase().startsWith(prefix));
  if (matches.length === 0) {
    throw new Error(`No product matches ID prefix "${value}".`);
  }
  if (matches.length > 1) {
    throw new Error(`ID prefix "${value}" is ambiguous.`);
  }
  return matches[0];
}

function createCatalogStore(filePath, {
  idFactory = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
  now = () => new Date().toISOString(),
  resolveMetadata = resolveProductMetadata,
} = {}) {
  async function save(catalog) {
    const validated = validateCatalog(catalog);
    enforceArmedState(validated.items);
    await writeCatalogAtomic(filePath, validated);
    return validated;
  }

  async function prepare(input, existing = null) {
    const inputUrl = normalizeUrl(input.url ?? existing?.url);
    const inputName = String(input.name ?? "").trim();
    const existingName = String(existing?.name ?? "").trim();
    const metadata = inputName || existingName
      ? productMetadata(inputUrl)
      : await resolveMetadata(inputUrl);
    const name = inputName || existingName || metadata.name || "Product";
    const url = metadata.normalizedUrl;
    const mode = normalizeMode(
      input.mode === undefined ? existing?.mode : input.mode,
    );
    const armedValue = input.armed === undefined ? existing?.armed : input.armed;
    if (typeof armedValue !== "boolean") {
      throw new Error("Product armed state must be boolean.");
    }
    const urlChanged = existing && normalizeUrl(existing.url) !== url;
    return {
      id: existing?.id || idFactory(),
      name,
      group: String(input.group ?? existing?.group ?? "").trim(),
      url,
      retailer: metadata.retailer,
      mode,
      armed: armedValue,
      resolvedProductId: metadata.resolvedProductId,
      resolvedUrl: metadata.resolvedUrl,
      lastStatus: urlChanged
        ? "Not run"
        : existing?.lastStatus || "Not run",
      lastStatusAt: urlChanged
        ? null
        : existing?.lastStatusAt || null,
      terminalOutcome: urlChanged
        ? null
        : existing?.terminalOutcome || null,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
  }

  return {
    filePath,
    async read() {
      return loadCatalog(filePath);
    },
    async list() {
      return (await loadCatalog(filePath)).items;
    },
    async getSettings(retailer) {
      const catalog = await loadCatalog(filePath);
      const adapter = adapterForRetailer(retailer);
      if (!adapter) {
        throw new Error(`Unknown retailer: ${retailer}.`);
      }
      return adapter.settings
        ? adapter.settings.normalize(catalog.settings[retailer])
        : {};
    },
    async setSetting(retailer, key, value) {
      const catalog = await loadCatalog(filePath);
      const adapter = adapterForRetailer(retailer);
      if (!adapter?.settings) {
        throw new Error(`Retailer "${retailer}" has no configurable settings.`);
      }
      catalog.settings[retailer] = adapter.settings.set(
        catalog.settings[retailer],
        key,
        value,
      );
      await save(catalog);
      return catalog.settings[retailer];
    },
    async add(input) {
      const catalog = await loadCatalog(filePath);
      const item = await prepare(input);
      if (catalog.items.some((existing) => existing.id === item.id)) {
        throw new Error(`Generated duplicate product ID: ${item.id}.`);
      }
      const duplicate = duplicateFor(catalog.items, item);
      if (duplicate) {
        throw new Error(
          `Duplicate product URL or retailer product: ${duplicate.id} ${duplicate.name}.`,
        );
      }
      catalog.items.push(item);
      await save(catalog);
      return item;
    },
    async addMany(inputs) {
      const catalog = await loadCatalog(filePath);
      const additions = [];
      for (const input of inputs) {
        const item = await prepare(input);
        if ([...catalog.items, ...additions].some(
          (existing) => existing.id === item.id,
        )) {
          throw new Error(`Generated duplicate product ID: ${item.id}.`);
        }
        const duplicate = duplicateFor([...catalog.items, ...additions], item);
        if (duplicate) {
          throw new Error(
            `Duplicate product URL or retailer product: ${item.name} conflicts with ${duplicate.id} ${duplicate.name}.`,
          );
        }
        additions.push(item);
      }
      catalog.items.push(...additions);
      await save(catalog);
      return additions;
    },
    async get(value) {
      return resolveUniquePrefix((await loadCatalog(filePath)).items, value);
    },
    async update(value, changes) {
      const catalog = await loadCatalog(filePath);
      const existing = resolveUniquePrefix(catalog.items, value);
      const replacement = await prepare(changes, existing);
      const duplicate = duplicateFor(catalog.items, replacement, existing.id);
      if (duplicate) {
        throw new Error(
          `Duplicate product URL or retailer product: ${duplicate.id} ${duplicate.name}.`,
        );
      }
      const index = catalog.items.findIndex((item) => item.id === existing.id);
      catalog.items[index] = replacement;
      await save(catalog);
      return replacement;
    },
    async setArmed(values, armed) {
      if (typeof armed !== "boolean") {
        throw new Error("Product armed state must be boolean.");
      }
      const catalog = await loadCatalog(filePath);
      const selected = values.map((value) =>
        resolveUniquePrefix(catalog.items, value),
      );
      const selectedIds = new Set(selected.map((item) => item.id));
      catalog.items = catalog.items.map((item) =>
        selectedIds.has(item.id)
          ? {
              ...item,
              armed: Boolean(armed),
              ...(armed && item.terminalOutcome === "confirmed"
                ? {
                    lastStatus: "Not run",
                    lastStatusAt: null,
                    terminalOutcome: null,
                  }
                : {}),
              updatedAt: now(),
            }
          : item,
      );
      await save(catalog);
      return catalog.items.filter((item) => selectedIds.has(item.id));
    },
    async remove(value) {
      const catalog = await loadCatalog(filePath);
      const existing = resolveUniquePrefix(catalog.items, value);
      catalog.items = catalog.items.filter((item) => item.id !== existing.id);
      await save(catalog);
      return existing;
    },
    async updateRuntime(ids, changes) {
      const catalog = await loadCatalog(filePath);
      const selected = new Set(ids);
      catalog.items = catalog.items.map((item) =>
        selected.has(item.id)
          ? {
            ...item,
            ...changes,
            updatedAt: now(),
          }
          : item,
      );
      await save(catalog);
      return catalog.items.filter((item) => selected.has(item.id));
    },
  };
}

module.exports = {
  catalogVersion,
  createCatalogStore,
  emptyCatalog,
  loadCatalog,
  resolveUniquePrefix,
  isPlainObject,
  validateCatalog,
  validateCatalogItems,
  writeCatalogAtomic,
};
