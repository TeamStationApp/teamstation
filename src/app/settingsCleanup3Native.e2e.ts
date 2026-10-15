import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { nativePlaybackSeconds } from '../test/nativePlaybackClock'
import { maestro, type MaestroHandle } from '../test/refinementsMaestro.e2e'

interface NativeNode {
  text?: string
  id?: string
  type?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: NativeNode[]
}
const flatten = (node: NativeNode): NativeNode[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const viewportOf = (node: NativeNode): NonNullable<NativeNode['bounds']> => {
  if (node.bounds != null) return node.bounds
  const windows = (node.children ?? []).flatMap(child =>
    child.bounds == null ? [] : [child.bounds]
  )
  const width = Math.max(0, ...windows.map(rect => rect.x + rect.width))
  const height = Math.max(0, ...windows.map(rect => rect.y + rect.height))
  assert(width > 0 && height > 0, 'Native window bounds required')
  return { x: 0, y: 0, width, height }
}
interface Selector {
  text?: string
  id?: string
  type?: string
}
type Step =
  | { open: string; visible: string }
  | { command: string; params?: Record<string, unknown> }
  | { input: string; value: string }
  | { screenshot: string }
  | { saveState: string }
  | { stateUnchanged: string; fields?: string[] }
  | { stateEquals: { path: Array<string | number>; value: unknown } }
  | {
      stateRow: {
        table: string
        match: Record<string, unknown>
        values: Record<string, unknown>
      }
    }
  | { signIn: string }
  | { fontScale: 'large' | 'default' }
  | {
      clock: (
        { save: string } | { after: string; min: number; max: number }
      ) & { native?: boolean }
    }
  | {
      position:
        | { save: string; target: Selector }
        | { matches: string; target: Selector; tolerance?: number }
    }
  | {
      geometry: {
        target: Selector
        relation: 'centered' | 'right' | 'visible'
        reference?: Selector
        tolerance?: number
      }
    }
  | { wait: number }
interface Case {
  id: string
  steps: Step[]
}
interface Flow {
  scenario: 'N1' | 'N2' | 'N3'
  cases: Case[]
}
const required = {
  N1: [
    'season-cancel',
    'season-confirm',
    'parent-cancel',
    'team-gear',
    'league-gear',
    'season-gear',
    'event-gears',
    'player-gear',
    'node-add-revoke',
    'emails-toggle',
    'player-remove-cancel',
    'denied-settings'
  ],
  N2: [
    'create-picker',
    'edit-picker',
    'team-tints',
    'team-initials',
    'season-initials',
    'league-initials',
    'add-event',
    'large-text',
    'orientation'
  ],
  N3: [
    'team-pinning',
    'event-pinning',
    'feed-pinning',
    'stats-filter',
    'location-cancel',
    'invalid-invite',
    'video-playback',
    'video-return',
    'video-rotation'
  ]
}
const commands = new Set([
  'tapOn',
  'assertVisible',
  'assertNotVisible',
  'scrollUntilVisible',
  'swipe',
  'hideKeyboard',
  'pressKey',
  'setOrientation',
  'setDarkMode',
  'startRecording',
  'stopRecording',
  'back'
])

/** Explicit target and owned fixture only; no browser or DOM verification. */
async function main(): Promise<void> {
  const device = process.env.TS_SETTINGS3_DEVICE
  const platform = process.env.TS_SETTINGS3_PLATFORM
  const appFile = process.env.TS_SETTINGS3_APP_FILE
  const manifestPath = process.env.TS_SETTINGS3_NATIVE_MANIFEST
  const flowPath = process.env.TS_SETTINGS3_NATIVE_FLOW
  const artifacts = process.env.TS_CREATION_ARTIFACTS
  const daemonName = process.env.MAESTRO_D
  if (
    device == null ||
    (platform !== 'ios' && platform !== 'android') ||
    appFile == null ||
    manifestPath == null ||
    flowPath == null ||
    artifacts == null ||
    daemonName == null
  )
    throw new Error(
      'Supply explicit owned target, platform, current app, manifest, flow, artifacts and daemon'
    )
  const owned = JSON.parse(
    await readFile(join(artifacts, 'support/owned-device.json'), 'utf8')
  ) as { device: string; platform: string }
  assert.equal(owned.device, device)
  assert.equal(owned.platform, platform)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    branch: string
    commit: string
    apiBaseUrl: string
    controlOrigin: string
    email: string
  }
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    manifest.commit
  )
  assert.equal(manifest.branch, 'paul/settingsCleanup3')
  if (platform === 'ios') {
    const inventory = JSON.parse(
      execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
        encoding: 'utf8'
      })
    ) as { devices: Record<string, Array<{ udid: string; state: string }>> }
    assert(
      Object.values(inventory.devices)
        .flat()
        .some(row => row.udid === device && row.state === 'Booted')
    )
  } else {
    assert(device.startsWith('emulator-'), 'Android QA targets an emulator')
    assert.equal(
      execFileSync('adb', ['-s', device, 'get-state'], {
        encoding: 'utf8'
      }).trim(),
      'device'
    )
  }
  const flow = JSON.parse(await readFile(flowPath, 'utf8')) as Flow
  assert(
    ['N1', 'N2', 'N3'].includes(flow.scenario),
    'Named native scenario required'
  )
  assert.deepEqual(
    flow.cases.map(item => item.id).sort(),
    [...required[flow.scenario]].sort(),
    'Every native acceptance case must run exactly once'
  )
  await mkdir(artifacts, { recursive: true })
  const transcript = join(artifacts, `${flow.scenario}.log`)
  const note = async (line: string): Promise<void> => {
    await appendFile(transcript, line + '\n')
    console.log(line)
  }
  await note(
    `$ node -r sucrase/register src/app/settingsCleanup3Native.e2e.ts\n${platform} ${flow.scenario} source ${manifest.branch}@${manifest.commit}`
  )
  const daemon = await maestro(daemonName)
  let m: MaestroHandle | undefined
  let recording = false
  let iosRecording: ChildProcess | undefined
  let recordingExit: Promise<number> | undefined
  const stopRecording = async (): Promise<void> => {
    if (iosRecording != null) {
      const process = iosRecording
      if (process.exitCode == null && process.signalCode == null)
        process.kill('SIGINT')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const code = await Promise.race([
          recordingExit!,
          new Promise<never>((resolve, reject) => {
            timer = setTimeout(() => {
              process.kill('SIGKILL')
              reject(new Error('Owned simulator recording did not finalize'))
            }, 15000)
          })
        ])
        assert.equal(code, 0, 'Owned simulator recording finalized')
      } catch (error) {
        process.kill('SIGKILL')
        await recordingExit
        throw error
      } finally {
        clearTimeout(timer)
        iosRecording = undefined
        recordingExit = undefined
        recording = false
      }
    } else {
      await m?.command('stopRecording')
      recording = false
    }
  }
  let passed = false
  const snapshots = new Map<string, Record<string, unknown>>()
  const clocks = new Map<string, number>()
  const positions = new Map<string, NonNullable<NativeNode['bounds']>>()
  let originalFont: string | undefined
  const font = (value: string): void => {
    if (platform === 'ios')
      execFileSync('xcrun', ['simctl', 'ui', device, 'content_size', value])
    else
      execFileSync('adb', [
        '-s',
        device,
        'shell',
        'settings',
        'put',
        'system',
        'font_scale',
        value
      ])
  }
  const state = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(manifest.controlOrigin + '/state')
    assert.equal(response.status, 200)
    return (await response.json()) as Record<string, unknown>
  }
  try {
    m = await daemon.attach({
      device,
      platform,
      appId: 'app.teamstation.app',
      appFile: resolve(appFile),
      artifacts: 'on-failure',
      driverStartTimeout: 180,
      extra: platform === 'android' ? { androidTcpForward: true } : {}
    })
    await m.launchApp({ appId: 'app.teamstation.app', clearState: false })
    const focusField = async (label: string): Promise<void> => {
      assert(m != null, 'Attached native application required')
      if (platform === 'android') {
        const text = '^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
        await m.tapOn({ text, timeout: 15000 })
        await m.assertVisible({ text, focused: true, timeout: 15000 })
        return
      }
      const tree = (await m.hierarchy()) as NativeNode
      const nodes = flatten(tree)
      const fields = nodes.filter(
        node =>
          /(?:TextField|TextView|EditText)$/.test(node.type ?? '') &&
          node.bounds != null
      )
      const named = fields.filter(node => node.text === label)
      const heading = nodes.find(
        node => node.text === label.toUpperCase() && node.bounds != null
      )
      const field =
        named.length === 1
          ? named[0]
          : fields
              .filter(
                node =>
                  heading?.bounds != null && node.bounds!.y >= heading.bounds.y
              )
              .sort((a, b) => a.bounds!.y - b.bounds!.y)[0]
      assert(field?.bounds != null, 'Native editable field required: ' + label)
      const viewport = viewportOf(tree)
      assert(viewport != null && viewport.width > 0 && viewport.height > 0)
      await m.tapOn({
        point: `${(100 * (field.bounds.x + field.bounds.width / 2)) / viewport.width}%,${(100 * (field.bounds.y + field.bounds.height / 2)) / viewport.height}%`
      })
    }
    const inputControlledText = async (value: string): Promise<void> => {
      assert(m != null, 'Attached native application required')
      // Let each controlled-field render settle before the next native key.
      // A single WDA key sequence can move the cursor during search refreshes.
      for (const character of value) {
        await m.inputText({
          text: character,
          ...(platform === 'android' ? { keyPress: true } : {})
        })
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    const signIn = async (email: string): Promise<void> => {
      assert(m != null, 'Attached native application required')
      await m.assertVisible({
        text: '^Sign in to TeamStation$',
        timeout: platform === 'android' ? 120000 : 60000
      })
      await focusField('E-mail address')
      await inputControlledText(email)
      await m.tapOn({ text: 'Send me a sign-in code', timeout: 15000 })
      let code: unknown
      for (
        let attempt = 0;
        attempt < 30 && typeof code !== 'string';
        attempt++
      ) {
        const response = await fetch(
          manifest.controlOrigin + '/code?email=' + encodeURIComponent(email)
        )
        assert.equal(response.status, 200)
        code = (await response.json()).code
        if (typeof code !== 'string')
          await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert.equal(
        typeof code,
        'string',
        'Ordinary sign-in must receive fixture mail'
      )
      await focusField('Sign-in code')
      await inputControlledText(code as string)
      await m.tapOn({
        text: '^Sign in$',
        id: 'settings-pill-button',
        timeout: 15000
      })
      await m.assertNotVisible({
        text: '^Sign in to TeamStation$',
        timeout: 15000
      })
      await m.assertVisible({ text: 'Search', timeout: 15000 })
    }
    if (process.env.TS_SETTINGS3_SIGN_IN === '1') await signIn(manifest.email)
    await m.openLink({ link: 'teamstation://' })
    await m.tapOn({ text: 'About TeamStation', timeout: 15000 })
    await m.assertVisible({ text: manifest.commit, timeout: 15000 })
    await m.assertVisible({ text: manifest.branch, timeout: 15000 })
    await m.assertVisible({
      text: new URL(manifest.apiBaseUrl).origin,
      timeout: 15000
    })
    await m.tapOn({ text: 'Close build information', timeout: 15000 })
    const selectNode = (
      nodes: NativeNode[],
      selector: Selector
    ): NativeNode => {
      assert(
        selector.id != null || selector.text != null,
        'Nonempty geometry selector'
      )
      const found = nodes.filter(
        node =>
          (selector.type == null ||
            new RegExp(selector.type).test(node.type ?? '')) &&
          (selector.id != null
            ? node.id?.endsWith(selector.id) === true
            : node.text === selector.text)
      )
      assert.equal(
        found.length,
        1,
        'Unique hierarchy geometry target: ' + JSON.stringify(selector)
      )
      assert(found[0].bounds != null, 'Bounds required')
      return found[0]
    }
    const rawHierarchy = async (): Promise<Buffer> =>
      await (
        m as MaestroHandle & { hierarchyRaw: () => Promise<Buffer> }
      ).hierarchyRaw()
    for (const test of flow.cases) {
      assert(test.steps.length > 0, 'Acceptance case cannot be empty')
      let assertions = 0
      let captures = 0
      await note(`${test.id} START`)
      for (const step of test.steps) {
        if ('open' in step) {
          assert(step.open.startsWith('/') && !step.open.startsWith('//'))
          await m.openLink({ link: 'teamstation://' + step.open.slice(1) })
          await m.assertVisible({ text: step.visible, timeout: 15000 })
          assertions++
        } else if ('command' in step) {
          assert(commands.has(step.command), 'Allowed native command')
          assert(step.params?.optional !== true, 'No optional acceptance step')
          const params = { ...step.params }
          if (step.command === 'startRecording') {
            assert(!recording, 'One recording at a time')
            params.path = join(artifacts, `${test.id}.mp4`)
            recording = true
          }
          if (step.command === 'startRecording' && platform === 'ios') {
            // The native command driver does not implement recording on iOS.
            // Record only this explicit owned target and await its first frame.
            const process = spawn(
              'xcrun',
              [
                'simctl',
                'io',
                device,
                'recordVideo',
                '--codec=h264',
                String(params.path)
              ],
              { stdio: ['ignore', 'ignore', 'pipe'] }
            )
            iosRecording = process
            recordingExit = new Promise(resolve => {
              process.once('error', () => {
                resolve(-1)
              })
              process.once('exit', code => {
                resolve(code ?? -1)
              })
            })
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                new Promise<void>((resolve, reject) => {
                  let output = ''
                  process.stderr.on('data', bytes => {
                    output += String(bytes)
                    if (output.includes('Recording started')) resolve()
                  })
                  timer = setTimeout(() => {
                    reject(new Error('Owned simulator recording did not start'))
                  }, 15000)
                }),
                recordingExit.then(() => {
                  throw new Error(
                    'Owned simulator recorder exited before its first frame'
                  )
                })
              ])
            } finally {
              clearTimeout(timer)
            }
          } else if (step.command === 'stopRecording') await stopRecording()
          else await m.command(step.command, params)
          if (step.command.startsWith('assert')) assertions++
        } else if ('input' in step) {
          await focusField(step.input)
          await m.eraseText({ characters: 250 })
          await inputControlledText(step.value)
          await m.hideKeyboard()
        } else if ('screenshot' in step) {
          assert(/^[a-z0-9-]+\.png$/.test(step.screenshot))
          const file = join(artifacts, step.screenshot)
          if (platform === 'ios')
            execFileSync(
              'xcrun',
              ['simctl', 'io', device, 'screenshot', file],
              { stdio: 'ignore' }
            )
          else await writeFile(file, await m.screenshot())
          await writeFile(
            file.replace(/\.png$/, '.hierarchy.json'),
            JSON.stringify(await m.hierarchy(), null, 2)
          )
          await writeFile(
            file.replace(/\.png$/, '.hierarchy.raw'),
            await rawHierarchy()
          )
          captures++
        } else if ('saveState' in step)
          snapshots.set(step.saveState, await state())
        else if ('stateUnchanged' in step) {
          const before = snapshots.get(step.stateUnchanged)
          assert(before != null, 'Prior fixture snapshot required')
          const after = await state()
          for (const field of step.fields ?? Object.keys(before))
            assert.deepEqual(after[field], before[field], field + ' unchanged')
          assertions++
        } else if ('stateEquals' in step) {
          let value: any = await state()
          for (const key of step.stateEquals.path) value = value[key]
          assert.deepEqual(value, step.stateEquals.value)
          assertions++
        } else if ('stateRow' in step) {
          const { table, match, values } = step.stateRow
          const rows = (await state())[table]
          assert(Array.isArray(rows), 'Fixture table required')
          const selected = rows.filter(row =>
            Object.entries(match).every(([key, value]) => row[key] === value)
          )
          assert.equal(selected.length, 1, 'Unique fixture row required')
          for (const [key, value] of Object.entries(values))
            assert.deepEqual(selected[0][key], value)
          assertions++
        } else if ('signIn' in step) {
          await m.openLink({ link: 'teamstation://account' })
          await m.scrollUntilVisible({
            element: { text: 'Sign out' },
            timeout: 15000
          })
          await m.tapOn({ text: 'Sign out', timeout: 15000 })
          await signIn(step.signIn)
          assertions++
        } else if ('fontScale' in step) {
          originalFont ??=
            platform === 'ios'
              ? execFileSync(
                  'xcrun',
                  ['simctl', 'ui', device, 'content_size'],
                  { encoding: 'utf8' }
                ).trim()
              : execFileSync(
                  'adb',
                  [
                    '-s',
                    device,
                    'shell',
                    'settings',
                    'get',
                    'system',
                    'font_scale'
                  ],
                  { encoding: 'utf8' }
                ).trim()
          font(
            step.fontScale === 'default'
              ? originalFont
              : platform === 'ios'
                ? 'extra-extra-extra-large'
                : '1.3'
          )
        } else if ('clock' in step) {
          let value: number
          if (step.clock.native === true)
            value = nativePlaybackSeconds(
              (await rawHierarchy()).toString('utf8'),
              platform
            )
          else {
            const nodes = flatten((await m.hierarchy()) as NativeNode)
            const track = selectNode(nodes, {
              text: 'Position in the game'
            }).bounds!
            const times = nodes
              .filter(
                node =>
                  node.bounds != null &&
                  /^\d+:\d{2}$/.test(node.text ?? '') &&
                  Math.abs(node.bounds.y - track.y) < Math.max(80, track.height)
              )
              .sort((a, b) => a.bounds!.x - b.bounds!.x)
            assert.equal(
              times.length,
              2,
              'Visible current and duration clocks required'
            )
            const [minutes, seconds] = times[0].text!.split(':').map(Number)
            value = minutes * 60 + seconds
          }
          if ('save' in step.clock) clocks.set(step.clock.save, value)
          else {
            const before = clocks.get(step.clock.after)
            assert(before != null, 'Prior visible playback clock required')
            assert(
              value - before >= step.clock.min &&
                value - before <= step.clock.max,
              `Playback clock advanced from ${before} to ${value}`
            )
          }
          await note(`${test.id} visible playback clock ${value}s`)
          assertions++
        } else if ('position' in step) {
          const bounds = selectNode(
            flatten((await m.hierarchy()) as NativeNode),
            step.position.target
          ).bounds!
          if ('save' in step.position) positions.set(step.position.save, bounds)
          else {
            const before = positions.get(step.position.matches)
            assert(before != null, 'Prior native position required')
            assert(
              Math.abs(bounds.y - before.y) <= (step.position.tolerance ?? 3),
              'Pinned vertical position unchanged'
            )
          }
          assertions++
        } else if ('geometry' in step) {
          const tree = (await m.hierarchy()) as NativeNode
          const nodes = flatten(tree)
          const target = selectNode(nodes, step.geometry.target).bounds!
          const reference =
            step.geometry.reference == null
              ? viewportOf(tree)
              : selectNode(nodes, step.geometry.reference).bounds!
          assert(reference != null, 'Viewport or reference bounds required')
          const tolerance = step.geometry.tolerance ?? 3
          if (step.geometry.relation === 'centered')
            assert(
              Math.abs(
                target.x + target.width / 2 - reference.x - reference.width / 2
              ) <= tolerance,
              'Centered action'
            )
          else if (step.geometry.relation === 'right')
            assert(
              Math.abs(
                target.x + target.width - reference.x - reference.width
              ) <= tolerance,
              'Right margin alignment'
            )
          else
            assert(
              target.width > 0 &&
                target.height > 0 &&
                target.x >= reference.x &&
                target.y >= reference.y &&
                target.x + target.width <=
                  reference.x + reference.width + tolerance &&
                target.y + target.height <=
                  reference.y + reference.height + tolerance,
              'Target inside viewport'
            )
          assertions++
        } else {
          assert(step.wait > 0 && step.wait <= 10000)
          await new Promise(resolve => setTimeout(resolve, step.wait))
        }
      }
      assert(
        assertions > 0 && captures > 0,
        'Each case requires actual assertion and screenshot proof'
      )
      await note(`${test.id} PASS`)
    }
    assert(!recording, 'Playback recording must be closed before passing')
    await note(`${flow.scenario} PASS`)
    passed = true
  } catch (error) {
    if (m != null) {
      await m
        .screenshot()
        .then(async bytes => {
          await writeFile(
            join(artifacts, `${flow.scenario}-failure.png`),
            bytes
          )
        })
        .catch(() => undefined)
      await m
        .hierarchy()
        .then(async tree => {
          await writeFile(
            join(artifacts, `${flow.scenario}-failure.hierarchy.json`),
            JSON.stringify(tree, null, 2)
          )
        })
        .catch(() => undefined)
      await (m as MaestroHandle & { hierarchyRaw: () => Promise<Buffer> })
        .hierarchyRaw()
        .then(async bytes => {
          await writeFile(
            join(artifacts, `${flow.scenario}-failure.hierarchy.raw`),
            bytes
          )
        })
        .catch(() => undefined)
    }
    await note(
      `${flow.scenario} FAIL: ${error instanceof Error ? error.message : String(error)}`
    )
    throw error
  } finally {
    try {
      if (originalFont != null) font(originalFont)
    } finally {
      if (recording) await stopRecording().catch(() => undefined)
      try {
        await m?.detach()
      } finally {
        try {
          await daemon.shutdown()
        } finally {
          // A caller may keep its one device between N1/N2/N3, but a failed
          // scenario always releases it. The final scenario uses the default.
          if (!passed || process.env.TS_SETTINGS3_KEEP_DEVICE !== '1') {
            if (platform === 'ios')
              execFileSync('xcrun', ['simctl', 'shutdown', device], {
                stdio: 'ignore'
              })
            else
              execFileSync('adb', ['-s', device, 'emu', 'kill'], {
                stdio: 'ignore'
              })
          }
        }
      }
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
