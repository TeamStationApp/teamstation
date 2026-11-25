import { badRequest } from '../../common/errors'

/**
 * A whole-number query parameter from `least` to `most`, or undefined when
 * it is absent. Anything else, a repeated parameter among them, is 400 with
 * `refusal`, so each route keeps its own wording.
 */
export function queryInteger(
  value: unknown,
  least: number,
  most: number,
  refusal: string
): number | undefined {
  if (value == null) return undefined
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number < least || number > most)
    throw badRequest(refusal)
  return number
}
