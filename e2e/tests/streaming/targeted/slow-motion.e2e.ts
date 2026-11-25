import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  type Point,
  samples,
  screenshotClocks
} from '../../../../scripts/e2e/holdRelease/frames'
import { measure } from '../../../../scripts/e2e/holdRelease/measure'
import { TeamStationClient } from '../../../../src/common/api'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { appLink, openInApp, setServer } from '../../../rigs/app/setServer'
import { type Fixture, signedIn } from '../../../rigs/playerLayoutsRig'
import { signInSoakSurface } from '../../../rigs/streaming/soakPassword'
import {
  playerBlock,
  readScreen
} from '../../../rigs/streaming/surfaces/hierarchy'
import { decodePng, type Rect } from '../../../rigs/streaming/surfaces/regions'
import { LABELS } from '../../../rigs/streaming/surfaces/surface'

interface TrialLayout {
  block: Rect
  screen: Rect
  tiles: Rect[]
  hold: Point
  next: Point
}

/**
 * Prepare the synthetic playerLayouts fixture on the isolated stack, point
 * TS_PLAYER_FIXTURE at its private manifest and install a test build made
 * with scripts/e2e/holdRelease/install.mjs. The clock and colored controls
 * are read from recorded pixels. For release test builds with a fixed origin,
 * set TS_HOLD_BAKED_ORIGIN to exactly that stack's origin. An isolated install
 * may set TS_HOLD_APP_ID and TS_HOLD_SCHEME. When the hub cannot deliver
 * an atomic tap on iOS, TS_HOLD_GESTURE_RUNNER can name a lease-checked
 * atomic iOS touch driver. Android uses a stationary hub swipe for each hold.
 * The adapter's stdin JSON carries device, hold { x, y }, duration in ms and
 * tap { x, y } or null. Before sending any contacts, the adapter
 * must validate that device's current hub lease (a successful hub hierarchy
 * request against that exact device). Send one down/hold/up, then immediately
 * one contact at tap when supplied. A nonzero exit fails the trial.
 * For the local hub's USB-forwarded iPhone, use the bundled adapter:
 * export TS_HOLD_IOS_DEVICE="$DEVICE"
 * export TS_HOLD_GESTURE_RUNNER="$PWD/scripts/e2e/holdRelease/iosGesture.mjs"
 *
 * npm run -s e2e -- run 'streaming/targeted/slow-motion#release'
 *   --surface ios-app|android-app --stack <id> --device watcher=<leased-id>
 */
