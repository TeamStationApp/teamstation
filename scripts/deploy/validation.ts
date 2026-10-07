import { asObject, asString, type Cleaner } from 'cleaners'

export function object<T extends Record<string, unknown>>(fields: {
  [K in keyof T]: Cleaner<T[K]>
}): Cleaner<T> {
  const clean = asObject(fields)
  return value => {
    if (value == null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected object')
    for (const key of Object.keys(value)) {
      if (
        !Object.hasOwn(fields, key) ||
        ['__proto__', 'prototype', 'constructor'].includes(key)
      )
        throw new Error('Unknown configuration field')
    }
    return clean(value)
  }
}
export const text =
  (max = 4096): Cleaner<string> =>
  value => {
    const out = asString(value)
    if (
      out.length === 0 ||
      out.length > max ||
      Array.from(out).some(
        char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
      throw new Error('Invalid text')
    return out
  }
export const integer =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Cleaner<number> =>
  value => {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error('Invalid integer')
    return value
  }
export function record<T>(clean: Cleaner<T>): Cleaner<Record<string, T>> {
  return value => {
    if (value == null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected map')
    const out: Record<string, T> = Object.create(null)
    if (Object.keys(value).length > 1000)
      throw new Error('Configuration map too large')
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Invalid key')
      out[text(256)(key)] = clean(item)
    }
    return out
  }
}
export const httpsOrigin: Cleaner<string> = value => {
  const url = new URL(text()(value))
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error('Expected HTTPS origin')
  return url.origin
}
export const platform: Cleaner<'ios' | 'android' | 'macos'> = value => {
  if (value !== 'ios' && value !== 'android' && value !== 'macos')
    throw new Error('Unsupported build platform')
  return value
}
export type Platform = ReturnType<typeof platform>
export const appId: Cleaner<string> = value => {
  const out = text(160)(value)
  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(out))
    throw new Error('Invalid app identifier')
  return out
}
export const branchName: Cleaner<string> = value => {
  const out = text(256)(value)
  if (
    out.startsWith('-') ||
    out.startsWith('/') ||
    out.endsWith('/') ||
    out.endsWith('.') ||
    /[ ~^:?*[\\]/.test(out) ||
    out.includes('..') ||
    out.includes('@{') ||
    out.includes('//') ||
    out
      .split('/')
      .some(part => part.startsWith('.') || part.endsWith('.lock')) ||
    out === '@'
  )
    throw new Error('Invalid source branch')
  return out
}
export const sha: Cleaner<string> = value => {
  const out = text(64)(value)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(out))
    throw new Error('Invalid commit')
  return out
}
