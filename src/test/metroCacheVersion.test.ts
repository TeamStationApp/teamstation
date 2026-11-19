import { expect } from 'chai'
import { describe, it } from 'mocha'
import path from 'path'

const configPath = path.resolve(__dirname, '../../metro.config.js')

/** The root Metro config's cache key, read afresh under `env`. */
function cacheVersionWith(env: Record<string, string | undefined>): string {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key]
    if (env[key] == null) Reflect.deleteProperty(process.env, key)
    else process.env[key] = env[key]
  }
  try {
    Reflect.deleteProperty(require.cache, require.resolve(configPath))
    return (require(configPath) as { cacheVersion: string }).cacheVersion
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    Reflect.deleteProperty(require.cache, require.resolve(configPath))
  }
}

describe('root Metro cache key', () => {
  it('changes with the DSN Babel inlines, so a build never ships another build’s', () => {
    const api = 'https://api.example.test/api/v1'
    const none = cacheVersionWith({
      TS_API_BASE_URL: api,
      TS_SENTRY_DSN: undefined
    })
    const one = cacheVersionWith({
      TS_API_BASE_URL: api,
      TS_SENTRY_DSN: 'https://develop@api.example.test/101'
    })
    const other = cacheVersionWith({
      TS_API_BASE_URL: api,
      TS_SENTRY_DSN: 'https://develop@api.example.test/201'
    })
    expect(new Set([none, one, other]).size).equals(3)
  })
})
