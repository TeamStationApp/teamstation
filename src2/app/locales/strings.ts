import { enUs, type StringKey } from './en_US'

/**
 * `lstrings` is what screens read, and `selectLocale` is what start-up calls,
 * following edge-react-gui: the English master is the base, and a chosen
 * language is merged over it so anything untranslated stays readable instead
 * of showing a key.
 */
export const lstrings: Record<StringKey, string> = { ...enUs }

const known = new Set(Object.keys(enUs))

export type LocaleFile = Record<string, string>

/**
 * Merges a language over the English master. Keys the master does not have are
 * ignored: a stale translation file should not be able to introduce a string
 * no screen asks for, nor quietly keep one alive after it is deleted.
 */
export function selectLocale(strings: LocaleFile | undefined): void {
  for (const key of Object.keys(enUs) as StringKey[]) {
    lstrings[key] = enUs[key]
  }
  if (strings == null) return
  for (const [key, value] of Object.entries(strings)) {
    if (!known.has(key)) continue
    if (typeof value !== 'string' || value === '') continue
    lstrings[key as StringKey] = value
  }
}

/** Fills the `%s` placeholders in a string, left to right. */
export function sprintf(
  template: string,
  ...values: Array<string | number | null | undefined>
): string {
  let index = 0
  return template.replace(/%s/g, () => {
    const value = values[index++]
    return value == null ? '' : String(value)
  })
}

/**
 * Picks the singular or the plural form. English only needs two, but going
 * through a helper means a language that needs more is a change here rather
 * than in every screen that counts something.
 */
export function plural(count: number, one: string, other: string): string {
  return count === 1 ? sprintf(one, count) : sprintf(other, count)
}
