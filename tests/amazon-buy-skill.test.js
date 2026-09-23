const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const skillPath = path.join(
  root,
  ".github",
  "skills",
  "amazon-buy",
  "SKILL.md",
);
const runnerPath = path.join(
  root,
  ".github",
  "skills",
  "amazon-buy",
  "run-amazon-buy.ps1",
);

test("amazon-buy skill declares the guarded one-product purchase workflow", () => {
  const skill = fs.readFileSync(skillPath, "utf8");

  assert.match(skill, /^---\r?\nname: amazon-buy\r?\n/m);
  assert.match(skill, /explicitly invokes `\/amazon-buy <amazon-url>`/);
  assert.match(skill, /one quantity-one order/);
  assert.match(skill, /sold by and\s+shipped from Amazon/);
  assert.match(skill, /\/checkout\/entry\/buynow/);
  assert.match(skill, /verify its offer token/);
  assert.match(skill, /Final sale/);
  assert.match(skill, /10000/);
  assert.match(skill, /shell ID `amazon-buy`/);
  assert.match(skill, /\/skills info amazon-buy/);
  assert.match(skill, /-AmazonUrl/);
  assert.match(skill, /Double any embedded apostrophes/i);
  assert.match(skill, /device-local/);
  assert.match(skill, /AMAZON_SUPPLIED_CHECKOUT_REPLACED/);
  assert.match(skill, /AMAZON_ORDER_CONFIRMATION_AMBIGUOUS/);
  assert.doesNotMatch(skill, /offeringID=[A-Za-z0-9%+/=]+/);
});

test("amazon-buy guide explains device-local setup and safe-stop states", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const amazonSection = readme
    .split(/^## Amazon direct buy and preorder\r?$/m)[1]
    ?.split(/^## Amazon multi-product monitoring\r?$/m)[0];

  assert.ok(amazonSection, "Amazon direct-buy guide must exist");
  assert.match(amazonSection, /\/skills info amazon-buy/);
  assert.match(amazonSection, /POKEMON_CHROME_USER_DATA_DIR/);
  assert.match(amazonSection, /device-local/);
  assert.match(amazonSection, /AMAZON_SUPPLIED_CHECKOUT_REPLACED/);
  assert.match(amazonSection, /AMAZON_ORDER_CONFIRMATION_AMBIGUOUS/);
  assert.match(amazonSection, /amazon:checkout/);
  assert.doesNotMatch(amazonSection, /F:\\Repos\\personal\\temp\\PokemonDeals/i);
});

test("amazon-buy runner uses the repository worker and shared safe CDP bootstrap", () => {
  const runner = fs.readFileSync(runnerPath, "utf8");
  const workerPattern =
    /(?:^|[\s\\/"])(?:amazon-preorder|amazon-checkout|amazon-multi-preorder)\.js(?:["\s]|$)/i;

  assert.match(runner, /\[decimal\]\$MaxItemPrice = 10000/);
  assert.match(runner, /\[decimal\]\$MaxOrderTotal = 10000/);
  assert.match(runner, /\$env:AMAZON_PRODUCT_URL = \$AmazonUrl/);
  assert.match(runner, /\$env:AMAZON_CHECKOUT_URL = \$AmazonUrl/);
  assert.match(runner, /\[string\]\$AmazonUrl/);
  assert.match(runner, /parseAmazonBuyUrl/);
  assert.match(runner, /require\("\.\/src\/chrome-cdp"\)/);
  assert.match(runner, /ensureChromeCdp/);
  assert.doesNotMatch(runner, /Google\\Chrome\\User Data/);
  assert.doesNotMatch(runner, /CloseMainWindow/);
  assert.doesNotMatch(runner, /Stop-Process/);
  assert.match(runner, /Local\\PokemonDealsAmazonBuy/);
  assert.match(runner, /\$mutex\.WaitOne\(0\)/);
  assert.match(runner, /\$mutex\.ReleaseMutex\(\)/);
  assert.match(runner, /AMAZON_RUN_LOG_PATH/);
  assert.match(runner, /Write-AmazonRunEvent/);
  assert.match(runner, /AMAZON_WORKER_EXIT/);
  assert.match(runner, /npm run amazon:direct-buy/);
  assert.doesNotMatch(runner, /npm run amazon:checkout/);
  assert.match(runner, /A competing Amazon purchase worker is already running/);
  assert.doesNotMatch(runner, /Stop-Process -Name/);
  assert.doesNotMatch(runner, /AMAZON_BUY_STOPPING_COMPETING_WORKER/);
  assert.match(
    '"C:\\Program Files\\nodejs\\node.exe" amazon-preorder.js',
    workerPattern,
  );
});
