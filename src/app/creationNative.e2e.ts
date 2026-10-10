import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { expect } from 'chai'

import { asPublicGroup } from '../common/publicGroups'

/** OS-only vectors are supplied privately alongside the isolated fixture.
 * Never auto-select, boot, erase, or shut down somebody's device.
 * A failed assertion leaves a failed transcript, never a PASS artifact.
 */
interface NativeDevice {
  command: (name: string, params?: Record<string, unknown>) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
}
interface NativeClient {
  attach: (options: {
    name: string
    device: string
    appId: string
    platform: 'ios' | 'android'
    artifacts: 'none'
    typingFrequency: number
  }) => Promise<NativeDevice>
}
type Step =
  | { command: string; params?: Record<string, unknown>; label: string }
  | { capture: string }
  | { resetLocation: true }
  | {
      checkPublicGroup: {
        name: string
        city: string
        hasImage: boolean
      }
    }
interface NativeFlow {
  vector: string
  phase?: 'setup' | 'verify'
  log: 'native-location.log' | 'native-bell-photo.log'
  steps: Step[]
}
const allowed = new Set([
  'tapOn',
  'inputText',
  'hideKeyboard',
  'assertVisible',
  'assertNotVisible',
  'stopApp',
  'launchApp',
  'setLocation',
  'back',
  'scroll',
  'scrollUntilVisible',
  'swipe',
  'addMedia',
  'acceptAlert',
  'dismissAlert'
])
async function main(): Promise<void> {
  const device = process.env.TS_CREATION_DEVICE_UDID
  const platform = process.env.TS_CREATION_PLATFORM
  const flowPath = process.env.TS_CREATION_NATIVE_FLOW
  const clientPath = process.env.TS_MAESTRO_D_CLIENT
  const artifacts = process.env.TS_CREATION_ARTIFACTS
  if (
    device == null ||
    (platform !== 'ios' && platform !== 'android') ||
    flowPath == null ||
    clientPath == null ||
    artifacts == null
  )
    throw new Error(
      'Supply the pinned device, platform, flow, Maestro D client and artifacts directory'
    )
  if (platform === 'ios') {
    const inventory = JSON.parse(
      execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
        encoding: 'utf8'
      })
    ) as { devices: Record<string, Array<{ udid: string; state: string }>> }
    expect(
      Object.values(inventory.devices)
        .flat()
        .some(item => item.udid === device && item.state === 'Booted'),
      'Supplied iOS simulator must already be running'
    ).equals(true)
  } else {
    expect(
      execFileSync('adb', ['-s', device, 'get-state'], {
        encoding: 'utf8'
      }).trim()
    ).equals('device')
  }
  const flow = JSON.parse(await readFile(flowPath, 'utf8')) as NativeFlow
  if (
    !/^N[12][a-d]$/.test(flow.vector) ||
    !['native-location.log', 'native-bell-photo.log'].includes(flow.log) ||
    !Array.isArray(flow.steps) ||
    flow.steps.length === 0
  )
    throw new Error('Supply a named, nonempty N1/N2 flow')
  const { MaestroD } = createRequire(path.resolve('package.json'))(
    clientPath
  ) as { MaestroD: NativeClient }
  const session = await MaestroD.attach({
    name: process.env.MAESTRO_D ?? 'teamstationCreation',
    device,
    platform,
    appId: 'app.teamstation.app',
    artifacts: 'none',
    typingFrequency: 2
  })
  await mkdir(artifacts, { recursive: true })
  const log = path.join(artifacts, flow.log)
  await appendFile(
    log,
    `$ TS_CREATION_PLATFORM=${platform} node -r sucrase/register src/app/creationNative.e2e.ts\n${flow.vector} START: explicitly pinned already-running simulator/device; identity omitted\n`
  )
  try {
    for (const step of flow.steps) {
      if ('command' in step) {
        if (!allowed.has(step.command))
          throw new Error('Unsupported native verification command')
        if (step.params?.optional === true)
          throw new Error('Native acceptance steps cannot silently skip')
        if (
          step.command === 'launchApp' &&
          step.params != null &&
          ('clearState' in step.params || 'clearKeychain' in step.params)
        )
          throw new Error('Native verification cannot reset application data')
        await session.command(step.command, step.params)
        await appendFile(
          log,
          `${flow.vector}: ${step.command} — ${step.label}\n`
        )
      } else if ('resetLocation' in step) {
        if (platform === 'ios')
          execFileSync(
            'xcrun',
            [
              'simctl',
              'privacy',
              device,
              'reset',
              'location',
              'app.teamstation.app'
            ],
            { stdio: 'ignore' }
          )
        else
          execFileSync(
            'adb',
            [
              '-s',
              device,
              'shell',
              'pm',
              'revoke',
              'app.teamstation.app',
              'android.permission.ACCESS_COARSE_LOCATION'
            ],
            { stdio: 'ignore' }
          )
        await appendFile(
          log,
          `${flow.vector}: reset only the application's location permission\n`
        )
      } else if ('capture' in step) {
        if (!/^native-[a-z0-9-]+\.png$/.test(step.capture))
          throw new Error('Invalid native artifact name')
        const file = path.join(artifacts, step.capture)
        // WDA can omit SpringBoard dialogs: simctl supplies independent OS pixels.
        if (platform === 'ios')
          execFileSync('xcrun', ['simctl', 'io', device, 'screenshot', file], {
            stdio: 'ignore'
          })
        else await writeFile(file, await session.screenshot())
        await appendFile(log, `${flow.vector}: captured ${step.capture}\n`)
      } else {
        const origin = process.env.TS_CREATION_NATIVE_ORIGIN
        if (origin == null)
          throw new Error('Supply the isolated native fixture origin')
        const response = await fetch(
          `${origin}/api/v1/leagues?view=public&query=${encodeURIComponent(step.checkPublicGroup.name)}`
        )
        expect(response.status).equals(200)
        const raw: unknown = await response.json()
        if (!Array.isArray(raw))
          throw new Error('Public group list must be an array')
        const groups = raw.map(asPublicGroup)
        const group = groups.find(
          item => item.name === step.checkPublicGroup.name
        )
        expect(group).not.equals(undefined)
        expect(group!.locality?.city).equals(step.checkPublicGroup.city)
        expect(group!.imageUrl != null).equals(step.checkPublicGroup.hasImage)
        expect(JSON.stringify(raw)).not.match(/"(?:latitude|longitude)"/)
        await appendFile(
          log,
          `${flow.vector}: saved confirmed locality/photo is public and reloadable; no device coordinates\n`
        )
      }
    }
    const result = flow.phase === 'setup' ? 'SETUP COMPLETE' : 'PASS'
    await appendFile(
      log,
      `${flow.vector} ${result}: ${platform}; every supplied step completed\n\n`
    )
    console.log(`${flow.vector} ${result}: ${platform}`)
  } catch (error) {
    await appendFile(
      log,
      `${flow.vector} FAIL: ${platform}; assertion or device command failed\n\n`
    )
    throw error
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Native verification failed'
  )
  process.exitCode = 1
})
