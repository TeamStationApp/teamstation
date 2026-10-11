#!/usr/bin/env node
// An app build's deployment settings, from the app's own clientConfig.json:
//
//   node scripts/clientConfig.mjs <appDir> [--entitlements <path>]
//   node scripts/clientConfig.mjs <appDir> --team
//
// clientConfig.json is never committed. It holds what a deployment decides and
// this repository does not: the Apple team that signs the app (`appleTeamId`)
// and the link host its sign-in links open it from (`appOrigin`). Mason writes
// it for its builds; a local build gets it from the deployment repository's
// appLinks.mjs client.
//
// This writes <appDir>/clientConfig.xcconfig for xcodebuild's -xcconfig:
//
//   DEVELOPMENT_TEAM      the team
//   TS_APP_LINK_HOST      the link host, which the app's .entitlements and
//                         Info.plist name; empty without an appOrigin
//   TS_APP_ENTITLEMENTS   --entitlements, when there is an appOrigin. Otherwise
//                         the line is left out and the target's own default
//                         applies (none, or the RN app's NoAppLinks.entitlements),
//                         so a build with no link host claims no Associated
//                         Domains. Only the app target maps it to
//                         CODE_SIGN_ENTITLEMENTS: -xcconfig reaches every target.
//
// In an xcconfig `//` starts a comment, even mid-value, so the file carries a
// host and never an origin, and refuses any value with `//` in it.
//
// Without a clientConfig.json it writes an empty xcconfig and fails, so a
// build script stops before building something unsigned or unlinked.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONFIG_FILE = 'clientConfig.json'
export const XCCONFIG_FILE = 'clientConfig.xcconfig'
const TEAM = /^[A-Z0-9]{10}$/

/** The settings in a clientConfig.json, checked. */
export function asClientConfig(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('clientConfig.json must be an object')
  const out = {}
  for (const key of Object.keys(raw)) {
    if (key !== 'appOrigin' && key !== 'appleTeamId')
      throw new Error(`clientConfig.json has an unknown field ${key}`)
  }
  if (raw.appOrigin != null) {
    let url
    try {
      url = new URL(raw.appOrigin)
    } catch {
      throw new Error(`appOrigin ${raw.appOrigin} is not an origin`)
    }
    if (url.origin !== raw.appOrigin || url.protocol !== 'https:')
      throw new Error(`appOrigin ${raw.appOrigin} is not an https origin`)
    out.appOrigin = raw.appOrigin
  }
  if (raw.appleTeamId != null) {
    if (typeof raw.appleTeamId !== 'string' || !TEAM.test(raw.appleTeamId))
      throw new Error('appleTeamId is not an Apple team ID')
    out.appleTeamId = raw.appleTeamId
  }
  return out
}

/** The xcconfig text for these settings. */
export function xcconfigFor(config, entitlements) {
  const host = config.appOrigin == null ? '' : new URL(config.appOrigin).host
  const values = {
    DEVELOPMENT_TEAM: config.appleTeamId ?? '',
    TS_APP_LINK_HOST: host
  }
  if (host !== '' && entitlements != null)
    values.TS_APP_ENTITLEMENTS = entitlements
  const lines = [
    '// Written by scripts/clientConfig.mjs from clientConfig.json. Not committed.'
  ]
  for (const [name, value] of Object.entries(values)) {
    if (value.includes('//')) throw new Error(`${name} cannot contain //`)
    lines.push(`${name} = ${value}`)
  }
  return lines.join('\n') + '\n'
}

/** Reads <appDir>/clientConfig.json and writes <appDir>/clientConfig.xcconfig. */
export function writeXcconfig(appDir, entitlements) {
  const file = path.join(appDir, CONFIG_FILE)
  const out = path.join(appDir, XCCONFIG_FILE)
  if (!existsSync(file)) {
    writeFileSync(out, '')
    throw new Error(
      `clientConfig.json missing: run appLinks.mjs client <appId> ${file}`
    )
  }
  const config = asClientConfig(JSON.parse(readFileSync(file, 'utf8')))
  writeFileSync(out, xcconfigFor(config, entitlements))
  return out
}

/**
 * The team <appDir>/clientConfig.json names, checked as a build would check it;
 * empty when there is no file or it names no team. `--team` prints it, for the
 * scripts that pass a team to something other than xcodebuild.
 */
export function teamOf(appDir) {
  const file = path.join(appDir, CONFIG_FILE)
  if (!existsSync(file)) return ''
  return (
    asClientConfig(JSON.parse(readFileSync(file, 'utf8'))).appleTeamId ?? ''
  )
}

export function main(argv) {
  const args = [...argv]
  if (args.includes('--team')) {
    const [appDir, ...rest] = args.filter(arg => arg !== '--team')
    if (appDir == null || rest.length > 0)
      throw new Error('usage: clientConfig.mjs <appDir> --team')
    return teamOf(appDir)
  }
  const at = args.indexOf('--entitlements')
  let entitlements
  if (at >= 0) {
    entitlements = args[at + 1]
    if (entitlements == null) throw new Error('--entitlements needs a path')
    args.splice(at, 2)
  }
  const [appDir] = args
  if (appDir == null || args.length !== 1)
    throw new Error('usage: clientConfig.mjs <appDir> [--entitlements <path>]')
  return writeXcconfig(appDir, entitlements)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.log(main(process.argv.slice(2)))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
