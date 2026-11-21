/** Characters a JSON literal may carry that a page script must not hold raw. */
const UNSAFE = /[<>/\u2028\u2029]/g

/**
 * `value` as a JavaScript literal to put in a script run in the page: JSON,
 * with the characters that could end a script element or a line escaped.
 */
export function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(
    UNSAFE,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}
