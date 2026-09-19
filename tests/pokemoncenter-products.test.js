const assert = require("node:assert/strict");

const {
  isPurchaseAction,
  isTemporaryRestriction,
  normalizeProducts,
  pokemonCenterTabPolicy,
  productIdFromUrl,
  selectProducts,
  validatePokemonCenterCart,
} = require("../pokemoncenter-products");

const inputProducts = [
  {
    label: "Elite Trainer Box",
    url: "https://www.pokemoncenter.com/product/10-10447-111/pokemon-tcg-30th-celebration-pokemon-center-elite-trainer-box",
    title: "Pokémon TCG: 30th Celebration Pokémon Center Elite Trainer Box",
  },
  {
    label: "Tech Sticker - Alolan Exeggutor",
    url: "https://www.pokemoncenter.com/product/10-10449-121/pokemon-tcg-30th-celebration-tech-sticker-collection-alolan-exeggutor",
    title: "Pokémon TCG: 30th Celebration Tech Sticker Collection",
  },
  {
    label: "Tech Sticker - Alolan Exeggutor duplicate",
    url: "https://www.pokemoncenter.com/product/10-10449-121/pokemon-tcg-30th-celebration-tech-sticker-collection-alolan-exeggutor",
    title: "Pokémon TCG: 30th Celebration Tech Sticker Collection",
  },
];

const normalized = normalizeProducts(inputProducts);
assert.equal(normalized.length, 2);
assert.deepEqual(
  selectProducts(normalized, "10-10447-111").map((product) => product.sku),
  ["10-10447-111"],
);
assert.equal(selectProducts(normalized, "").length, 2);
assert.equal(pokemonCenterTabPolicy, "one-per-product");
assert.equal(
  productIdFromUrl(normalized[0].url),
  "10-10447-111",
);
assert.equal(productIdFromUrl("https://www.pokemoncenter.com/cart"), null);

assert.equal(isPurchaseAction("Add to Cart"), true);
assert.equal(isPurchaseAction("Pre-Order"), true);
assert.equal(isPurchaseAction("UNAVAILABLE"), false);
assert.equal(
  isTemporaryRestriction(
    "Access is temporarily restricted. We detected unusual activity from your device or network.",
  ),
  true,
);
assert.equal(isTemporaryRestriction("Your shopping cart is empty"), false);

assert.equal(
  validatePokemonCenterCart({
    bodyText:
      "Shopping Cart Pokémon TCG: 30th Celebration Pokémon Center Elite Trainer Box",
    hrefs: [
      "https://www.pokemoncenter.com/product/10-10447-111/example",
    ],
    product: normalized[0],
  }),
  true,
);
assert.equal(
  validatePokemonCenterCart({
    bodyText: "Your shopping cart is empty",
    hrefs: [],
    product: normalized[0],
  }),
  false,
);
assert.equal(
  validatePokemonCenterCart({
    bodyText: "Shopping Cart Unrelated product",
    hrefs: ["https://www.pokemoncenter.com/product/10-99999-999/example"],
    product: normalized[0],
  }),
  false,
);

console.log("pokemoncenter-products tests passed");
