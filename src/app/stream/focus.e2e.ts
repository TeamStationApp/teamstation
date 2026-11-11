// Physical phone, already signed in with the recording preview open.
// Claim the device before running; the script never acquires or steals a lease.
// FOCUS_DEVICE, FOCUS_PLATFORM, FOCUS_APP, MAESTRO_D, MAESTRO_D_CLIENT_ROOT,
// ARTIFACT_DIR required. FOCUS_RECORD=1 starts and stops a take around the checks.
// Optional FOCUS_NEAR/FOCUS_FAR are normalized x,y points on placed contrast targets.
// Optical sharpness and crossing-subject retention require inspecting the saved video.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { hasNewFocusRequest } from '../../test/focusRequest'

interface UiNode {
  id?: string
  text?: string
  accessibilityText?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: UiNode[]
}
const flatten = (node: UiNode): UiNode[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const { MaestroD } = require(required('MAESTRO_D_CLIENT_ROOT'))
  const platform = required('FOCUS_PLATFORM')
  assert(platform === 'ios' || platform === 'android')
  const dir = required('ARTIFACT_DIR')
  await mkdir(dir, { recursive: true })
  const m = await MaestroD.attach({
    name: required('MAESTRO_D'),
    device: required('FOCUS_DEVICE'),
    platform,
    appId: required('FOCUS_APP'),
    teamId: process.env.FOCUS_TEAM_ID
  })
  const nodes = async (): Promise<UiNode[]> => flatten(await m.hierarchy())
  const state = async (expected: string): Promise<void> => {
    for (const end = Date.now() + 12000; Date.now() < end;) {
      const node = (await nodes()).find(
        node => node.id?.startsWith('focus-state:') === true
      )
      if (
        node != null &&
        flatten(node).some(
          child => (child.text ?? child.accessibilityText) === expected
        )
      )
        return
      await wait(250)
    }
    throw new Error(`Camera did not report ${expected}`)
  }
  const save = async (name: string): Promise<void> => {
    await m.takeScreenshot({ path: path.join(dir, `${platform}-${name}.png`) })
    await writeFile(
      path.join(dir, `${platform}-${name}.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
  }
  await m.assertVisible({ id: 'camera-screen', timeout: 15000 })
  await m.tapOn({ id: 'auto-focus' })
  await state('Auto Focus')
  const recording = process.env.FOCUS_RECORD === '1'
  if (recording) {
    await m.tapOn({ id: 'broadcast-button' })
    await wait(5000)
    const button = (await nodes()).find(node => node.id === 'broadcast-button')
    assert(
      button != null && /stop/i.test(JSON.stringify(button)),
      'Recording did not start'
    )
  }
  const bounds = (await nodes()).find(
    node => node.id === 'camera-screen'
  )?.bounds
  assert(bounds != null && bounds.width > 0 && bounds.height > 0)
  const tap = async (value: string): Promise<void> => {
    const [x, y] = value.split(',').map(Number)
    assert(
      [x, y].every(value => Number.isFinite(value) && value > 0 && value < 1)
    )
    const previous = (await nodes()).find(
      node => node.id?.startsWith('focus-state:') === true
    )?.id
    assert(previous != null, 'Missing capture focus request identifier')
    await m.tapOnPoint({
      x: Math.round(bounds.x + x * bounds.width),
      y: Math.round(bounds.y + y * bounds.height),
      waitToSettleTimeoutMs: 1
    })
    for (const end = Date.now() + 12000; Date.now() < end;) {
      const next = (await nodes()).find(
        node => node.id?.startsWith('focus-state:') === true
      )?.id
      if (hasNewFocusRequest(previous, next)) return
      await wait(100)
    }
    throw new Error('Tap never received a new capture-reported focus request')
  }
  await tap(process.env.FOCUS_NEAR ?? '0.54,0.55')
  await save('near-marker')
  await state('Focus locked')
  await wait(2200)
  await m.assertNotVisible({ id: 'focus-marker', timeout: 1000 })
  await state('Focus locked')
  await save('near-held')
  await tap(process.env.FOCUS_FAR ?? '0.44,0.47')
  await save('far-marker')
  await state('Focus locked')
  await wait(2500)
  await save('far-held')
  await m.tapOn({ id: 'auto-focus' })
  await state('Auto Focus')
  await m.assertNotVisible({ id: 'focus-marker', timeout: 1000 })
  await save('auto')
  if (recording) {
    const button = (await nodes()).find(node => node.id === 'broadcast-button')
    assert(
      button != null && /stop/i.test(JSON.stringify(button)),
      'Take stopped during focus'
    )
    await m.tapOn({ id: 'broadcast-button' })
    const controls = await nodes()
    const knob = controls.find(node => node.id === 'slide-to-stop-knob')?.bounds
    const track = controls.find(
      node => node.id === 'slide-to-stop-track'
    )?.bounds
    assert(knob != null && track != null, 'Missing stop confirmation')
    await m.swipe({
      startX: Math.round(knob.x + knob.width / 2),
      startY: Math.round(knob.y + knob.height / 2),
      endX: Math.round(track.x + track.width - knob.width / 2),
      endY: Math.round(knob.y + knob.height / 2),
      duration: 800
    })
    await wait(2000)
    await save('stopped')
  }
  console.log(
    'PASS: native focus status, near/far requests, marker expiry with lock held, explicit auto' +
      (recording ? ', recording remained active through the sequence' : '')
  )
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
