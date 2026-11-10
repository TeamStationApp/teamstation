// Physical local or already-open Director/Preview camera controls.
// FOCUS_DEVICE, FOCUS_PLATFORM, MAESTRO_D, MAESTRO_D_CLIENT_ROOT, ARTIFACT_DIR required.
// FOCUS_APP defaults to Cameraman; FOCUS_LAUNCH=1 launches it. The caller owns the device lease.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { hasNewFocusRequest } from '../../../../src/test/focusRequest'
import { promisify } from 'node:util'

interface ViewNode {
  id?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: ViewNode[]
}
const flatten = (node: ViewNode): ViewNode[] => [node, ...(node.children ?? []).flatMap(flatten)]

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const wait = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))
async function main(): Promise<void> {
  const { MaestroD } = require(required('MAESTRO_D_CLIENT_ROOT'))
  const platform = required('FOCUS_PLATFORM')
  const appId = process.env.FOCUS_APP ?? 'app.teamstation.cameraman'
  const artifactDir = required('ARTIFACT_DIR')
  await mkdir(artifactDir, { recursive: true })
  const m = await MaestroD.attach({ name: required('MAESTRO_D'), device: required('FOCUS_DEVICE'), platform,
    teamId: process.env.FOCUS_TEAM_ID, appId })
  if (process.env.FOCUS_LAUNCH === '1') await m.launchApp({ appId, stopApp: true, arguments: { uiTest: true } })
  await m.assertVisible({ id: 'camera-screen', timeout: 15000 })
  await m.assertVisible({ id: 'focus-auto', timeout: 15000 })
  await m.tapOn({ id: 'focus-auto' })
  await m.assertVisible({ text: 'Auto Focus', timeout: 10000 })
  const bounds = flatten(await m.hierarchy()).find(node => node.id === 'camera-screen')?.bounds
  assert(bounds != null && bounds.width > 0 && bounds.height > 0, 'Missing screen bounds')
  const tap = async (x: number, y: number): Promise<void> => {
    const previous = flatten(await m.hierarchy()).find(node => node.id?.startsWith('focus-state:') === true)?.id
    assert(previous != null, 'Missing capture focus request identifier')
    await m.tapOnPoint({ x: Math.round(bounds.x + x * bounds.width),
      y: Math.round(bounds.y + y * bounds.height), waitToSettleTimeoutMs: 1 })
    for (const end = Date.now() + 12000; Date.now() < end;) {
      const next = flatten(await m.hierarchy()).find(node => node.id?.startsWith('focus-state:') === true)?.id
      if (hasNewFocusRequest(previous, next)) return
      await wait(100)
    }
    throw new Error('Tap never received a new capture-reported focus request')
  }
  await tap(0.4, 0.45)
  await writeFile(path.join(artifactDir, `focus-${platform}-tap.png`), await m.screenshot())
  await tap(0.6, 0.55)
  await wait(2500)
  await m.assertNotVisible({ id: 'focus-marker', timeout: 2000 })
  await m.assertVisible({ text: 'Focus locked', timeout: 12000 })
  const held = JSON.stringify(await m.hierarchy())
  assert(held.includes('Focus locked'), 'Camera never reported a held focus result')
  await writeFile(path.join(artifactDir, `focus-${platform}-held.json`), held)
  await m.tapOn({ id: 'focus-auto' })
  await wait(1500)
  await m.assertNotVisible({ text: 'Focus locked', timeout: 3000 })
  const state = flatten(await m.hierarchy()).find(node => node.id?.startsWith('focus-state:') === true)
  assert(state != null && flatten(state).some(node => node.text === 'Auto Focus'), 'Camera did not report continuous autofocus')
  await writeFile(path.join(artifactDir, `focus-${platform}-auto.png`), await m.screenshot())
  if (process.env.FOCUS_FLIP === '1') {
    // State alone can look healthy when the replacement camera never starts.
    // Receive real video and audio after each flip, including the return journey.
    const host = required('FOCUS_HOST')
    for (const position of ['front', 'back']) {
      await m.tapOn({ id: 'flip-button' })
      await wait(2000)
      await m.assertNotVisible({ text: 'Focus locked', timeout: 3000 })
      const output = await promisify(execFile)(process.execPath, [
        path.resolve(__dirname, '../scripts/rtspClient.js'), '--host', host,
        '--seconds', '5', '--out', path.join(artifactDir, `flip-${position}.h264`)
      ], { timeout: 20000 })
      await writeFile(path.join(artifactDir, `flip-${position}.log`), output.stdout + output.stderr)
      assert.match(output.stderr, /\bOK\b/, 'Replacement camera did not deliver live media')
      await m.tapOn({ id: 'focus-auto' })
      await m.assertVisible({ text: 'Auto Focus', timeout: 10000 })
      await writeFile(path.join(artifactDir, `flip-${position}.png`), await m.screenshot())
    }
  }
  console.log('PASS: tap, retap, marker expiry, reported lock, explicit auto. Optical near/far proof is separate.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
