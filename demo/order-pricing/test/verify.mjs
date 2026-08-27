import assert from "node:assert/strict";
import test from "node:test";
import { calculateShippingFee } from "../src/shipping.mjs";

test("charges standard members below the free-shipping threshold", () => {
  assert.equal(calculateShippingFee(98.99, "standard"), 8);
});

test("gives standard members free shipping at exactly 99 yuan", () => {
  assert.equal(calculateShippingFee(99, "standard"), 0);
});

test("gives premium members free shipping at exactly 59 yuan", () => {
  assert.equal(calculateShippingFee(59, "premium"), 0);
});

test("gives premium members free shipping above 59 yuan", () => {
  assert.equal(calculateShippingFee(80, "premium"), 0);
});

test("rejects negative and non-finite subtotals", () => {
  for (const invalidSubtotal of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => calculateShippingFee(invalidSubtotal, "standard"),
      /subtotal/i,
    );
  }
});

test("rejects unknown membership levels", () => {
  assert.throws(() => calculateShippingFee(100, "student"), /membership/i);
});
