const amazonCartUrl = "https://www.amazon.com/gp/cart/view.html";

async function navigateToCart(page) {
  await page
    .goto(amazonCartUrl, {
      waitUntil: "commit",
      timeout: 10000,
    })
    .catch(() => {});
  if (typeof page.waitForLoadState === "function") {
    await page
      .waitForLoadState("domcontentloaded", { timeout: 10000 })
      .catch(() => {});
  }
}

async function waitForExpectedCartItemCount(
  readCount,
  timeoutMs = 8000,
  pollDelayMs = 250,
) {
  const deadline = Date.now() + timeoutMs;
  let count = await readCount();

  while (count === 0 && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollDelayMs, remainingMs)),
    );
    count = await readCount();
  }

  return count;
}

module.exports = {
  amazonCartUrl,
  navigateToCart,
  waitForExpectedCartItemCount,
};
