import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import {
  cancelRunner,
  center,
  collinear,
  DEFENDERS,
  dragRunner,
  fieldAndTrajectory,
  fieldGeometry,
  flatten,
  gesture,
  loadBases,
  MULTI_POINT,
  openPhoneScorer,
  type PhoneScorer,
  phoneScorer,
  tapInSheet,
  withPhoneScorer
} from './phoneWebScorer'

const FIELD = { x: 0, y: 100, width: 390, height: 600 }

/** A phone that records every command and answers from `tree` and `script`. */
function fakePhone(
  tree: any,
  script: { visible?: (text: string) => boolean } = {}
): { m: any; steps: Array<[string, unknown]> } {
  const steps: Array<[string, unknown]> = []
  const record =
    (name: string) =>
    async (options: unknown): Promise<void> => {
      steps.push([name, options])
    }
  const m = {
    hierarchy: async () => tree,
    tapOnPoint: record('tapOnPoint'),
    dragAndDrop: record('dragAndDrop'),
    swipe: record('swipe'),
    tapOn: record('tapOn'),
    assertNotVisible: record('assertNotVisible'),
    takeScreenshot: record('takeScreenshot'),
    setOrientation: record('setOrientation'),
    stopApp: record('stopApp'),
    launchApp: record('launchApp'),
    openLink: record('openLink'),
    scrollUntilVisible: record('scrollUntilVisible'),
    assertVisible: async (options: { text: string }) => {
      steps.push(['assertVisible', options])
      if (script.visible != null && !script.visible(options.text))
        throw new Error(`not visible: ${options.text}`)
    }
  }
  return { m, steps }
}

function fakeCtx(
  runDir: string,
  m: any,
  ids: Record<string, string> = { game1: 'gam_1' }
): any {
  const calls: string[] = []
  return {
    calls,
    surface: 'web-safari-ios',
    runDir,
    artifact: (name: string) => join(runDir, name),
    stack: {
      origin: 'https://stack.example.test/',
      control: {
        rateLimits: async () => {
          calls.push('rateLimits')
        }
      }
    },
    fixture: async (name: string) => {
      calls.push(`fixture ${name}`)
      return { world: name, nonce: 'n', accounts: {}, ids }
    },
    mobileBrowser: async (role: string, url: string) => {
      calls.push(`mobileBrowser ${role} ${url}`)
      return m
    },
    signIn: async (role: string) => {
      calls.push(`signIn ${role}`)
    }
  }
}

const TREE = {
  text: 'root',
  children: [
    { text: 'Baseball field. Tap a player', bounds: FIELD },
    {
      text: 'More',
      enabled: false,
      bounds: { x: 1, y: 1, width: 2, height: 2 }
    },
    {
      text: 'More',
      bounds: { x: 10, y: 20, width: 30, height: 40 },
      children: [{ text: 'OK' }]
    }
  ]
}

