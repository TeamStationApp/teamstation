import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

import { maestroBin, maestroClient, type MaestroDevice } from '../../../test/maestroD'

/**
 * Director signs in from the link in its sign-in e-mail.
 *
 * Install a build whose clientConfig.json names Director's link host, signed so
 * its Associated Domains are in it (`SIM_SIGNING=YES` for a simulator), and
 * pointed at the seat:
 *
 *   TS_PRIMARY_HOST=<SEAT_HOST> SIM_SIGNING=YES ./scripts/build-sim.sh   (or build-device.sh)
 *
 * Then:
 *
 *   MAESTRO_D=sign-in-link-director \
 *   DIRECTOR_DEVICE_UDID=<udid> \
 *   TS_E2E_EMAIL=<an address whose mail the command below can read> \
 *   SEAT_MAIL_LINK=<command: `newest <email>` prints the newest sign-in mail's id,
 *                   `after <email> <id>` waits for a newer one and prints its link> \
 *   E2E_ARTIFACT_DIR=<where the screenshots go> \
 *     node -r sucrase/register mobile/apps/tsDirector/e2e/signInLink.e2e.ts
 *
 * The operating system hands the link to Director, which signs in with it and
 * says so; then a link naming another server is refused without being spent.
 */

const APP_ID = 'app.teamstation.director'

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

/** Runs the mail command. Its last word is the answer. */
function mail(...args: string[]): string {
  const [file, ...rest] = required('SEAT_MAIL_LINK').split(' ')
  return execFileSync(file, [...rest, ...args], { encoding: 'utf8' }).trim()
}

type Device = MaestroDevice & { shot: (name: string) => Promise<void> }

/** Director on the named device, through this run's own daemon, as an iOS app. */
async function attach(daemon: string, device: string): Promise<Device> {
  const bin = maestroBin()
  console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }).trim())
  const { MaestroD } = maestroClient()
  const connection = await MaestroD.connect({ name: daemon, bin })
  const teamId = process.env.MAESTRO_D_TEAM_ID
  const m = await connection.attach({
    device,
    platform: 'ios',
    appId: APP_ID,
    ...(teamId != null && teamId !== '' ? { teamId } : {})
  })
  const dir = required('E2E_ARTIFACT_DIR')
  mkdirSync(dir, { recursive: true })
  const shot = async (name: string): Promise<void> => {
    const file = join(dir, `${name}.png`)
    writeFileSync(file, await m.screenshot())
    console.log(`screenshot ${file}`)
  }
  return Object.assign(m, { shot })
}

async function visible(
  m: Device,
  id: string,
  timeout: number
): Promise<boolean> {
  return await m
    .assertVisible({ id, timeout })
    .then(() => true)
    .catch(() => false)
}

async function main(): Promise<void> {
  const email = required('TS_E2E_EMAIL')
  const m = await attach(required('MAESTRO_D'), required('DIRECTOR_DEVICE_UDID'))
  try {
    await m.launchApp({ appId: APP_ID, stopApp: true, arguments: { uiTest: true } })
    if (await visible(m, 'start-directing', 30000)) await m.tapOn({ id: 'start-directing' })
    // A fresh install opens on the camera list; nothing here needs a camera.
    if (
      await m
        .assertVisible({ text: 'DONE', timeout: 5000 })
        .then(() => true)
        .catch(() => false)
    )
      await m.tapOn({ text: 'DONE' })
    await m.extendedWaitUntil({ visible: { id: 'settings-button' }, timeout: 30000 })
    await m.tapOn({ id: 'settings-button' })
    await m.extendedWaitUntil({ visible: { id: 'settings-teamstation-account' }, timeout: 20000 })
    await m.tapOn({ id: 'settings-teamstation-account' })
    if (await visible(m, 'teamstation-sign-out', 3000)) {
      throw new Error('Director is already signed in: start from a fresh install')
    }

    const before = mail('newest', email)
    await m.extendedWaitUntil({ visible: { id: 'teamstation-email' }, timeout: 10000 })
    await m.tapOn({ id: 'teamstation-email' })
    await m.inputText({ text: email })
    await m.hideKeyboard()
    await m.tapOn({ id: 'teamstation-send-code' })
    await m.extendedWaitUntil({ visible: { id: 'teamstation-code' }, timeout: 30000 })

    const link = mail('after', email, before === '' ? 'none' : before)
    assert.match(link, /^https:\/\/[^/]+\/signin\/[A-Za-z0-9_-]+\?server=/)
    console.log(`link host ${new URL(link).host}, server ${new URL(link).searchParams.get('server')}`)
    await m.openLink({ link })
    await m.extendedWaitUntil({
      visible: { id: 'status-message', text: 'Signed in to TeamStation as .*' },
      timeout: 30000
    })
    await m.shot('director-link-after')

    // The same host with another server named: nothing is spent, and Director says whose it is.
    const elsewhere = new URL(link)
    elsewhere.pathname = '/signin/e2eWrongServerToken0123456789abcdefghij'
    elsewhere.searchParams.set('server', 'https://other.example.test')
    await m.openLink({ link: elsewhere.toString() })
    await m.extendedWaitUntil({
      visible: { id: 'status-message', text: 'This link is for https://other.example.test.*' },
      timeout: 30000
    })
    await m.shot('director-wrong-server')
    console.log('signed in from the link, and refused another server’s')
  } finally {
    await m.detach()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
