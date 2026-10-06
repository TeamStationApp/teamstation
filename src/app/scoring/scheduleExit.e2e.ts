// Run with node -r sucrase/register. Both platforms use the real App shell.
// Required env: TEST_DEVICE, MAESTRO_D, MAESTRO_D_CLIENT_ROOT, TEST_APP_ID,
// TEST_URL, TEST_GAME_LABEL (regex), TEST_ARTIFACT_DIR, TEST_PHASE (before/after),
// TEST_FIXTURE_CONTROL_URL. The local fixture control accepts POST JSON
// { rejectWrites: boolean }, resets game events, and rejects scoring writes
// with HTTP 503 when requested. Never point it at a live service.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

interface Element {
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Element[]
}
interface Device {
  hierarchy: () => Promise<Element>
  tapOn: (selector: {
    text?: string
    point?: string
    timeout?: number
  }) => Promise<unknown>
  assertVisible: (selector: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  assertNotVisible: (selector: { text: string }) => Promise<unknown>
  launchApp: (options: { appId: string }) => Promise<unknown>
  stopApp: (options: { appId: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
}
interface Daemon {
  attach: (options: {
    device: string
    platform: string
    appId: string
  }) => Promise<Device>
  close: () => void
}
function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
async function main(): Promise<void> {
  const requireClient = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )
  const { MaestroD } = requireClient('maestro-d') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const appId = required('TEST_APP_ID')
  const phase = required('TEST_PHASE')
  assert(
    phase === 'before' || phase === 'after',
    'TEST_PHASE must be before or after'
  )
  const artifacts = resolve(required('TEST_ARTIFACT_DIR'))
  const gameLabel = required('TEST_GAME_LABEL')
  const control = required('TEST_FIXTURE_CONTROL_URL')
  const fixture = async (rejectWrites: boolean): Promise<void> => {
    const response = await fetch(control, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejectWrites })
    })
    assert(response.ok, 'Fixture reset failed')
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  try {
    await fixture(false)
    const m = await daemon.attach({
      device: required('TEST_DEVICE'),
      platform: 'ios',
      appId
    })
    const safari = appId === 'com.apple.mobilesafari'
    const surface = safari ? 'safari' : 'native'
    const tap = async (text: string): Promise<void> => {
      await m.tapOn({ text, timeout: 15000 })
    }
    const visible = async (text: string): Promise<void> => {
      await m.assertVisible({ text, timeout: 15000 })
    }
    await m.stopApp({ appId })
    await m.launchApp({ appId })
    if (safari) await m.openLink({ link: required('TEST_URL') })
    const tab = async (label: string): Promise<void> => {
      await visible(`^${label}$`)
      const flatten = (node: Element): Element[] => [
        node,
        ...(node.children ?? []).flatMap(flatten)
      ]
      const matches = flatten(await m.hierarchy()).filter(
        node => node.text === label && node.bounds != null
      )
      const target = matches.sort((a, b) => b.bounds!.y - a.bounds!.y)[0]
        ?.bounds
      assert(target != null, `Missing ${label} tab`)
      await m.tapOn({
        point: `${Math.round(target.x + target.width / 2)},${Math.round(target.y + target.height / 2)}`
      })
    }
    await tab('Schedule')
    const enter = async (): Promise<void> => {
      await visible('^Upcoming$')
      await tap(gameLabel)
      await tap('^Score Game$')
      await tap('^Full game scoring$')
      await visible('^Open scoring menu$')
    }
    const exit = async (): Promise<void> => {
      await tap('^Open scoring menu$')
      await tap('^Exit Current Game$')
    }
    const revisit = async (): Promise<void> => {
      await tab('Videos')
      await tab('Schedule')
    }
    const schedule = async (): Promise<void> => {
      await visible('^Upcoming$')
      await visible(gameLabel)
      await m.assertNotVisible({ text: '^Open scoring menu$' })
    }
    await mkdir(artifacts, { recursive: true })
    for (let cycle = 1; cycle <= (phase === 'before' ? 1 : 2); cycle++) {
      await enter()
      await exit()
      await revisit()
      if (phase === 'before') await visible('^Open scoring menu$')
      else await schedule()
      if (cycle === 1)
        await writeFile(
          join(artifacts, `${surface}-schedule-${phase}.png`),
          await m.screenshot()
        )
      console.log(`${surface}: ${phase} clean exit cycle ${cycle} passed`)
    }
    if (phase === 'after') {
      await fixture(true)
      await enter()
      await tap('^Ball$')
      await exit()
      await visible('^Discard and Exit$')
      await tap('^Cancel$')
      await visible('^Open scoring menu$')
      await m.assertNotVisible({ text: '^Schedule$' })
      await exit()
      await tap('^Discard and Exit$')
      await revisit()
      await schedule()
      console.log(
        `${surface}: failed-save cancel retains scorer; discard returns Schedule to list`
      )
    }
  } finally {
    await fixture(false)
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