export async function release(ctx: E2eContext): Promise<void> {
  const fixturePath = process.env.TS_PLAYER_FIXTURE
  if (fixturePath == null || fixturePath === '')
    throw new Error(
      'Set TS_PLAYER_FIXTURE to this stack’s playerLayouts fixture'
    )
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
  const platform = ctx.surface === 'ios-app' ? 'ios' : 'android'
  const udid = ctx.device('watcher')
  assert.ok(udid.includes('@'), 'select a leased hub device for screen capture')
  const appId = process.env.TS_HOLD_APP_ID ?? 'app.teamstation.develop'
  const scheme = process.env.TS_HOLD_SCHEME ?? 'teamstation-develop'
  const device = await ctx.attach('watcher', { platform, appId })
  const linkDevice: Parameters<typeof setServer>[0]['device'] = {
    stopApp: options => device.stopApp(options),
    launchApp: options => device.launchApp(options),
    tapOn: options => device.tapOn(options),
    assertVisible: options => device.assertVisible(options),
    openLink: ({ link }) =>
      device.openLink({
        link: link.replace(/^teamstation-develop:/, scheme + ':')
      })
  }
  const phone = {
    platform,
    udid,
    appId,
    device: linkDevice,
    hub: true
  } as const
  const baked = process.env.TS_HOLD_BAKED_ORIGIN
  if (baked == null) await setServer({ ...phone, origin: ctx.stack.origin })
  else {
    assert.equal(
      baked,
      ctx.stack.origin,
      'test build must point to the selected stack'
    )
    await device.launchApp({ appId, stopApp: true })
  }
  const baseUrl = ctx.stack.origin + '/api/v1'
  await signInSoakSurface(device, fixture.admin, platform === 'android')
  const token = await signedIn(baseUrl)
  const api = new TeamStationClient({ baseUrl, token })
  const failures: string[] = []
  for (const [kind, game] of [
    ['recorded', fixture.games.S],
    ['live', fixture.games.V]
  ] as const) {
    const ids = game.videos.slice(0, 2)
    assert.equal(ids.length, 2)
    for (const duration of [5000, 30000]) {
      for (const tap of [true, false]) {
        const actual = await api.game(game.id)
        for (const id of ids)
          assert.equal(
            actual.videos.find(v => v.id === id)?.status,
            kind === 'live' ? 'live' : 'ready',
            `expected two ${kind} cameras`
          )
        const link = appLink(
          `games/${game.id}?angles=${ids.join(',')}&audio=${ids[0]}&t=${kind === 'live' ? 10 : 35}`
        )
        await openInApp({ ...phone, link })
        // The sheet can initially expose tile bounds below the screen while
        // animating. Let playback warm up, then verify two consecutive layouts.
        await sleep(4000)
        const layout = async (): Promise<TrialLayout | undefined> => {
          const root = await device.hierarchy()
          const read = readScreen(root)
          const screen = root.bounds ?? read.screen
          // The game page under the full-screen player can be taller than the
          // display, so the player's coverage is judged against the display.
          const block = playerBlock({ ...read, screen })
          if (
            block == null ||
            screen == null ||
            read.tiles.length !== 2 ||
            read.tiles.some(t => t.notice != null) ||
            read.texts.some(t => t.includes('Waiting for the pictures')) ||
            read.texts.includes(LABELS.close) ||
            read.bar != null
          )
            return
          const point = (x: number): Point => ({
            x: Math.round(block.x + block.width * x),
            y: Math.round(block.y + block.height * 0.4)
          })
          const hold = point(0.875)
          const next = point(0.5)
          const centers = read.tiles.map(({ bounds: r }) => ({
            x: r.x + r.width / 2,
            y: r.y + r.height / 2
          }))
          if (
            ![hold, next, ...centers].every(
              p =>
                p.x >= screen.x &&
                p.x < screen.x + screen.width &&
                p.y >= screen.y &&
                p.y < screen.y + screen.height
            )
          )
            return
          return {
            block,
            screen,
            tiles: read.tiles.map(t => t.bounds),
            hold,
            next
          }
        }
        let stable = await layout()
        let previous = ''
        const deadline = Date.now() + 45000
        while (
          (stable == null || JSON.stringify(stable) !== previous) &&
          Date.now() < deadline
        ) {
          previous = JSON.stringify(stable) ?? ''
          await sleep(250)
          stable = await layout()
        }
        assert.ok(
          stable != null && JSON.stringify(stable) === previous,
          'two visible camera tiles must settle inside the viewport'
        )
        const { block, screen, tiles, hold, next } = stable
        const normalized = (p: Point): Point => ({
          x: (p.x - screen.x) / screen.width,
          y: (p.y - screen.y) / screen.height
        })
        const file = ctx.artifact(
          `${platform}-${kind}-${duration}-${tap ? 'tap' : 'resume'}.mp4`
        )
        const capture = spawn(
          process.env.MAESTRO_D_BIN ?? 'maestro-d',
          ['stream', '--device', udid, '--fps', '60', '-o', file],
          { stdio: ['ignore', 'ignore', 'inherit'] }
        )
        const stopped = once(capture, 'close')
        try {
          // Layout alone does not prove the live source has caught up. Read
          // each real camera clock across two consecutive ordinary intervals.
          // All setup and hierarchy calls finish before either measured input.
          const readyBy = Date.now() + 60000
          let prior: { time: number; clocks: number[] } | undefined
          let advancing = 0
          let referenceRates: number[] = []
          while (advancing < 2 && Date.now() < readyBy) {
            await sleep(600)
            assert.equal(
              capture.exitCode,
              null,
              'screen capture must be running'
            )
            if (JSON.stringify(await layout()) !== JSON.stringify(stable)) {
              prior = undefined
              advancing = 0
              continue
            }
            const requested = performance.now()
            const pixels = await device.screenshot()
            const time = (requested + performance.now()) / 2
            const clocks = screenshotClocks(decodePng(pixels), screen, tiles)
            if (clocks.some(c => c == null)) {
              prior = undefined
              advancing = 0
              continue
            }
            const current = clocks as number[]
            const last = prior
            referenceRates =
              last == null
                ? []
                : current.map(
                    (value, i) =>
                      ((value - last.clocks[i]) | 0) / (time - last.time)
                  )
            const ordinary =
              referenceRates.length === 2 &&
              referenceRates.every(rate => rate >= 0.6 && rate <= 1.4)
            advancing = ordinary ? advancing + 1 : 0
            prior = { time, clocks: current }
          }
          assert.equal(
            advancing,
            2,
            'both visible cameras must be advancing at ordinary speed with the catch-up notice and controls cleared before input'
          )
          console.log(
            JSON.stringify({
              platform,
              kind,
              duration,
              screen,
              block,
              hold,
              referenceRates,
              tap: tap ? next : null
            })
          )
          const runner = process.env.TS_HOLD_GESTURE_RUNNER
          if (runner != null && runner !== '' && platform === 'ios') {
            // A leased-device adapter can inject both touches atomically when
            // the hub driver inserts a settle between even batched commands.
            execFileSync(runner, [], {
              input: JSON.stringify({
                device: udid,
                hold,
                duration,
                tap: tap ? next : null
              }),
              timeout: duration + 15000,
              stdio: ['pipe', 'inherit', 'inherit']
            })
          } else {
            const result = await device.run([
              platform === 'android'
                ? {
                    // The endpoints coincide, so the finger stays in the same
                    // zone for the exact duration, including a thirty-second hold.
                    swipe: {
                      startX: hold.x,
                      startY: hold.y,
                      endX: hold.x,
                      endY: hold.y,
                      duration,
                      waitToSettleTimeoutMs: 0
                    }
                  }
                : {
                    tapOnPoint: {
                      ...hold,
                      longPress: true,
                      duration,
                      waitToSettleTimeoutMs: 0,
                      retryTapIfNoChange: false
                    }
                  },
              ...(tap
                ? [
                    {
                      tapOnPoint: {
                        ...next,
                        waitToSettleTimeoutMs: 0,
                        retryTapIfNoChange: false
                      }
                    }
                  ]
                : [])
            ])
            console.log(
              JSON.stringify({
                passed: result.passed,
                failed: result.failed,
                skipped: result.skipped,
                steps: result.results?.map(
                  (step: { type: string; durationMs: number }) => ({
                    type: step.type,
                    durationMs: step.durationMs
                  })
                )
              })
            )
            assert.equal(result.failed, 0, 'hub gesture step failed')
            assert.equal(result.skipped ?? 0, 0, 'hub skipped gesture step')
            assert.equal(
              result.passed,
              tap ? 2 : 1,
              'hub did not perform every gesture'
            )
          }
          // Let the transient controls clear the bottom camera's media clock.
          await sleep(5500)
        } finally {
          capture.kill('SIGINT')
          const [code, signal] = await stopped
          assert.ok(code === 0 || signal === 'SIGINT', 'screen capture failed')
        }
        const frames = await samples(file, screen, tiles)
        try {
          const result = measure(
            frames,
            duration,
            normalized(hold),
            tap ? normalized(next) : undefined
          )
          console.log(JSON.stringify({ platform, kind, ...result }))
        } catch (error) {
          if (!(error instanceof assert.AssertionError)) throw error
          const trial = `${platform}/${kind}/${duration}/${tap ? 'tap' : 'resume'}`
          failures.push(`${trial}: ${error.message}`)
          console.log(JSON.stringify({ trial, failure: error.message }))
        }
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'))
}

export default defineE2e({
  id: 'streaming/targeted/slow-motion',
  title:
    'Multi-camera slow motion releases on the first lift and the next tap pauses immediately',
  kind: 'e2e',
  covers: [
    'e2e/rigs/streaming/**',
    'scripts/e2e/holdRelease/**',
    'src/app/player/multiCam/useMultiCam.ts',
    'src/app/player/multiCam/gridRelease.ts',
    'src/app/player/MultiCamView.native.tsx',
    'src/app/player/VideoView.native.tsx',
    'ios/patches/react-native-video-grid-transport.patch'
  ],
  stack: 'isolated',
  fixtures: [],
  exclusive: true,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'watcher', needs: ['ios-phone'], hardware: 'required' }]
    },
    'android-app': {
      devices: [
        { role: 'watcher', needs: ['android-phone'], hardware: 'required' }
      ]
    }
  },
  services: ['api'],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 12,
  guards: [],
  faults: [],
  manual: false,
  scenarios: { release }
})
