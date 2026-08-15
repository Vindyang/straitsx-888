/** XSGD is 6 decimals on both chains — never assume 18 (docs/conventions.md §5). */
const XSGD_DECIMALS = 6;

export function formatXsgd(baseUnits: string): string {
  const value = BigInt(baseUnits);
  const divisor = 10n ** BigInt(XSGD_DECIMALS);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(XSGD_DECIMALS, "0");
  return `${whole}.${frac}`;
}

export function sgdToBaseUnits(sgd: string): string {
  const [whole = "0", frac = ""] = sgd.split(".");
  const paddedFrac = (frac + "0".repeat(XSGD_DECIMALS)).slice(0, XSGD_DECIMALS);
  return (BigInt(whole || "0") * 10n ** BigInt(XSGD_DECIMALS) + BigInt(paddedFrac || "0")).toString();
}

export function shortHex(hex: string, chars = 6): string {
  if (hex.length <= chars * 2 + 2) return hex;
  return `${hex.slice(0, chars + 2)}…${hex.slice(-chars)}`;
}
