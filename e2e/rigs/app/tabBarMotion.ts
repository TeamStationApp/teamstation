import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

import { type Box, boxOf, flatten } from './keyboardDock'
import type { openTabBar } from './tabBar'

type Handset = Awaited<ReturnType<typeof openTabBar>>

/** Open the real iOS preference and read its switch before changing it. */
async function motionSwitch(
  handset: Handset
): Promise<{ on: boolean; point: string }> {
  await handset.launchApp({ appId: 'com.apple.Preferences' })
  const visible = async (text: string): Promise<boolean> =>
    await handset.assertVisible({ text, timeout: 800 }).then(
      () => true,
      () => false
    )
  if (!(await visible('Reduce Motion'))) {
    if (!(await visible('Motion'))) {
      await handset.scrollUntilVisible({
        element: { text: 'Accessibility' },
        direction: 'DOWN',
        timeout: 10000
      })
      await handset.tapOn({ text: 'Accessibility' })
    }
    await handset.scrollUntilVisible({
      element: { text: 'Motion' },
      direction: 'DOWN',
      timeout: 10000
    })
    await handset.tapOn({ text: 'Motion' })
  }
  await handset.assertVisible({ text: 'Reduce Motion' })
  return await readMotionSwitch(handset)
}

async function readMotionSwitch(
  handset: Handset
): Promise<{ on: boolean; point: string }> {
  const row = flatten(await handset.hierarchy()).find(
    node =>
      node.type?.endsWith('Switch') === true && node.text === 'Reduce Motion'
  )
  const toggle = row?.children?.find(
    node => node.type?.endsWith('Switch') === true
  )
  const checked = row != null && 'checked' in row ? row.checked : undefined
  const raw = row != null && 'value' in row ? row.value : undefined
  const value =
    typeof checked === 'boolean'
      ? checked
      : typeof raw === 'string'
        ? raw
        : toggle?.text
  const box = boxOf(toggle)
  assert(
    box != null && ['0', '1', 'On', 'Off', true, false].includes(value ?? ''),
    'read the Reduce Motion switch'
  )
  return {
    on: value === true || value === '1' || value === 'On',
    point:
      Math.round(box.x + box.width / 2) +
      ',' +
      Math.round(box.y + box.height / 2)
  }
}

export async function withReduceMotion(
  handset: Handset,
  appId: string,
  action: () => Promise<void>
): Promise<void> {
  const original = await motionSwitch(handset)
  try {
    if (!original.on) await handset.tapOn({ point: original.point })
    assert.equal((await readMotionSwitch(handset)).on, true)
    await handset.launchApp({ appId, stopApp: false })
    await action()
  } finally {
    const current = await motionSwitch(handset)
    if (current.on !== original.on)
      await handset.tapOn({ point: current.point })
    assert.equal((await readMotionSwitch(handset)).on, original.on)
    await handset.launchApp({ appId, stopApp: false })
  }
}

/** Capture the first change as well as the resting frames on either side. */
export async function recordCompact(
  udid: string,
  file: string,
  gesture: () => Promise<Box>
): Promise<Box> {
  const recorder = spawn(
    'xcrun',
    ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file],
    { stdio: 'ignore' }
  )
  const closed = once(recorder, 'close')
  try {
    await delay(650)
    const compact = await gesture()
    await delay(350)
    return compact
  } finally {
    recorder.kill('SIGINT')
    const [code] = await closed
    assert.equal(code, 0, 'finished recording the simulator')
  }
}

/** Track the selected Home glyph in each decoded video frame. A fade or a
 * position between the expanded and compact endpoints is an animated frame. */
export function assertCompactSnap(
  file: string,
  window: Box,
  full: Box,
  compact: Box
): void {
  const x = Math.round(full.x + full.width / 8)
  const y = Math.round(full.y + full.height / 8)
  const width = Math.round(compact.x + compact.width) - x
  const height = Math.round(full.height / 2)
  const crop = `scale=${window.width}:${window.height},crop=${width}:${height}:${x}:${y},setpts=N`
  const frames = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      crop,
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const stride = width * height * 3
  assert(
    frames.length >= 6 * stride && frames.length % stride === 0,
    'captured full frames around the transition'
  )
  const centers: number[] = []
  for (let frame = 0; frame < frames.length; frame += stride) {
    let sum = 0
    let count = 0
    for (let offset = 0; offset < stride; offset += 3) {
      const r = frames[frame + offset]
      const g = frames[frame + offset + 1]
      const b = frames[frame + offset + 2]
      // Allow for video compression around the app theme's green Home icon.
      if (
        Math.abs(r - 43) < 23 &&
        Math.abs(g - 66) < 23 &&
        Math.abs(b - 33) < 23 &&
        g > r + 11 &&
        g > b + 20
      ) {
        sum += x + ((offset / 3) % width)
        count++
      }
    }
    assert(count >= 8, `Home glyph faded in frame ${centers.length + 1}`)
    centers.push(sum / count)
  }
  const first = centers[0]
  const final = centers.at(-1)!
  assert(
    Math.abs(first - (full.x + full.width / 2)) < 9 &&
      Math.abs(final - (compact.x + compact.width / 2)) < 9 &&
      final - first > 12,
    'captured expanded and compact Home positions'
  )
  const changed = centers.findIndex(center => Math.abs(center - first) > 2)
  assert(
    changed >= 1 && centers.length - changed >= 3,
    'captured the change and resting compact frames'
  )
  for (const [index, center] of centers.entries()) {
    assert(
      Math.abs(center - (index < changed ? first : final)) <= 2,
      `Home passed through an intermediate position in frame ${index + 1}`
    )
  }
}
