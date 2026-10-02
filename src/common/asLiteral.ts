import { asValue, type Cleaner } from 'cleaners'

/**
 * `asValue`, typed as the values it allows wherever it is written.
 *
 * `cleaners` infers `asValue('top', 'bottom')` as `'top' | 'bottom'` on its
 * own, but as `string` inside an `asObject` shape, which is where nearly all
 * of them are. The `const` type parameter keeps the literals in both places.
 */
export function asLiteral<
  const T extends ReadonlyArray<string | number | boolean | null>
>(...values: T): Cleaner<T[number]> {
  return asValue(...values)
}
