const assert = require("node:assert/strict");
const test = require("node:test");
const {
  chromeLaunchArguments,
  ensureChromeCdp,
} = require("../src/chrome-cdp");

test("existing CDP prevents an automatic Chrome launch", async () => {
  let launches = 0;
  const result = await ensureChromeCdp({
    requestVersion: async () => true,
    spawnImpl: () => {
      launches += 1;
      return { unref() {} };
    },
  });
  assert.deepEqual(result, { available: true, started: false });
  assert.equal(launches, 0);
});

test("missing CDP launches Chrome with the configured profile", async () => {
  let checks = 0;
  let launch = null;
  const result = await ensureChromeCdp({
    endpoint: "http://127.0.0.1:9444",
    env: {
      POKEMON_CHROME_PATH: "C:\\Chrome\\chrome.exe",
      POKEMON_CHROME_USER_DATA_DIR: "C:\\Users\\test\\Chrome User Data",
      POKEMON_CHROME_PROFILE_DIRECTORY: "Profile 2",
    },
    access: async () => {},
    mkdir: async () => {},
    requestVersion: async () => {
      checks += 1;
      return checks > 1;
    },
    sleep: async () => {},
    spawnImpl: (...args) => {
      launch = args;
      return { unref() {} };
    },
    startupTimeoutMs: 100,
    pollIntervalMs: 0,
  });
  assert.equal(result.started, true);
  assert.deepEqual(launch, [
    "C:\\Chrome\\chrome.exe",
    chromeLaunchArguments({
      userDataDir: "C:\\Users\\test\\Chrome User Data",
      profileDirectory: "Profile 2",
      port: "9444",
    }),
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  ]);
});

test("default Chrome bootstrap uses a non-default PokemonDeals profile", async () => {
  let launch = null;
  let checks = 0;
  await ensureChromeCdp({
    env: {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      POKEMON_CHROME_PATH: "C:\\Chrome\\chrome.exe",
    },
    access: async () => {},
    mkdir: async () => {},
    requestVersion: async () => {
      checks += 1;
      return checks > 1;
    },
    sleep: async () => {},
    spawnImpl: (...args) => {
      launch = args;
      return { unref() {} };
    },
    startupTimeoutMs: 100,
    pollIntervalMs: 0,
  });
  assert.match(
    launch[1][0],
    /^--user-data-dir=C:\\Users\\test\\AppData\\Local\\PokemonDeals\\Chrome User Data$/,
  );
});

test("a prior failed launch does not spawn duplicate Chrome processes", async () => {
  let launches = 0;
  await assert.rejects(
    ensureChromeCdp({
      state: { launchAttempted: true },
      requestVersion: async () => false,
      sleep: async () => {},
      startupTimeoutMs: 0,
      spawnImpl: () => {
        launches += 1;
        return { unref() {} };
      },
    }),
    /automatic Chrome launch was already attempted/i,
  );
  assert.equal(launches, 0);
});
