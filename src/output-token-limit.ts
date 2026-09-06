/** Output includes reasoning tokens. This is a request limit, not a dollar budget. */
export function isMaxOutputTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
