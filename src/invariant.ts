/**
 * Internal assertion helpers. Every assertion carries a context tag so the
 * failure message names the surface and not just the predicate.
 *
 * @module @dsh-contrib/dsh-record-replay/invariant
 */

const PREFIX = 'dsh-record-replay'

/** Assert a runtime invariant, naming the surface that violated it. */
export function invariant(condition: unknown, surface: string, detail: string): asserts condition {
  if (condition) return
  throw new Error(`${PREFIX}: ${surface} ${detail}`)
}

/** Assert a value is non-null; throw with a named surface. */
export function defined<T>(value: T | null | undefined, surface: string, name: string): T {
  invariant(value !== null && value !== undefined, surface, `${name} must be defined`)
  return value
}

/**
 * Convert any thrown value into a string. `Error` instances use `message`;
 * everything else uses `String()`. Always returns a non-empty string.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : '(empty Error message)'
  const s = String(error)
  return s.length > 0 ? s : '(empty thrown value)'
}
