import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fixture, noSleep, png } from './fakes.test'
import {
  ndiCapture,
  parseTvDump,
  remoteHelper,
  tvHierarchy,
  TvSurface
} from './tv'

const DUMP = fixture('tvDump.txt')

function moveFocus(dump: string, label: string): string {
  return dump
    .replace(', Focused', '')
    .replace(`label: '${label}'`, `label: '${label}', Focused`)
}

describe('the TV surface', function () {
  it('parses the accessibility dump: frames, labels, values and focus', function () {
    const elements = parseTvDump(DUMP)
    expect(elements[0]).deep.include({
      type: 'Application',
      label: 'TeamStation TV',
      bounds: null
    })
    const slider = elements.find(e => e.type === 'Slider')!
    expect(slider.value).equals('25%')
    expect(slider.bounds).deep.equals({
      x: 100,
      y: 1000,
      width: 1720,
      height: 20
    })
    expect(elements.find(e => e.focused)!.label).equals('PhoneA')
    expect(
      elements.find(e => e.identifier === 'camera-Synthetic')!.label
    ).equals('Synthetic')
    expect(elements.at(-1)!.label).equals("It's live")
    const hierarchy = tvHierarchy([
      ...elements,
      {
        type: 'Other',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        identifier: null,
        label: null,
        value: '7',
        focused: false
      }
    ])
    expect(hierarchy.children!.map(child => child.text)).includes(
      'Position in the game, 25%'
    )
    expect(hierarchy.children!.at(-1)!.text).equals('7')
  })

  function tv(options: { dump?: () => string; captures?: Uint8Array[] } = {}): {
    surface: TvSurface
    runs: string[][]
  } {
    const runs: string[][] = []
    let dump = DUMP
    let shot = 0
    const captures = options.captures ?? [
      png(1920, 1080),
      png(1920, 1080, [{ x: 0, y: 0, width: 960, height: 540 }])
    ]
    const surface = new TvSurface({
      remote: async steps => {
        // A dump names the app first; the join's own app step is kept.
        runs.push(
          steps.at(-1) === 'dump'
            ? steps.filter(step => !step.startsWith('app:'))
            : steps
        )
        const move = steps.find(step =>
          ['left', 'right', 'up', 'down'].includes(step)
        )
        if (move === 'right' && dump.includes("label: 'PhoneA', Focused"))
          dump = moveFocus(dump, 'PhoneB')
        else if (move === 'right' && dump.includes("label: 'PhoneB', Focused"))
          dump = moveFocus(dump, 'Synthetic')
        else if (
          move === 'down' &&
          dump.includes("label: 'Synthetic', Focused")
        )
          dump = moveFocus(dump, 'Jump to present')
        return steps.includes('dump') ? (options.dump?.() ?? dump) : ''
      },
      capture: async () => captures[shot++ % captures.length],
      bundleId: 'app.example.tv',
      appName: 'TeamStation TV',
      joinSteps: ['select', 'wait:3', 'select'],
      sleep: noSleep
    })
    return { surface, runs }
  }

  it('probes tiles from two NDI captures and the dump', async function () {
    const { surface } = tv()
    const probe = await surface.probe()
    expect(probe.tiles).deep.equals([
      { angle: 'PhoneA', advancing: true, notice: null },
      { angle: 'PhoneB', advancing: false, notice: null },
      { angle: 'Synthetic', advancing: false, notice: 'Camera catching up…' }
    ])
    expect(probe.bar).equals(0.25)
    expect(probe.foreground).equals(true)
    const other = tv({ dump: () => DUMP.replace(/TeamStation TV/g, 'Home') })
    expect((await other.surface.probe()).foreground).equals(false)
    const empty = tv({ dump: () => '' })
    expect(await empty.surface.probe()).deep.equals({
      tiles: null,
      bar: null,
      foreground: null,
      reason: 'tv: empty dump'
    })
    // No picture: the dump's tiles, notices and bar, with movement unknown.
    const broken = tv({ captures: [new Uint8Array([1, 2, 3])] })
    const blind = await broken.surface.probe()
    expect(blind.reason).match(/^tv: no picture: /)
    expect(blind.tiles).deep.equals([
      { angle: 'PhoneA', advancing: null, notice: null },
      { angle: 'PhoneB', advancing: null, notice: null },
      { angle: 'Synthetic', advancing: null, notice: 'Camera catching up…' }
    ])
    expect(blind.bar).equals(0.25)
    expect(blind.foreground).equals(true)
    const gone = new TvSurface({
      remote: async () => {
        throw new Error('helper failed')
      },
      capture: async () => png(1, 1),
      bundleId: 'app.example.tv',
      appName: 'TeamStation TV',
      joinSteps: [],
      sleep: noSleep
    })
    expect(await gone.probe()).deep.equals({
      tiles: null,
      bar: null,
      foreground: null,
      reason: 'tv: helper failed'
    })
  })

  it('cuts by moving the focus to the angle in the camera panel and selecting it', async function () {
    const { surface, runs } = tv()
    await surface.cut('Synthetic')
    expect(runs).deep.equals([
      ['dump'],
      ['right', 'wait:0.5', 'dump'],
      ['right', 'wait:0.5', 'dump'],
      ['select']
    ])
    runs.length = 0
    await surface.jumpToPresent()
    expect(runs).deep.equals([
      ['dump'],
      ['down', 'wait:0.5', 'dump'],
      ['select']
    ])
  })

  it('says when it cannot find or reach a control', async function () {
    const { surface } = tv()
    expect(
      await surface.focusAndSelect('Nowhere').then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/no "Nowhere"/)
    const stuck = tv({ dump: () => DUMP.replace(', Focused', '') })
    expect(
      await stuck.surface.focusAndSelect('PhoneB').then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/could not reach/)
  })

  it('joins, scrubs, skips, slows, exits and relaunches with the remote', async function () {
    const { surface, runs } = tv()
    await surface.join()
    expect(runs[0]).deep.equals([
      'app:app.example.tv',
      'wait:3',
      'select',
      'wait:3',
      'select'
    ])
    runs.length = 0
    await surface.scrub(0.75)
    expect(runs).deep.equals([['dump'], Array(10).fill('right')])
    runs.length = 0
    await surface.scrub(0.25)
    expect(runs).deep.equals([['dump']])
    runs.length = 0
    await surface.rapidScrub([0, 0.25])
    expect(runs).deep.equals([['dump'], Array(5).fill('left'), ['dump']])
    runs.length = 0
    await surface.skip()
    expect(runs).deep.equals([['left', 'left', 'left', 'right', 'right']])
    runs.length = 0
    await surface.slowMotion(8000)
    expect(runs).deep.equals([['left', 'wait:8', 'right']])
    runs.length = 0
    const exit = tv({
      dump: () =>
        DUMP.replace(
          "label: 'Jump to present'",
          "label: 'All angles', Focused"
        ).replace("label: 'PhoneA', Focused", "label: 'PhoneA'")
    })
    await exit.surface.exitAndReenter(1)
    expect(exit.runs).deep.equals([['menu'], ['dump'], ['select']])
    await surface.relaunch()
    expect(runs[0]).deep.equals(['home', 'wait:2'])
    const noBar = tv({ dump: () => DUMP.replace(/, value: 25%/, '') })
    await noBar.surface.scrub(1)
    expect(noBar.runs[1]).length(10)
  })

  it('runs the remote helper and the NDI capture as commands', async function () {
    const execs: Array<[string, string[], Record<string, unknown>]> = []
    const exec = async (
      command: string,
      args: string[],
      options: { env?: Record<string, string | undefined> }
    ): Promise<{ stdout: string }> => {
      execs.push([command, args, options])
      return { stdout: 'dumped' }
    }
    const remote = remoteHelper(
      {
        command: ['python3', '/opt/tv/remote.py'],
        env: { TV_DEVICE_UDID: 'example-device-udid' }
      },
      exec
    )
    expect(await remote(['select', 'dump'])).equals('dumped')
    expect(execs[0][0]).equals('python3')
    expect(execs[0][1]).deep.equals(['/opt/tv/remote.py', 'select', 'dump'])
    expect((execs[0][2].env as Record<string, string>).TV_DEVICE_UDID).equals(
      'example-device-udid'
    )
    const logged = remoteHelper(
      { command: ['python3', '/opt/tv/remote.py'], env: {} },
      async () => ({
        stdout:
          '{"project": "/t/p", "log": "/t/p/remote.log"}\nRemote command completed.\n'
      }),
      path => `log of ${path}`
    )
    expect(await logged(['dump'])).equals('log of /t/p/remote.log')
    const frame = new Uint8Array([9])
    const capture = ndiCapture(
      { command: ['ndi-capture', '--out', '{out}'], out: '/tmp/frame.png' },
      exec,
      path => {
        expect(path).equals('/tmp/frame.png')
        return frame
      }
    )
    expect(await capture()).equals(frame)
    expect(execs[1]).deep.equals([
      'ndi-capture',
      ['--out', '/tmp/frame.png'],
      {}
    ])
  })

  it("reads the helper's log, whose lines end in CR LF", function () {
    const log =
      "Test Case started.\r\n    Button, 0x1, {{1680.0, 26.0}, {164.0, 64.0}}, identifier: 'tv-sign-out', label: 'Sign out'\r\n"
    expect(parseTvDump(log)).deep.equals([
      {
        type: 'Button',
        bounds: { x: 1680, y: 26, width: 164, height: 64 },
        identifier: 'tv-sign-out',
        label: 'Sign out',
        value: null,
        focused: false
      }
    ])
  })
})
