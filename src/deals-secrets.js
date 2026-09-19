const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const secretStoreVersion = 1;

function emptySecrets() {
  return {
    version: secretStoreVersion,
    secrets: {
      target: {
        pin: null,
      },
      discord: {
        webhookUrl: null,
      },
    },
  };
}

function normalizeSecretKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, "");
  const aliases = {
    "target.pin": "target.pin",
    "discord.webhookurl": "discord.webhookUrl",
  };
  const key = aliases[normalized];
  if (!key) {
    throw new Error(
      "Secret key must be target.pin or discord.webhook-url.",
    );
  }
  return key;
}

function validateSecretValue(key, value) {
  const secret = String(value || "");
  if (!secret || secret.length > 8192 || /[^\x20-\x7e]/.test(secret)) {
    throw new Error(`${key} must be a non-empty single-line value.`);
  }
  if (key === "discord.webhookUrl" &&
      !/^https:\/\/(?:discord(?:app)?\.com|discord\.com)\/api\/webhooks\//i.test(
        secret,
      )) {
    throw new Error("discord.webhook-url must be a Discord HTTPS webhook URL.");
  }
  return secret;
}

function validateSecretDocument(document) {
  if (
    !document ||
    document.version !== secretStoreVersion ||
    !document.secrets ||
    typeof document.secrets !== "object"
  ) {
    throw new Error(
      `Unsupported local secret store. Expected version ${secretStoreVersion}.`,
    );
  }
  const targetPin = document.secrets.target?.pin ?? null;
  const webhookUrl = document.secrets.discord?.webhookUrl ?? null;
  return {
    version: secretStoreVersion,
    secrets: {
      target: {
        pin: targetPin === null
          ? null
          : validateSecretValue("target.pin", targetPin),
      },
      discord: {
        webhookUrl: webhookUrl === null
          ? null
          : validateSecretValue("discord.webhookUrl", webhookUrl),
      },
    },
  };
}

async function loadSecretDocument(filePath) {
  try {
    return validateSecretDocument(
      JSON.parse(await fs.readFile(filePath, "utf8")),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptySecrets();
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Local secret store is not valid JSON: ${filePath}`);
    }
    throw error;
  }
}

async function writeSecretDocumentAtomic(filePath, document) {
  const validated = validateSecretDocument(document);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
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

function setNestedSecret(document, key, value) {
  if (key === "target.pin") {
    document.secrets.target.pin = value;
  } else {
    document.secrets.discord.webhookUrl = value;
  }
}

function createSecretStore(filePath) {
  return {
    filePath,
    async getAll() {
      return (await loadSecretDocument(filePath)).secrets;
    },
    async set(key, value) {
      const normalizedKey = normalizeSecretKey(key);
      const document = await loadSecretDocument(filePath);
      setNestedSecret(
        document,
        normalizedKey,
        validateSecretValue(normalizedKey, value),
      );
      await writeSecretDocumentAtomic(filePath, document);
      return normalizedKey;
    },
    async clear(key) {
      const normalizedKey = normalizeSecretKey(key);
      const document = await loadSecretDocument(filePath);
      setNestedSecret(document, normalizedKey, null);
      await writeSecretDocumentAtomic(filePath, document);
      return normalizedKey;
    },
  };
}

function secretRows(secrets, env = process.env, { reveal = false } = {}) {
  const definitions = [
    {
      key: "target.pin",
      value: secrets?.target?.pin || null,
      environmentName: "TARGET_PIN",
      requirement: "required only if Target prompts",
    },
    {
      key: "discord.webhook-url",
      value: secrets?.discord?.webhookUrl || null,
      environmentName: "DISCORD_WEBHOOK_URL",
      requirement: "required for active runs",
    },
  ];
  return definitions.map((definition) => ({
    key: definition.key,
    storedValue: reveal
      ? definition.value || "(not set)"
      : definition.value
        ? "********"
        : "(not set)",
    environmentOverridePresent: Boolean(
      String(env[definition.environmentName] || "").trim(),
    ),
    requirement: definition.requirement,
  }));
}

function applyStoredSecretsToEnvironment(inputEnv, secrets) {
  const env = { ...inputEnv };
  if (!String(env.TARGET_PIN || "").trim() && secrets?.target?.pin) {
    env.TARGET_PIN = secrets.target.pin;
  }
  if (
    !String(env.DISCORD_WEBHOOK_URL || "").trim() &&
    secrets?.discord?.webhookUrl
  ) {
    env.DISCORD_WEBHOOK_URL = secrets.discord.webhookUrl;
  }
  return env;
}

module.exports = {
  applyStoredSecretsToEnvironment,
  createSecretStore,
  emptySecrets,
  loadSecretDocument,
  normalizeSecretKey,
  secretRows,
  secretStoreVersion,
  validateSecretValue,
  writeSecretDocumentAtomic,
};
