import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { asArray, asBoolean, asOptional, type Cleaner } from 'cleaners'

import {
  appId,
  branchName,
  httpsOrigin,
  integer,
  object,
  record,
  text
} from './validation'

const asUpload = object({
  kind: (value: unknown): 'mason' | 'zealot' => {
    if (value !== 'mason' && value !== 'zealot')
      throw new Error('Unknown upload service')
    return value
  },
  origin: httpsOrigin,
  tokenFile: text(),
  channelKey: text(256)
})
const asAndroid = object({
  keystore: text(),
  alias: text(256),
  storePassword: text(),
  keyPassword: text(),
  certificateSha256: (value: unknown): string => {
    const out = text(64)(value).toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(out))
      throw new Error('Invalid signing fingerprint')
    return out
  }
})
const asApple = object({
  teamId: text(32),
  identity: text(256),
  profileNames: record(text(256)),
  architectures: asArray(text(32)),
  requiredDevices: asOptional(asArray(text(128)), []),
  notarizationProfile: asOptional(text(256))
})
const asPlatform = object({
  upload: asUpload,
  seedBuildNumber: integer(1, 2100000000),
  android: asOptional(asAndroid),
  apple: asOptional(asApple)
})
const asApp = object({
  repository: asOptional(text()),
  apiOrigin: asOptional(httpsOrigin),
  version: text(80),
  ios: asOptional(asPlatform),
  android: asOptional(asPlatform),
  macos: asOptional(asPlatform)
})
const asTools = object({
  git: asOptional(text(), 'git'),
  gh: asOptional(text(), 'gh'),
  node: asOptional(text(), process.execPath),
  npm: asOptional(text(), 'npm'),
  socket: asOptional(text(), 'socket'),
  caffeinate: asOptional(text(), 'caffeinate'),
  xcodebuild: asOptional(text(), 'xcodebuild'),
  xcodegen: asOptional(text(), 'xcodegen'),
  bundle: asOptional(text(), 'bundle'),
  pod: asOptional(text(), 'pod'),
  security: asOptional(text(), 'security'),
  codesign: asOptional(text(), 'codesign'),
  xcrun: asOptional(text(), 'xcrun'),
  hdiutil: asOptional(text(), 'hdiutil'),
  apksigner: asOptional(text()),
  aapt: asOptional(text())
})
const asMatch = object({
  repository: text(),
  branch: branchName,
  password: text(),
  apiKeyFile: asOptional(text()),
  appleLoginFile: asOptional(text()),
  checkout: asOptional(text()),
  keychainPassword: text(),
  gitPrivateKey: asOptional(text()),
  imports: asOptional(
    record(
      object({
        certificate: text(),
        privateKey: text(),
        profile: asOptional(text())
      })
    ),
    {}
  )
})
export const asAppleLogin = object({
  username: text(254),
  password: text(4096),
  cookieDirectory: text()
})
export const asSettings = object({
  repository: text(),
  stateDirectory: text(),
  worktreeDirectory: text(),
  outputDirectory: text(),
  tools: asOptional(asTools, () => asTools({})),
  inhibitSleep: asOptional(asBoolean, true),
  match: asOptional(asMatch),
  apps: record(asApp)
})
export type Settings = ReturnType<typeof asSettings>
export type Upload = ReturnType<typeof asUpload>

function clone(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error('Configuration nesting too deep')
  if (value === null)
    throw new Error('Null deployment settings are unsupported')
  if (Array.isArray(value)) return value.map(item => clone(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Invalid configuration key')
      out[key] = clone(item, depth + 1)
    }
    return out
  }
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value
  throw new Error('Invalid configuration value')
}
export function merge(base: unknown, override: unknown): unknown {
  if (
    base != null &&
    override != null &&
    typeof base === 'object' &&
    typeof override === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(override)
  ) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override))
      out[key] = merge(out[key], value)
    return out
  }
  return clone(override)
}
const asBranch = object({
  extends: asOptional(branchName),
  settings: (value: unknown): unknown => clone(value)
})
const asConfig = object({
  schemaVersion: (value: unknown): number => {
    if (value !== 1) throw new Error('Unsupported deploy config version')
    return value
  },
  branches: record(asBranch)
})
export function resolveSettings(value: unknown, branch: string): Settings {
  branchName(branch)
  const config = asConfig(value)
  if (config.branches.master == null || config.branches.master.extends != null)
    throw new Error('Master settings are required and cannot inherit')
  const resolved = new Map<string, unknown>()
  const visiting = new Set<string>()
  function visit(name: string): unknown {
    if (resolved.has(name)) return resolved.get(name)
    const entry = config.branches[name]
    if (entry == null || visiting.has(name))
      throw new Error('Missing or cyclic branch settings')
    visiting.add(name)
    const settings =
      name === 'master'
        ? entry.settings
        : merge(visit(entry.extends ?? 'master'), entry.settings)
    asSettings(settings)
    visiting.delete(name)
    resolved.set(name, settings)
    return settings
  }
  // Validate unused branches too so a typo cannot remain latent until release day.
  for (const name of Object.keys(config.branches)) {
    branchName(name)
    visit(name)
  }
  const settings = asSettings(
    visit(config.branches[branch] == null ? 'master' : branch)
  )
  for (const id of Object.keys(settings.apps)) appId(id)
  return settings
}
export function privateJson<T>(file: string, cleaner: Cleaner<T>): T {
  try {
    const actual = realpathSync(file)
    const stat = statSync(actual)
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid != null && stat.uid !== process.getuid()) ||
      stat.size > 1024 * 1024
    )
      throw new Error('Insecure configuration')
    return cleaner(JSON.parse(readFileSync(actual, 'utf8')))
  } catch {
    throw new Error('Invalid or insecure deployment configuration')
  }
}
export function loadSettings(file: string, branch: string): Settings {
  const actual = realpathSync(file)
  const base = path.dirname(actual)
  const out = privateJson(actual, value => resolveSettings(value, branch))
  const resolve = (value: string): string => path.resolve(base, value)
  out.repository = resolve(out.repository)
  out.stateDirectory = resolve(out.stateDirectory)
  out.worktreeDirectory = resolve(out.worktreeDirectory)
  out.outputDirectory = resolve(out.outputDirectory)
  for (const app of Object.values(out.apps)) {
    if (app.repository != null) app.repository = resolve(app.repository)
    for (const platform of [app.ios, app.android, app.macos]) {
      if (platform == null) continue
      platform.upload.tokenFile = resolve(platform.upload.tokenFile)
      if (platform.android != null)
        platform.android.keystore = resolve(platform.android.keystore)
    }
  }
  if (out.match != null) {
    if (out.match.apiKeyFile != null)
      out.match.apiKeyFile = resolve(out.match.apiKeyFile)
    if (out.match.appleLoginFile != null)
      out.match.appleLoginFile = resolve(out.match.appleLoginFile)
    if (out.match.checkout != null)
      out.match.checkout = resolve(out.match.checkout)
    if (out.match.gitPrivateKey != null)
      out.match.gitPrivateKey = resolve(out.match.gitPrivateKey)
    for (const entry of Object.values(out.match.imports)) {
      entry.certificate = resolve(entry.certificate)
      entry.privateKey = resolve(entry.privateKey)
      if (entry.profile != null) entry.profile = resolve(entry.profile)
    }
  }
  for (const key of Object.keys(out.tools) as Array<keyof Settings['tools']>) {
    const tool = out.tools[key]
    if (tool?.includes('/') === true) out.tools[key] = resolve(tool)
  }
  return out
}