describe('phoneWebScorer', () => {
  it('flattens a tree and finds a centre', () => {
    expect(flatten(undefined)).deep.equals([])
    expect(flatten(TREE).map(n => n.text)).deep.equals([
      'root',
      'Baseball field. Tap a player',
      'More',
      'More',
      'OK'
    ])
    expect(center({ x: 10, y: 20, width: 30, height: 40 })).deep.equals({
      x: 25,
      y: 40
    })
    expect(DEFENDERS['1B']).to.have.keys(['x', 'z'])
  })

  it('tells a straight path from one that turns or goes back', () => {
    expect(
      collinear([
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 10 }
      ])
    ).equals(true)
    expect(
      collinear([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ])
    ).equals(false)
    expect(
      collinear([
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 2, y: 0 },
        { x: 10, y: 0 }
      ])
    ).equals(false)
    expect(
      collinear([
        { x: 3, y: 3 },
        { x: 3, y: 3 }
      ])
    ).equals(true)
    expect(
      collinear([
        { x: 3, y: 3 },
        { x: 4, y: 9 },
        { x: 3, y: 3 }
      ])
    ).equals(false)
  })

  it('draws taps, held drags and swipes, and blocks a turning path', async () => {
    const { m, steps } = fakePhone(TREE)
    await gesture(m, [{ x: 1.4, y: 2.6 }], 80)
    await gesture(m, [
      { x: 0, y: 0 },
      { x: 10, y: 10, duration: 300 }
    ])
    await gesture(
      m,
      [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 10 }
      ],
      0
    )
    expect(steps).deep.equals([
      ['tapOnPoint', { x: 1, y: 3 }],
      [
        'dragAndDrop',
        {
          from: { point: '0,0' },
          to: { point: '10,10' },
          holdDuration: 500,
          duration: 300
        }
      ],
      ['swipe', { startX: 0, startY: 0, endX: 10, endY: 10, duration: 1700 }]
    ])
    let blocked: unknown
    try {
      await gesture(m, [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ])
    } catch (error) {
      blocked = error
    }
    expect(blocked).instanceOf(BlockedError)
    expect((blocked as Error).message).equals(MULTI_POINT)
  })

  it('projects the field through its camera and places the runner targets', () => {
    const g = fieldGeometry(FIELD)
    const home = g.project(0, 0)
    const second = g.project(0, -38.8, 6)
    expect(home.x).closeTo(195, 1)
    expect(second.y).lessThan(home.y)
    const targets = g.targets(2)
    expect(targets).to.have.keys(['safe', 'out'])
    expect(Number.isFinite(targets.safe.x)).equals(true)
  })

  it('opens fresh games, signs out an earlier session and keeps its screens', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'phone-scorer-'))
    let signedIn = true
    const { m, steps } = fakePhone(TREE, {
      visible: text => (text !== 'Sign in to TeamStation' ? true : !signedIn)
    })
    m.tapOn = async (options: any) => {
      steps.push(['tapOn', options])
      if (options.text === 'Sign out') signedIn = false
    }
    const ctx = fakeCtx(runDir, m, { game1: 'gam_1', game2: 'gam_2' })
    const scorer = await openPhoneScorer(ctx)
    expect(ctx.calls).deep.equals([
      'fixture scoring-preview',
      'rateLimits',
      'mobileBrowser browser https://stack.example.test/account',
      'signIn scorer'
    ])
    expect(await scorer.find(/^More$/)).deep.equals({
      x: 10,
      y: 20,
      width: 30,
      height: 40
    })
    let missing: unknown
    await scorer.find(/^Absent$/).catch((error: unknown) => {
      missing = error
    })
    expect(String(missing)).contains('Missing visible control')
    await scorer.tap('More')
    await scorer.visible('Ball')
    await scorer.absent('Balk')
    await scorer.touch({ x: 4, y: 5 })
    await scorer.gesture([
      { x: 0, y: 0 },
      { x: 0, y: 9 }
    ])
    await scorer.orient('landscape')
    expect((await scorer.geometry()).field).deep.equals(FIELD)
    expect(await scorer.freshGame({ restart: true })).equals('gam_1')
    expect(await scorer.freshGame({ dismiss: false })).equals('gam_2')
    let none: unknown
    await scorer.freshGame().catch((error: unknown) => {
      none = error
    })
    expect(String(none)).contains('no game 3')
    await scorer.shot('ready')
    scorer.log('done')
    scorer.finish()
    expect(readFileSync(join(runDir, 'steps.txt'), 'utf8')).equals(
      'Captured ready\ndone\n'
    )
    expect(
      JSON.parse(readFileSync(join(runDir, '01-ready.json'), 'utf8')).text
    ).equals('root')
    const names = steps.map(([name]) => name)
    expect(names).includes('scrollUntilVisible')
    expect(steps).deep.includes([
      'openLink',
      { link: 'https://stack.example.test/games/gam_1/score', browser: true }
    ])
    expect(steps).deep.includes([
      'stopApp',
      { appId: 'com.apple.mobilesafari' }
    ])
    expect(steps).deep.includes([
      'tapOn',
      { text: '^OK$', enabled: true, timeout: 10000 }
    ])
  })

  it('keeps a failure screen and the steps when a scenario fails', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'phone-scorer-'))
    const { m } = fakePhone(TREE)
    m.scrollUntilVisible = async () => {
      throw new Error('no Sign out yet')
    }
    // Never signed out: three looks, then the form is opened anyway.
    const signedInPhone = fakePhone(TREE, {
      visible: text => text !== 'Sign in to TeamStation'
    })
    signedInPhone.m.scrollUntilVisible = m.scrollUntilVisible
    const ctx = fakeCtx(runDir, signedInPhone.m)
    let failed: unknown
    await withPhoneScorer(ctx, async scorer => {
      scorer.log('started')
      throw new Error('broken step')
    }).catch((error: unknown) => {
      failed = error
    })
    expect(String(failed)).contains('broken step')
    expect(readFileSync(join(runDir, 'steps.txt'), 'utf8')).equals(
      'started\nCaptured failure\n'
    )
    await withPhoneScorer(ctx, async scorer => {
      scorer.log('passed')
    })
    expect(readFileSync(join(runDir, 'steps.txt'), 'utf8')).equals('passed\n')
    const direct = phoneScorer(
      ctx,
      m,
      { world: 'w', nonce: 'n', accounts: {}, ids: {} },
      'https://o.example.test'
    )
    expect(direct.m).equals(m)
  })

  it('places a fielder, drags and cancels runners, and scrolls sheet rows into view', async () => {
    const done: string[] = []
    let rowY = 900
    const fake = {
      geometry: async () => fieldGeometry(FIELD),
      visible: async (text: string) => {
        done.push(`visible ${text}`)
      },
      absent: async (text: string) => {
        done.push(`absent ${text}`)
      },
      tap: async (text: string) => {
        done.push(`tap ${text}`)
      },
      shot: async (label: string) => {
        done.push(`shot ${label}`)
      },
      touch: async (point: { x: number; y: number }) => {
        done.push(`touch ${Math.round(point.y)}`)
      },
      gesture: async (points: unknown[]) => {
        done.push(`gesture ${points.length}`)
        rowY = 400
      },
      find: async () => ({ x: 0, y: 10, width: 20, height: 20 }),
      nodes: async () => [
        { text: 'Hidden', bounds: { x: 0, y: 900, width: 10, height: 10 } },
        ...['First base', 'Second base', 'Third base', 'Apply Override']
          .concat(
            ['Player 6', 'Player 7', 'Player 8'].flatMap(name =>
              ['First base', 'Second base', 'Third base'].map(
                base => `Choose ${base} ${name}`
              )
            )
          )
          .map(text => ({
            text,
            bounds: { x: 0, y: rowY, width: 10, height: 10 }
          }))
      ]
    } as unknown as PhoneScorer
    await fieldAndTrajectory(fake)
    await dragRunner(fake, 1, 'out')
    await cancelRunner(fake)
    await loadBases(fake)
    expect(done.slice(0, 5)).deep.equals([
      'visible Tap or drag a player to where the ball was fielded',
      'gesture 2',
      'visible Drag up and down for ball trajectory',
      'shot trajectory-before-movement',
      'shot trajectory-still-waiting'
    ])
    expect(done).includes('touch 20')
    expect(done).includes('touch 405')
    expect(done).includes('tap Overrides')
    let missing: unknown
    await tapInSheet(fake, 'Nowhere').catch((error: unknown) => {
      missing = error
    })
    expect(String(missing)).contains('Missing sheet row Nowhere')
    let stuck: unknown
    await tapInSheet(fake, 'Hidden').catch((error: unknown) => {
      stuck = error
    })
    expect(String(stuck)).contains('Cannot scroll to sheet row Hidden')
  })
})
