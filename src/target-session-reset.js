const { chromium } = require("playwright-core");

function isTargetDomain(domain) {
  return /(?:^|\.)target\.com$/i.test(String(domain || ""));
}

async function clearTargetContextSession(context) {
  if (!context) {
    throw new Error("No browser context available for Target session reset.");
  }
  const cookies = await context.cookies();
  const targetCookies = cookies.filter((cookie) =>
    isTargetDomain(cookie.domain),
  );
  for (const cookie of targetCookies) {
    await context.clearCookies({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
    });
  }

  let clearedStoragePages = 0;
  for (const page of context.pages()) {
    if (!/^https:\/\/(?:www\.)?target\.com(?:[/:?#]|$)/i.test(page.url())) {
      continue;
    }
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }).catch(() => {});
    clearedStoragePages += 1;
  }
  return {
    clearedCookies: targetCookies.length,
    clearedStoragePages,
  };
}

async function clearTargetSession({
  endpoint = "http://127.0.0.1:9444",
} = {}) {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
  try {
    return await clearTargetContextSession(browser.contexts()[0]);
  } finally {
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  clearTargetSession()
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  clearTargetContextSession,
  clearTargetSession,
  isTargetDomain,
};
