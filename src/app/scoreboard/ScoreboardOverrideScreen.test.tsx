import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type DashboardOverrides,
  NO_OVERRIDES,
  SAMPLE_SCOREBOARD,
  type ScoreboardState
} from '../../common/scoreboard'
import { fakeClock, fakeSockets } from '../../test/fakeScoreboardSocket'
import { ThemeProvider } from '../theme/ThemeContext'
import { ScoreboardOverrideScreen } from './ScoreboardOverrideScreen'
import { RECONNECT_MS } from './scoreboardSocket'

let root: Root | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

const automated: ScoreboardState = {
  ...SAMPLE_SCOREBOARD,
  balls: 1,
  strikes: 0,
  outs: 0,
  base1: true,
  base2: false,
  base3: false,
  homeScore: 0,
  awayScore: 0,
  inning: 1,
  half: 'top'
}

function state(overrides: DashboardOverrides = NO_OVERRIDES): object {
  return {
    type: 'state',
    automated,
    overrides,
    final: automated,
    gameAt: null,
    watcherAt: null
  }
}

async function dashboard(
  options: { load?: boolean; token?: string } = {}
): Promise<{
  sockets: ReturnType<typeof fakeSockets>
  clock: ReturnType<typeof fakeClock>
  signIns: string[]
  sent: () => unknown[]
}> {
  const sockets = fakeSockets()
  const clock = fakeClock()
  const signIns: string[] = []
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ScoreboardOverrideScreen
          apiBaseUrl="/api/v1"
          gameId="g1"
          origin={{ protocol: 'https:', host: 'app.teamstation.app' }}
          onSignIn={next => signIns.push(next)}
          token={options.token}
          WebSocketImpl={sockets.Impl}
          schedule={clock.schedule}
        />
      </ThemeProvider>
    )
  })
  if (options.load !== false) await receive(sockets, state())
  return { sockets, clock, signIns, sent: () => sockets.latest().messages() }
}

async function receive(
  sockets: ReturnType<typeof fakeSockets>,
  message: object
): Promise<void> {
  await act(async () => {
    if (sockets.latest().readyState !== 1) sockets.latest().open()
    sockets.latest().receive(message)
  })
}

function node(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (found == null) throw new Error(`no ${label}`)
  return found
}
async function tap(label: string): Promise<void> {
  await act(async () => {
    node(label).click()
  })
}
function byTestId(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (found == null) throw new Error(`no ${id}`)
  return found
}
const tile = (group: string): HTMLElement => byTestId(`override-tile-${group}`)
const background = (id: string): string =>
  getComputedStyle(byTestId(id)).backgroundColor
const colour = (id: string): string => getComputedStyle(byTestId(id)).color

// 1.0's tsDark, as the browser reports it.
const PAGE = 'rgb(31, 36, 24)' // tsVeryDarkGreen #1F2418
const CARD = 'rgb(61, 78, 47)' // tsDarkOlive #3D4E2F
const OVERRIDE_COLOUR = 'rgb(107, 142, 78)' // tsMediumOlive #6B8E4E
const BEIGE = 'rgb(232, 228, 216)' // tsBeige #E8E4D8
const PALE_GREEN = 'rgb(196, 212, 184)' // tsPaleGreen #C4D4B8
const BALL = 'rgb(34, 197, 94)' // #22c55e
const BALL_DARKENED = 'rgb(23, 137, 65)' // #22c55e × 0.7
const OUTER_OFF = 'rgb(85, 85, 85)' // #555
const OUTER_UNSET = 'rgb(74, 74, 74)' // #4a4a4a
const INNER_EMPTY = 'rgb(42, 42, 42)' // #2a2a2a
const RED = 'rgb(239, 68, 68)' // coralRed #ef4444
const DARK_BASE_RED = 'rgb(128, 16, 16)' // crimsonRed #801010
const lastSent = (sent: () => unknown[]): any => sent().at(-1)

/**
 * Holds a finger on `label` long enough to be a long press, as on an iPad.
 *
 * A touch rather than the mouse: react-native-web ignores a mousedown while
 * it thinks the mouse events are a touch's echo, which an earlier suite's
 * touches can leave it thinking.
 */
