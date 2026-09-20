const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");

const defaultEndpoint = "http://127.0.0.1:9444";
const defaultStartupTimeoutMs = 15000;
const defaultPollIntervalMs = 500;

function retryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requestCdpVersion(endpoint = defaultEndpoint, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(`${endpoint}/json/version`, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    request.once("error", () => resolve(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForCdp({
  endpoint = defaultEndpoint,
  timeoutMs = defaultStartupTimeoutMs,
  pollIntervalMs = defaultPollIntervalMs,
  requestVersion = requestCdpVersion,
  sleep = wait,
} = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (await requestVersion(endpoint)) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

function defaultUserDataDir(env) {
  return env.POKEMON_CHROME_USER_DATA_DIR ||
    path.join(
      env.LOCALAPPDATA || os.homedir(),
      "PokemonDeals",
      "Chrome User Data",
    );
}

function chromeExecutableCandidates(env) {
  return [
    env.POKEMON_CHROME_PATH,
    env.CHROME_PATH,
    env.ProgramFiles &&
      path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env["ProgramFiles(x86)"] &&
      path.join(
        env["ProgramFiles(x86)"],
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    env.LOCALAPPDATA &&
      path.join(
        env.LOCALAPPDATA,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
  ].filter(Boolean);
}

async function findChromeExecutable({
  env = process.env,
  access = fs.access,
} = {}) {
  for (const candidate of chromeExecutableCandidates(env)) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      continue;
    }
  }
  throw new Error(
    "Chrome was not found. Set POKEMON_CHROME_PATH to chrome.exe.",
  );
}

function chromeLaunchArguments({
  userDataDir,
  profileDirectory = "Default",
  port = 9444,
} = {}) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "--restore-last-session",
  ];
}

async function ensureChromeCdp({
  endpoint = defaultEndpoint,
  env = process.env,
  state = {},
  spawnImpl = defaultSpawn,
  requestVersion = requestCdpVersion,
  sleep = wait,
  access = fs.access,
  mkdir = fs.mkdir,
  startupTimeoutMs = defaultStartupTimeoutMs,
  pollIntervalMs = defaultPollIntervalMs,
} = {}) {
  if (await requestVersion(endpoint)) {
    return { available: true, started: false };
  }

  if (state.launchAttempted) {
    if (state.launchProcessExited) {
      state.launchAttempted = false;
      state.launchProcess = null;
      state.launchProcessExited = false;
    }
  }

  if (state.launchAttempted) {
    const available = await waitForCdp({
      endpoint,
      timeoutMs: Math.min(startupTimeoutMs, 2000),
      pollIntervalMs,
      requestVersion,
      sleep,
    });
    if (available) {
      return { available: true, started: false };
    }
    throw retryableError(
      `Chrome CDP is unavailable at ${endpoint}. ` +
      "The automatic Chrome launch was already attempted; close Chrome " +
      "and restart it with the configured profile if it is still running.",
    );
  }

  const executable = await findChromeExecutable({ env, access });
  const userDataDir = defaultUserDataDir(env);
  const profileDirectory = env.POKEMON_CHROME_PROFILE_DIRECTORY || "Default";
  const port = new URL(endpoint).port || "9444";
  const args = chromeLaunchArguments({
    userDataDir,
    profileDirectory,
    port,
  });

  await mkdir(userDataDir, { recursive: true });
  state.launchAttempted = true;
  try {
    const child = spawnImpl(executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    state.launchProcess = child;
    state.launchProcessExited = false;
    const markLaunchExited = () => {
      state.launchProcessExited = true;
      state.launchAttempted = false;
      state.launchProcess = null;
    };
    child.once?.("close", markLaunchExited);
    child.once?.("error", markLaunchExited);
    child.once?.("exit", markLaunchExited);
    child.unref?.();
  } catch (error) {
    state.launchAttempted = false;
    throw retryableError(`Could not start Chrome: ${error.message}`);
  }

  if (
    !(await waitForCdp({
      endpoint,
      timeoutMs: startupTimeoutMs,
      pollIntervalMs,
      requestVersion,
      sleep,
    }))
  ) {
    throw retryableError(
      `Chrome started but CDP did not become available at ${endpoint}. ` +
      "If another Chrome process already owns this profile, close it and " +
      "restart the TUI.",
    );
  }
  return {
    available: true,
    started: true,
    executable,
    userDataDir,
    profileDirectory,
  };
}

module.exports = {
  chromeLaunchArguments,
  defaultEndpoint,
  ensureChromeCdp,
  findChromeExecutable,
  requestCdpVersion,
  waitForCdp,
};
