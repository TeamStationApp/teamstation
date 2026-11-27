import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'

/**
 * E1: every scoring action carries the time it was taken, on the server's
 * clock, and keeps it through an Undo and a later correction. The web scorer,
 * in the runner's browser through maestro-d, scores a fresh `scoring-game`
 * game as its administrator scorer; the times are read back from the API.
 */

/** One action as the scorer took it: what was tapped, and between when. */
interface Tap {
  label: string
  from: number
  to: number
}

interface StoredRecord {
  actions: Array<{ type: string; call?: string; kind?: string }>
  actionTimes?: string[]
}
interface StoredPlay {
  about: { atBatIndex: number }
  teamStation?: StoredRecord
}
interface StoredGame {
  plays: Array<{ gumbo: StoredPlay }>
  currentPlay: StoredPlay | null
}
/** A stored action, named as `pitch C` or `gameFlow closePlay`, and its time. */
interface Stored {
  what: string
  time: string
}

/**
 * Every stored action and its time, in the order the game was scored: the
 * stored plays, then the at-bat in progress. A play an Undo reopened is read
 * from the at-bat in progress only.
 */
async function storedActions(
  api: string,
  token: string,
  gameId: string
): Promise<Stored[]> {
  const response = await fetch(`${api}/games/${gameId}/events`, {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(response.status).equals(200)
  const game = (await response.json()) as StoredGame
  const current = game.currentPlay?.about.atBatIndex
  const records = [
    ...game.plays
      .map(row => row.gumbo)
      .filter(play => play.about.atBatIndex !== current)
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex),
    ...(game.currentPlay == null ? [] : [game.currentPlay])
  ].map(play => play.teamStation)
  return records.flatMap((record, i) => {
    if (record == null || record.actions.length === 0) return []
    expect(record.actionTimes, `record ${i} has a time per action`).length(
      record.actions.length
    )
    return record.actions.map((action, k) => ({
      what: `${action.type} ${action.call ?? action.kind ?? ''}`.trim(),
      time: record.actionTimes![k]
    }))
  })
}

async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function stampsEveryAction(ctx: HarnessContext): Promise<void> {
  const world = await ctx.fixture('scoring-game')
  const gameId = world.ids.game
  const api = `${ctx.stack.origin}/api/v1`
  await clearSignInLimits(ctx)
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  const token = await signInTestAccount(api, world.accounts.scorer)
  // The password form's signed-in check reads the phone layout's menu, so
  // the browser signs in at a phone's width and then widens.
  const session = await ctx.browser({ width: 390, height: 844 })
  const browser = session.m
  await browser.openLink({ link: `${ctx.stack.origin}/` })
  await ctx.signIn('scorer', browser)
  await session.resize({ width: 1280, height: 720 })
  /** The field's presentation and gestures, read off its React props. */
  const FIELD_STATE = `(() => {
    const host = document.querySelector('[aria-label="Baseball field"]')
    if (host == null) return 'no field'
    const key = Object.keys(host).find(name => name.startsWith('__reactFiber$'))
    for (let fiber = host[key]; fiber != null; fiber = fiber.return) {
      const props = fiber.memoizedProps
      if (props == null || props.interaction == null) continue
      const shown = props.presentation == null ? 'no presentation'
        : 'presentation ' + props.presentation.id + ' ' + props.presentation.stage
      return shown + (props.presentationPaused ? ' paused' : '') +
        ', gestures ' + JSON.stringify(props.interaction.gestures)
    }
    return 'no interaction'
  })()`

  /** Reads a value out of the page. */
  async function probe<T>(script: string): Promise<T> {
    await browser.evalBrowserScript({
      script: `return JSON.stringify(${script})`,
      output: 'probe'
    })
    return JSON.parse((await browser.vars()).probe) as T
  }
  async function tap(label: string): Promise<Tap> {
    const css = `[aria-label="${label}"]`
    await browser.assertVisible({ css, timeout: 15000 })
    // A pitch button is disabled while a play animates; it is timed from
    // when it can be pressed.
    for (const until = Date.now() + 15000; ;) {
      const disabled = await probe<boolean>(
        `document.querySelector(${JSON.stringify(css)})?.getAttribute('aria-disabled') === 'true'`
      )
      if (!disabled) break
      if (Date.now() > until)
        // What held it: a play still presenting, or the field's own state.
        throw new Error(
          `${label} stayed disabled; the field holds ${await probe<string>(FIELD_STATE)}`
        )
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const from = Date.now()
    await browser.tapOn({ css, timeout: 15000 })
    return { label, from, to: Date.now() }
  }
  async function undo(): Promise<Tap> {
    const label = await probe<string>(
      `document.querySelector('[aria-label^="Undo "]')?.getAttribute('aria-label') ?? ''`
    )
    expect(label).not.equals('')
    return await tap(label)
  }
  /** Taps each, a second or so apart, as a scorer at the field does. */
  async function score(labels: string[]): Promise<Tap[]> {
    const taps: Tap[] = []
    for (const label of labels) {
      taps.push(await tap(label))
      await pause(1000)
    }
    return taps
  }
  /** Every change has been sent and acknowledged; what the server holds. */
  async function saved(): Promise<Stored[]> {
    const until = Date.now() + 30000
    let last = ''
    for (;;) {
      await pause(1500)
      const pending = await probe<boolean>(
        `document.querySelector('[aria-label="Save status"]') != null`
      )
      const held = await storedActions(api, token, gameId)
      const now = JSON.stringify(held)
      if (!pending && now === last) return held
      if (Date.now() > until) throw new Error('The game was never saved')
      last = now
    }
  }
  /** The game is back where it started: no pitch, no out. */
  async function atStart(): Promise<boolean> {
    return await probe<boolean>(
      `/Top 1st · 0 balls 0 strikes 0 outs/.test(document.body.textContent)`
    )
  }
  function print(heading: string, held: Stored[]): void {
    console.log(heading)
    for (const [i, action] of held.entries())
      console.log(`  ${String(i).padStart(2)}  ${action.time}  ${action.what}`)
  }
  async function picture(name: string): Promise<void> {
    await browser.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
  }
  function within(time: string, taken: Tap, what: string): void {
    const at = Date.parse(time)
    expect(at, `${what} at ${time}`).within(taken.from - 1000, taken.to + 1000)
  }

  await browser.openLink({ link: `${ctx.stack.origin}/games/${gameId}/score` })
  await browser.assertVisible({
    css: 'canvas[data-field-ready="true"]',
    timeout: 60000
  })
  if (
    await probe<boolean>(`document.querySelector('[aria-label="OK"]') != null`)
  )
    await tap('OK')

  console.log(`game ${gameId}`)
  // The lineups are the first action.
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
  const rosters = await tap('Save Rosters')
  await pause(1000)

  // 1. Three at-bats, each a strikeout, a second or so per pitch. The
  // first has fouls in it, so a strike for its first ball still strikes
  // the batter out on the same pitch.
  const first = ['Ball', 'Foul Ball', 'Ball', 'Foul Ball', 'Swing and Miss']
  const second = [
    'Called Strike',
    'Called Strike',
    'Foul Ball',
    'Swing and Miss'
  ]
  const third = ['Ball', 'Called Strike', 'Swing and Miss', 'Called Strike']
  const taps = [rosters, ...(await score([...first, ...second, ...third]))]
  const scored = await saved()
  print('After three at-bats:', scored)
  // Each action the scorer took, at its tap; the screen closes a play
  // itself, between them.
  const taken = scored.filter(action => action.what !== 'gameFlow closePlay')
  expect(taken.map(action => action.what)).deep.equals([
    'lineup roster',
    ...[...first, ...second, ...third].map(
      label =>
        `pitch ${{ Ball: 'B', 'Called Strike': 'C', 'Foul Ball': 'F', 'Swing and Miss': 'S' }[label]}`
    )
  ])
  taken.forEach((action, i) => {
    within(action.time, taps[i], `${i}: ${taps[i].label}`)
  })
  const times = scored.map(action => Date.parse(action.time))
  expect(times).deep.equals([...times].sort((a, b) => a - b))
  await picture('action-times-scored')

  // 2. The last pitch was wrong: undo it and score a ball at once.
  const undone = await undo()
  const [replacement] = await score(['Ball'])
  const replaced = await saved()
  print(`After ${undone.label} and a ball at once:`, replaced)
  const kept = scored.findLastIndex(action => action.what === 'pitch C')
  expect(replaced.slice(0, kept)).deep.equals(scored.slice(0, kept))
  expect(replaced).length(kept + 1)
  expect(replaced[kept].what).equals('pitch B')
  within(replaced[kept].time, replacement, 'the replacement ball')
  expect(Date.parse(replaced[kept].time)).greaterThan(
    Date.parse(scored[kept].time)
  )

  // 3. A minute and a half later, the scorer finds the first at-bat's
  // first ball was a strike: back to it, change it, and enter the rest
  // again exactly as before.
  await pause(90_000)
  for (let undos = 0; !(await atStart()); undos++) {
    expect(undos).lessThan(30)
    console.log(`  back: ${(await undo()).label}`)
  }
  const rest = [...first, ...second, ...third].slice(1)
  rest[rest.length - 1] = 'Ball'
  await score(['Called Strike', ...rest])
  const corrected = await saved()
  print('After the correction:', corrected)
  expect(corrected.map(action => action.what)).deep.equals(
    replaced.map((action, i) => (i === 1 ? 'pitch C' : action.what))
  )
  // The corrected pitch keeps the ball's time, and every later action its
  // own, though each was entered again ninety seconds later.
  expect(corrected.map(action => action.time)).deep.equals(
    replaced.map(action => action.time)
  )
  await picture('action-times-corrected')
}

export default defineHarness({
  id: 'scoring/action-times/server-clock',
  title:
    'Every scoring action keeps the server time it was taken through Undo and a correction',
  kind: 'e2e',
  covers: [
    'src/app/scoring/**',
    'src/common/scoring/session.ts',
    'src/server/scoring/**'
  ],
  stack: 'isolated',
  fixtures: ['scoring-game'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws in 3D: the Mac's Chrome, with its GPU.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'undo-and-correction': stampsEveryAction
  }
})
