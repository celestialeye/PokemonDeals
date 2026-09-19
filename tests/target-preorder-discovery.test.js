const assert = require("node:assert/strict");

const {
  normalizeProductUrl,
  selectPreorderCandidates,
} = require("../target-preorder-discovery");

assert.equal(
  normalizeProductUrl("/p/example/-/A-1010669520?preselect=1"),
  "https://www.target.com/p/-/A-1010669520",
);
assert.equal(
  normalizeProductUrl("https://www.target.com/p/-/A-1012494366#lnk=sametab"),
  "https://www.target.com/p/-/A-1012494366",
);
assert.equal(normalizeProductUrl("https://www.target.com/c/toys/-/N-5xtb0"), null);

assert.deepEqual(
  selectPreorderCandidates([
    {
      href: "/p/example/-/A-1010669520",
      text: "Pokémon Perfect Order — Preorder now",
    },
    {
      href: "/p/example/-/A-1010669520?ref=tgt_adv_xsp",
      text: "Pre-order Pokémon Perfect Order",
    },
    {
      href: "/p/available/-/A-1007918679",
      text: "Add to cart",
    },
  ]),
  [
    {
      url: "https://www.target.com/p/-/A-1010669520",
      label: "Pokémon Perfect Order — Preorder now",
    },
  ],
);

console.log("target preorder discovery tests passed");
