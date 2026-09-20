const assert = require("node:assert/strict");
const test = require("node:test");

const {
  confirmAmazonDuplicateOrder,
  isAmazonDuplicateOrderWarning,
  isAmazonOrderConfirmed,
  isAmazonSignInRequired,
  isAmazonVerificationRequired,
  isUnavailableCheckoutText,
  sanitizeAmazonError,
} = require("../amazon-checkout");

test("detects unavailable checkout states that require retrying the checkout URL", () => {
  assert.equal(
    isUnavailableCheckoutText(
      "Sorry, the quantity you requested is no longer available. We updated your quantity to the maximum available.",
    ),
    true,
  );
  assert.equal(
    isUnavailableCheckoutText(
      "This Item is currently unavailable\nSorry, the item(s) you selected are not available from your selected seller(s). Please check the product page(s) for other sellers or try again later.",
    ),
    true,
  );
  assert.equal(
    isUnavailableCheckoutText(
      "Item Pikachu is no longer available from the seller you selected.",
    ),
    true,
  );
  assert.equal(
    isUnavailableCheckoutText("The items you selected are not available."),
    true,
  );
  assert.equal(isUnavailableCheckoutText("Items out of stock"), true);
});

test("does not classify a usable checkout page as unavailable", () => {
  assert.equal(
    isUnavailableCheckoutText("Review your order and place your order."),
    false,
  );
});

test("requires strong confirmation evidence and rejects generic product text", () => {
  assert.equal(
    isAmazonOrderConfirmed(
      "https://www.amazon.com/dp/B0007VO0DU",
      "A reviewer asked support for an order number.",
    ),
    false,
  );
  assert.equal(
    isAmazonOrderConfirmed(
      "https://www.amazon.com/gp/buy/thankyou/handlers/display.html",
      "Order number 123-4567890-1234567",
    ),
    true,
  );
  assert.equal(
    isAmazonOrderConfirmed(
      "https://www.amazon.com/checkout",
      "Thank you, your order has been placed.",
    ),
    true,
  );
});

test("detects Amazon CAPTCHA, MFA, and CVF verification states", () => {
  assert.equal(
    isAmazonVerificationRequired(
      "https://www.amazon.com/ap/mfa",
      "Two-Step Verification",
    ),
    true,
  );
  assert.equal(
    isAmazonVerificationRequired(
      "https://www.amazon.com/ap/cvf",
      "Enter the one-time password (OTP)",
    ),
    true,
  );
  assert.equal(
    isAmazonVerificationRequired(
      "https://www.amazon.com/errors/validateCaptcha",
      "Enter the characters you see",
    ),
    true,
  );
});

test("detects Amazon sign-in pages without matching ordinary account text", () => {
  assert.equal(
    isAmazonSignInRequired(
      "https://www.amazon.com/ap/signin",
      "Sign in with your email or mobile phone number",
    ),
    true,
  );
  assert.equal(
    isAmazonSignInRequired(
      "https://www.amazon.com/dp/B0007VO0DU",
      "Hello, customer Account & Lists",
    ),
    false,
  );
});

test("detects only explicit Amazon duplicate-order warnings", () => {
  assert.equal(
    isAmazonDuplicateOrderWarning(
      "Potential duplicate order: You recently purchased this item.",
    ),
    true,
  );
  assert.equal(
    isAmazonDuplicateOrderWarning(
      "A review says they recently purchased this item.",
    ),
    false,
  );
});