async function longPress(
  label: string,
  at: { x: number; y: number }
): Promise<void> {
  const target = node(label)
  const point = {
    identifier: 1,
    clientX: at.x,
    clientY: at.y,
    pageX: at.x,
    pageY: at.y
  }
  const touch = (type: string, touches: object[]): Event => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: touches },
      changedTouches: { value: [point] }
    })
    return event
  }
  await act(async () => {
    target.dispatchEvent(touch('touchstart', [point]))
    await new Promise(resolve => setTimeout(resolve, 600))
  })
  await act(async () => {
    target.dispatchEvent(touch('touchend', []))
    // Complete the browser's emulated mouse sequence after this touch.
    // Otherwise RN web ignores the next test's first real mouse drag.
    document.dispatchEvent(touch('mouseup', []))
  })
}

describe('ScoreboardOverrideScreen', function () {
  it('signs its socket in with the session it is given, as a phone must', async function () {
    const { sockets } = await dashboard({ load: false, token: 'tok_phone' })
    expect(sockets.latest().url).equals(
      'wss://app.teamstation.app/api/v1/scoreboard/g1/dashboard'
    )
    expect(sockets.latest().headers).deep.equals({
      Authorization: 'Bearer tok_phone'
    })
  })

  it('connects at once and shows a spinner until the first state', async function () {
    const { sockets } = await dashboard({ load: false })
    expect(sockets.latest().url).equals(
      'wss://app.teamstation.app/api/v1/scoreboard/g1/dashboard'
    )
    expect(document.body.textContent).includes('Connecting to the scoreboard')
    await receive(sockets, state())
    expect(node('Add a ball')).not.equals(null)
  })

  it('tapping B sends the count group on, one ball up, and again', async function () {
    const { sent } = await dashboard()
    await tap('Add a ball')
    expect(lastSent(sent)).deep.equals({
      type: 'overrides',
      data: {
        ...NO_OVERRIDES,
        overrideCountEnabled: true,
        overrideCount: { balls: 2, strikes: 0, outs: 0 }
      }
    })
    await tap('Add a ball')
    expect(lastSent(sent).data.overrideCount.balls).equals(3)
    await tap('Add a strike')
    await tap('Add an out')
    expect(lastSent(sent).data.overrideCount).deep.equals({
      balls: 3,
      strikes: 1,
      outs: 1
    })
    await tap('Clear balls')
    expect(lastSent(sent).data.overrideCount.balls).equals(0)
    await tap('Clear strikes')
    await tap('Clear outs')
    expect(lastSent(sent).data.overrideCount).deep.equals({
      balls: 0,
      strikes: 0,
      outs: 0
    })
  })

  it('the count tile’s ✕ turns the group off', async function () {
    const { sent } = await dashboard()
    await tap('Add a ball')
    await tap('Revert count')
    expect(lastSent(sent)).deep.equals({
      type: 'overrides',
      data: { ...NO_OVERRIDES, overrideCountEnabled: false }
    })
  })

  it('draws in 1.0’s dark greens, and an overridden tile in the override colour', async function () {
    await dashboard()
    expect(background('override-dashboard')).equals(PAGE)
    for (const group of [
      'count',
      'bases',
      'inning',
      'team-home',
      'score-away'
    ]) {
      expect(background(`override-tile-${group}`), group).not.equals(
        OVERRIDE_COLOUR
      )
    }
    expect(background('override-tile-count')).equals(CARD)
    expect(background('override-tile-bases')).equals(CARD)
    expect(background('override-tile-inning')).equals(CARD)
    expect(background('override-tile-score-home')).equals(PAGE)
    expect(colour('automated-score-home')).equals(PALE_GREEN)
    await tap('Add a ball')
    expect(getComputedStyle(tile('count')).backgroundColor).equals(
      OVERRIDE_COLOUR
    )
    expect(background('override-tile-bases')).equals(CARD)
    await tap('Home score')
    expect(background('override-tile-score-home')).equals(OVERRIDE_COLOUR)
    expect(background('override-tile-score-away')).equals(OVERRIDE_COLOUR)
    // The server's score, in the corner, turns from pale green to beige.
    expect(colour('automated-score-home')).equals(BEIGE)
    expect(byTestId('automated-score-home').textContent).equals('0')
  })

  it('draws the server’s count as inner circles, darkened while overridden', async function () {
    await dashboard()
    // Not overridden: grey rims, the server's one ball in green inside.
    expect(background('count-balls-0')).equals(OUTER_OFF)
    expect(background('inner-balls-0')).equals(BALL)
    expect(background('inner-balls-1')).equals(INNER_EMPTY)
    await tap('Add a ball')
    await tap('Add a ball')
    // B twice: three green rims over the server's one ball, darkened.
    for (const index of [0, 1, 2]) {
      expect(background(`count-balls-${index}`)).equals(BALL)
    }
    expect(background('inner-balls-0')).equals(BALL_DARKENED)
    expect(background('inner-balls-1')).equals(INNER_EMPTY)
    expect(background('count-strikes-0')).equals(OUTER_UNSET)
  })

  it('draws the server’s bases as inner diamonds, darkened while overridden', async function () {
    await dashboard()
    // Not overridden: the server's runner on first as a red inner diamond.
    expect(background('inner-base1')).equals(RED)
    expect(document.querySelector('[data-testid="inner-base2"]')).equals(null)
    expect(background('base-base1')).not.equals(RED)
    await tap('Second base')
    // First is still held, and shown dark red inside; second has no server
    // runner, so its inner diamond is the card's olive.
    expect(background('base-base1')).equals(RED)
    expect(background('inner-base1')).equals(DARK_BASE_RED)
    expect(background('base-base2')).equals(RED)
    expect(background('inner-base2')).equals(CARD)
    expect(background('override-tile-bases')).equals(OVERRIDE_COLOUR)
  })

  it('adds one to a tapped score or inning, as 1.0 did', async function () {
    const { sent } = await dashboard()
    await tap('Home score')
    await tap('Home score')
    expect(lastSent(sent).data).deep.include({
      overrideScoreEnabled: true,
      overrideScore: { homeScore: 2, awayScore: 0 }
    })
    await tap('Away score')
    expect(lastSent(sent).data.overrideScore).deep.equals({
      homeScore: 2,
      awayScore: 1
    })
    await tap('Inning')
    expect(lastSent(sent).data).deep.include({
      overrideInningEnabled: true,
      overrideInning: { inning: 2, half: 'top' }
    })
    expect(document.querySelector('[data-testid="override-picker"]')).equals(
      null
    )
  })

  it('opens the number picker where a score was long-pressed', async function () {
    const { sent } = await dashboard()
    const before = sent().length
    await longPress('Home score', { x: 300, y: 400 })
    // A long press only opens the picker: it adds nothing.
    expect(sent()).length(before)
    const picker = byTestId('override-picker')
    expect(picker.style.left).equals('250px')
    expect(node('Pick 0')).not.equals(null)
    expect(node('Pick 20')).not.equals(null)
    await tap('Pick 9')
    expect(lastSent(sent).data).deep.include({
      overrideScoreEnabled: true,
      overrideScore: { homeScore: 9, awayScore: 0 }
    })
    expect(document.querySelector('[aria-label="Pick 9"]')).equals(null)
    await longPress('Away score', { x: 300, y: 400 })
    await tap('Close the picker')
    expect(document.querySelector('[aria-label="Pick 1"]')).equals(null)
    await longPress('Away score', { x: 300, y: 400 })
    await tap('Pick 4')
    expect(lastSent(sent).data.overrideScore).deep.equals({
      homeScore: 9,
      awayScore: 4
    })
  })

  it('opens the picker on a long-pressed inning, from 1', async function () {
    const { sent } = await dashboard()
    await longPress('Inning', { x: 120, y: 500 })
    expect(byTestId('override-picker').style.left).equals('70px')
    expect(document.querySelector('[aria-label="Pick 0"]')).equals(null)
    await tap('Pick 6')
    expect(lastSent(sent).data).deep.include({
      overrideInningEnabled: true,
      overrideInning: { inning: 6, half: 'top' }
    })
  })

  it('sends a tapped base and the inning arrows as their groups, and each ✕ reverts', async function () {
    const { sent } = await dashboard()
    await tap('Second base')
    expect(lastSent(sent).data).deep.include({
      overrideBasesEnabled: true,
      overrideBases: { base1: true, base2: true, base3: false }
    })
    await tap('Bottom of the inning')
    expect(lastSent(sent).data).deep.include({
      overrideInningEnabled: true,
      overrideInning: { inning: 1, half: 'bottom' }
    })
    await tap('Top of the inning')
    expect(lastSent(sent).data.overrideInning.half).equals('top')
    await tap('Top of the inning')
    expect(lastSent(sent).data.overrideInning.half).equals('mid')
    await tap('Home score')
    for (const label of [
      'Revert score',
      'Revert inning',
      'Revert bases',
      'Revert team names'
    ]) {
      await tap(label)
    }
    expect(lastSent(sent).data).deep.equals({
      ...NO_OVERRIDES
    })
  })

  it('sends a typed team name as the team group', async function () {
    const { sent } = await dashboard()
    await act(async () => {
      const input = node('Away team name') as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'OWLS')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    expect(lastSent(sent).data).deep.include({
      overrideTeamEnabled: true,
      overrideTeam: { homeTeam: 'PIONEERS', awayTeam: 'OWLS' }
    })
    expect((node('Away team name') as HTMLInputElement).value).equals('OWLS')
    expect((node('Home team name') as HTMLInputElement).value).equals(
      'PIONEERS'
    )
    expect(background('override-tile-team-away')).equals(OVERRIDE_COLOUR)
    expect(byTestId('automated-team-away').textContent).equals('VISITORS')
  })

  it('Reset sends reset', async function () {
    const { sent } = await dashboard()
    await tap('Add a ball')
    await tap('Reset Game State')
    expect(lastSent(sent)).deep.equals({ type: 'reset' })
    expect(getComputedStyle(tile('count')).backgroundColor).not.equals(
      OVERRIDE_COLOUR
    )
  })

  it('keeps its own overrides until their echo, then takes the server’s', async function () {
    const { sockets } = await dashboard()
    await tap('Add a ball')
    const echo = {
      ...NO_OVERRIDES,
      overrideCountEnabled: true,
      overrideCount: { balls: 2, strikes: 0, outs: 0 }
    }
    // Another source's change lands before the echo: the tap stands.
    await receive(sockets, state())
    expect(getComputedStyle(tile('count')).backgroundColor).equals(
      OVERRIDE_COLOUR
    )
    await receive(sockets, state(echo))
    // Another dashboard reverts it: now the server's word is taken.
    await receive(sockets, state())
    expect(getComputedStyle(tile('count')).backgroundColor).not.equals(
      OVERRIDE_COLOUR
    )
  })

  it('stops waiting for an echo the server refused', async function () {
    const { sockets } = await dashboard()
    await tap('Add a ball')
    await receive(sockets, { error: 'unreadable' })
    await receive(sockets, state())
    expect(getComputedStyle(tile('count')).backgroundColor).not.equals(
      OVERRIDE_COLOUR
    )
  })

  for (const code of [4403, 4404]) {
    it(`shows the branded 404 on ${code}`, async function () {
      const { sockets, clock } = await dashboard({ load: false })
      await act(async () => {
        sockets.latest().drop(code)
      })
      expect(document.body.textContent).includes("This scoreboard isn't live")
      clock.advance(60_000)
      expect(sockets.sockets).length(1)
    })
  }

  it('sends a signed-out visitor to sign in, to come back here', async function () {
    const { sockets, signIns } = await dashboard()
    await act(async () => {
      sockets.latest().drop(4401)
    })
    expect(signIns).deep.equals(['/games/g1/scoreboard-override'])
  })

  it('retries a 1006 before the first state after 3 s', async function () {
    const { sockets, clock } = await dashboard({ load: false })
    await act(async () => {
      sockets.latest().drop(1006)
    })
    expect(document.body.textContent).includes('Connecting to the scoreboard')
    await act(async () => {
      clock.advance(RECONNECT_MS)
    })
    expect(sockets.sockets).length(2)
    await receive(sockets, state())
    expect(node('Reset Game State')).not.equals(null)
  })
})
