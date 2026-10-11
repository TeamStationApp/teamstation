import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * What the sign-in link e2e tests share: the mailed link, a link naming another server, and an
 * Android app's claim on its link host.
 */

/**
 * The link host the app under test was built with: `appOrigin` in its gitignored
 * clientConfig.json, the file its build read.
 */
export function appLinkHost(clientConfigFile: string): string {
  const config = JSON.parse(readFileSync(clientConfigFile, 'utf8')) as { appOrigin?: string }
  if (config.appOrigin == null) throw new Error(`${clientConfigFile} names no appOrigin`)
  return new URL(config.appOrigin).host
}

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

/**
 * Runs `SEAT_MAIL_LINK`, a command that reads the test address's mail: `newest <email>` prints
 * the newest sign-in mail's id (empty for none), `after <email> <id>` waits for a newer one and
 * prints its link. Its last word is the answer.
 */
export function seatMail(...args: string[]): string {
  const [file, ...rest] = required('SEAT_MAIL_LINK').split(' ')
  return execFileSync(file, [...rest, ...args], { encoding: 'utf8' }).trim()
}

/** The newest sign-in mail's id, to wait past. */
export function newestMail(email: string): string {
  const id = seatMail('newest', email)
  return id === '' ? 'none' : id
}

/** The link in the first sign-in mail newer than `before`: `<appOrigin>/signin/<token>?server=…`. */
export function mailedLink(email: string, before: string, appHost: string): string {
  const link = seatMail('after', email, before)
  const url = new URL(link)
  if (url.host !== appHost || !/^\/signin\/[A-Za-z0-9_-]+$/.test(url.pathname) || !url.searchParams.has('server')) {
    throw new Error(`the mailed link is not ${appHost}'s sign-in link: ${url.host}${url.pathname}`)
  }
  console.log(`link host ${url.host}, server ${url.searchParams.get('server')}`)
  return link
}

/** The same host with another server named and a token nobody issued: never spent. */
export function otherServersLink(link: string): string {
  const url = new URL(link)
  url.pathname = '/signin/e2eWrongServerToken0123456789abcdefghij'
  url.searchParams.set('server', 'https://other.example.test')
  return url.toString()
}

function adb(serial: string, ...args: string[]): string {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' })
}

/**
 * Makes sure Android hands `host` to `packageName`. A Mason-signed build verifies against the
 * host's assetlinks.json, and must come back `verified`. A locally signed build cannot (its key
 * is not in assetlinks.json); with `APP_LINKS_USER_SELECTION=1` it is approved for the host by
 * user selection instead, the same as a person choosing it in Settings.
 */
export function claimAppLinks(serial: string, packageName: string, host: string): void {
  if (process.env.APP_LINKS_USER_SELECTION === '1') {
    adb(serial, 'shell', 'pm', 'set-app-links-user-selection', '--user', 'cur', '--package', packageName, 'true', host)
    console.log(adb(serial, 'shell', 'pm', 'get-app-links', '--user', 'cur', packageName).trim())
    return
  }
  adb(serial, 'shell', 'pm', 'verify-app-links', '--re-verify', packageName)
  for (let i = 0; i < 30; i++) {
    const state = adb(serial, 'shell', 'pm', 'get-app-links', packageName)
    if (new RegExp(`${host.replace(/\./g, '\\.')}: verified`).test(state)) {
      console.log(state.trim())
      return
    }
    execFileSync('sleep', ['2'])
  }
  throw new Error(`${packageName} is not verified for ${host}: is it Mason-signed?`)
}