test("confirms an explicit duplicate-order warning once", async () => {
  let consentChecked = false;
  const events = [];
  const createLocator = ({
    checked = false,
    onCheck,
    onClick,
    ready = true,
  } = {}) => {
    const locator = {
      check: async () => onCheck?.(),
      click: async () => onClick?.(),
      count: async () => (ready ? 1 : 0),
      first: () => locator,
      getByRole: () => locator,
      isChecked: async () => checked || consentChecked,
      isEnabled: async () => ready,
      isVisible: async () => ready,
      locator: () => locator,
      nth: () => locator,
      or: () => locator,
    };
    return locator;
  };
  const confirmation = createLocator({
    onClick: () => {
      events.push("click");
    },
  });
  const consent = createLocator({
    onCheck: () => {
      consentChecked = true;
    },
  });
  const warning = createLocator();
  const page = {
    getByRole: (role) => (role === "button" ? confirmation : consent),
    getByText: () => warning,
    waitForTimeout: async () => {},
  };

  assert.equal(
    await confirmAmazonDuplicateOrder(
      page,
      "Duplicate order warning. You recently purchased this item.",
    ),
    false,
  );
  assert.equal(
    await confirmAmazonDuplicateOrder(
      page,
      "Duplicate order warning. You recently purchased this item.",
      {
        beforeClick: () => {
          events.push("latch");
        },
        guardsValidated: true,
        submissionAttempted: true,
      },
    ),
    true,
  );
  assert.equal(consentChecked, true);
  assert.deepEqual(events, ["latch", "click"]);
  assert.equal(
    await confirmAmazonDuplicateOrder(page, "Review your order.", {
      guardsValidated: true,
      submissionAttempted: true,
    }),
    false,
  );
});

test("latches duplicate confirmation before a dispatched click can fail", async () => {
  const events = [];
  const confirmation = {
    click: async () => {
      events.push("click");
      throw new Error("navigation interrupted");
    },
    count: async () => 1,
    first() {
      return this;
    },
    isEnabled: async () => true,
    isVisible: async () => true,
  };
  const missingConsent = {
    count: async () => 0,
    first() {
      return this;
    },
    or() {
      return this;
    },
  };
  const warning = {
    count: async () => 1,
    first() {
      return this;
    },
    isEnabled: async () => true,
    isVisible: async () => true,
  };
  const page = {
    getByRole: (role) =>
      role === "button" ? confirmation : missingConsent,
    getByText: () => warning,
  };

  await assert.rejects(
    confirmAmazonDuplicateOrder(
      page,
      "Potential duplicate order. You ordered this item recently.",
      {
        beforeClick: () => {
          events.push("latch");
        },
        guardsValidated: true,
        submissionAttempted: true,
      },
    ),
    /navigation interrupted/,
  );
  assert.deepEqual(events, ["latch", "click"]);
});

test("checks duplicate consent before testing the local confirmation button", async () => {
  let consentChecked = false;
  let confirmationClicks = 0;
  const consent = {
    check: async () => {
      consentChecked = true;
    },
    count: async () => 1,
    first() {
      return this;
    },
    isChecked: async () => consentChecked,
    isEnabled: async () => true,
    isVisible: async () => true,
    or() {
      return this;
    },
  };
  const confirmation = {
    click: async () => {
      confirmationClicks += 1;
    },
    count: async () => 1,
    first() {
      return this;
    },
    isEnabled: async () => consentChecked,
    isVisible: async () => true,
  };
  const warning = {
    count: async () => 1,
    first() {
      return this;
    },
    isEnabled: async () => true,
    isVisible: async () => true,
  };
  const page = {
    getByRole: (role) => (role === "button" ? confirmation : consent),
    getByText: () => warning,
    waitForTimeout: async () => {},
  };

  assert.equal(
    await confirmAmazonDuplicateOrder(
      page,
      "Potential duplicate order. You ordered this item recently.",
      {
        guardsValidated: true,
        submissionAttempted: true,
      },
    ),
    true,
  );
  assert.equal(consentChecked, true);
  assert.equal(confirmationClicks, 1);
});

test("redacts private checkout URLs and offer tokens from errors", () => {
  const sanitized = sanitizeAmazonError(
    new Error(
      'page.goto: navigating to "https://www.amazon.com/checkout/entry/buynow?asin=B0007VO0DU&offeringID=secret%2Btoken%3D&buyNow=1"',
    ),
  );

  assert.doesNotMatch(sanitized, /secret/);
  assert.match(sanitized, /buynow\?<redacted>/);
});
