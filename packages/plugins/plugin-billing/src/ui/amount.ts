/** "1 234,50" / "1234.5" / "R 99" → minor units. */
export function toMinor(value: string): number {
  const minor = tryMinor(value);
  if (minor == null) throw new Error("Enter a valid amount");
  return minor;
}

/** Like `toMinor`, but null for an empty or invalid amount. Use it while rendering: `toMinor` throws. */
export function tryMinor(value: string): number | null {
  const cleaned = String(value).replace(/[^\d,.-]/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "");
  const amount = Number(cleaned);
  if (!cleaned || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}
