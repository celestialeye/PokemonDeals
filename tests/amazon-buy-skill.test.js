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
  assert.match(skill, /explicitly invokes `\/amazon-buy <product-url>`/);
  assert.match(skill, /one quantity-one order/);
  assert.match(skill, /sold by and\s+shipped from Amazon/);
  assert.match(skill, /Final sale/);
  assert.match(skill, /10000/);
  assert.match(skill, /shell ID `amazon-buy`/);
  assert.doesNotMatch(skill, /offeringID=[A-Za-z0-9%+/=]+/);
});

test("amazon-buy runner uses the repository worker and documented CDP profile", () => {
  const runner = fs.readFileSync(runnerPath, "utf8");
  const workerPattern =
    /(?:^|[\s\\/"])(?:amazon-preorder|amazon-checkout|amazon-multi-preorder)\.js(?:["\s]|$)/i;

  assert.match(runner, /\[decimal\]\$MaxItemPrice = 10000/);
  assert.match(runner, /\[decimal\]\$MaxOrderTotal = 10000/);
  assert.match(runner, /\$env:AMAZON_PRODUCT_URL = \$ProductUrl/);
  assert.match(runner, /parseAmazonProductUrl/);
  assert.match(runner, /127\.0\.0\.1:9444\/json\/version/);
  assert.match(runner, /Google\\Chrome\\User Data/);
  assert.match(runner, /--profile-directory=Default/);
  assert.match(runner, /ProcessStartInfo/);
  assert.match(runner, /ArgumentList\.Add/);
  assert.match(runner, /CloseMainWindow/);
  assert.match(runner, /Stop-Process -Id \$browserPid/);
  assert.match(runner, /Local\\PokemonDealsAmazonBuy/);
  assert.match(runner, /\$mutex\.WaitOne\(0\)/);
  assert.match(runner, /\$mutex\.ReleaseMutex\(\)/);
  assert.match(runner, /AMAZON_RUN_LOG_PATH/);
  assert.match(runner, /Write-AmazonRunEvent/);
  assert.match(runner, /AMAZON_WORKER_EXIT/);
  assert.match(runner, /npm run amazon:direct-buy/);
  assert.match(runner, /A competing Amazon purchase worker is already running/);
  assert.doesNotMatch(runner, /Stop-Process -Name/);
  assert.doesNotMatch(runner, /AMAZON_BUY_STOPPING_COMPETING_WORKER/);
  assert.match(
    '"C:\\Program Files\\nodejs\\node.exe" amazon-preorder.js',
    workerPattern,
  );
});
