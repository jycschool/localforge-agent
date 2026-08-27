const FREE_SHIPPING_THRESHOLDS = {
  standard: 99,
  premium: 59,
};

/**
 * Return the shipping fee for an order subtotal and membership level.
 *
 * This starter implementation intentionally contains boundary and validation
 * defects for the LocalForge demonstration task.
 */
export function calculateShippingFee(subtotal, membership = "standard") {
  const threshold =
    FREE_SHIPPING_THRESHOLDS[membership] ?? FREE_SHIPPING_THRESHOLDS.standard;
  return subtotal > threshold ? 0 : 8;
}
