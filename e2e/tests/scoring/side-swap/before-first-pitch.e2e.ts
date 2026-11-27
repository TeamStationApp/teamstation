import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import {
  Browser,
  HEIGHT,
  type LineupWorld,
  pause,
  PHONE_HEIGHT,
  PHONE_WIDTH,
  rosterSaves,
  type ScoringStack,
  scoringStack,
  UNLOADED,
  UNREAD,
  WIDTH
} from '../../../rigs/scoringBrowser'

/**
 * Home and away swapped before the first pitch, end to end: the stack's API
 * with its game socket and web build, a `lineup-game` world made afresh for
 * each game, in this machine's browser. Game requests swap a game whose
 * lineups are saved and that holds a guest and an absence; Game Settings,
 * the scoring menu and the schedule import swap it too; after a pitch a
 * coach is refused and a scorekeeper resets the game to swap it; and the
 * speaker at the scoring screen's upper left mutes its sounds.
 */

const REFUSED = 'Home and away can be swapped only before the first pitch'

interface Run {
  ctx: HarnessContext
  stack: ScoringStack
  browser: Browser
}

async function begin(ctx: HarnessContext): Promise<Run> {
  await clearSignInLimits(ctx)
  const stack = await scoringStack(ctx)
  const browser = await Browser.open(ctx, { width: WIDTH, height: HEIGHT })
  return { ctx, stack, browser }
}

/** A second window at a phone's size, for what is captured there. */
async function phone<T>(
  run: Run,
  work: (phone: Browser) => Promise<T>
): Promise<T> {
  const small = await Browser.open(run.ctx, {
    width: PHONE_WIDTH,
    height: PHONE_HEIGHT
  })
  try {
    return await work(small)
  } finally {
    await small.close()
  }
}

/** Signed in as `who` of `world`, in `browser`. */
async function as(
  run: Run,
  browser: Browser,
  world: LineupWorld,
  who: string
): Promise<void> {
  await browser.as(await run.stack.tokenOf(world, who))
}

/** A fresh game with lineups saved, a home guest and an away player out. */
async function preparedGame(
  run: Run,
  file: string | null
): Promise<LineupWorld> {
  const { stack } = run
  const world = await stack.lineupGame(file)
  await stack.score(world, rosterSaves)
  stack.note(
    file,
    `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper: three roster saves, no pitch)\nsaved\n`
  )
  const coach = await stack.clientOf(world, 'headCoach')
  const guest = await coach.createGuestPlayer(world.gameId, 'home', {
    firstName: 'Gus',
    lastName: 'Guest',
    jersey: '77',
    positions: [],
    bats: null,
    throws: null
  })
  stack.note(
    file,
    `$ POST ${stack.api}/games/${world.gameId}/guest-players  {"side":"home","firstName":"Gus","lastName":"Guest"}\n${JSON.stringify({ userId: guest.userId })}\n`
  )
  const bench = world.players.away[12]
  await (
    await stack.clientOf(world, 'awayCoach')
  ).setRostered(world.gameId, {
    side: 'away',
    userId: bench.userId,
    rostered: false
  })
  stack.note(
    file,
    `$ PUT ${stack.api}/games/${world.gameId}/unroster  {"side":"away","userId":"<${bench.name}>","rostered":false}\nunrostered\n`
  )
  return world
}

/** Runs a scenario's steps, then logs the page's errors and closes its window. */
async function scenario(
  ctx: HarnessContext,
  steps: (run: Run) => Promise<void>
): Promise<void> {
  const run = await begin(ctx)
  try {
    await steps(run)
  } finally {
    if (run.browser.errors.length > 0)
      run.stack.note('browser-errors.log', run.browser.errors.join('\n'))
    await run.browser.close()
  }
}

export default defineHarness({
  id: 'scoring/side-swap/before-first-pitch',
  title: 'Home and away swap before the first pitch, and reset after it',
  kind: 'e2e',
  covers: [
    'src/app/screens/gameDraft.ts',
    'src/app/screens/GameFormScreen.tsx',
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/MoreMenu.tsx',
    'src/server/games/swapSides.ts',
    'src/server/games/resetSwap.ts',
    'src/server/schedule/gameApprovals.ts',
    'src/server/schedule/scheduleGames.ts',
    'src/server/games/guestPlayers.ts'
  ],
  stack: 'isolated',
  fixtures: ['lineup-game'],
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
  minutes: 25,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'lineups-guest-absence-swap': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'swap-with-lineups-after.log'
        const world = await preparedGame(run, file)
        const before = await stack.sides(file, world.gameId)
        // What the scorekeeper's device holds: the game as it read it.
        const scorer = await stack.clientOf(world, 'scorekeeper')
        const held = await scorer.gameEvents(world.gameId)
        expect(held.lineupsDigest).a('string')
        await stack.swapGame(world, file)
        const after = await stack.sides(file, world.gameId)
        expect(after.home).equals(before.away)
        expect(after.away).equals(before.home)
        // Kept by team, the guests and absences are as they were.
        expect(after.guests).deep.equals(before.guests)
        expect(after.unrostered).deep.equals(before.unrostered)
        expect(after.lineups_digest).not.equals(before.lineups_digest)
        const lineups = await (
          await stack.clientOf(world, 'scorekeeper')
        ).gameLineups(world.gameId)
        // The hosts, away now, bat first.
        expect(lineups.away.current?.batters[0]?.name).equals(
          world.players.home[0].name
        )
        stack.note(
          file,
          `$ GET ${stack.api}/games/${world.gameId}/lineups\n${JSON.stringify(lineups, null, 2).slice(0, 4000)}\n`
        )

        const stale = 'stale-after-swap.log'
        const { HttpError } = await import('../../../../src/common/errors')
        let refusal: unknown
        try {
          await scorer.saveGameEvents(world.gameId, {
            plays: [],
            remove: [],
            currentPlay: held.currentPlay,
            scoringBase: held.scoringMutation ?? null,
            lineupsBase: held.lineupsDigest
          })
        } catch (error) {
          refusal = error
        }
        stack.note(
          stale,
          `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper's device: its lineups from before the swap, lineupsBase ${String(held.lineupsDigest).slice(0, 12)}…)\n${refusal instanceof HttpError ? `${refusal.status} ${refusal.code} ${refusal.message} ${JSON.stringify(refusal.details)}` : `accepted: ${String(refusal)}`}\n`
        )
        expect(refusal).instanceOf(HttpError)
        expect((refusal as InstanceType<typeof HttpError>).details).deep.equals(
          { stale: true }
        )
        await stack.sides(stale, world.gameId)
      })
    },

    'game-settings-swap': async ctx => {
      await scenario(ctx, async run => {
        const { stack, browser } = run
        const file = 'game-settings-swap-after.log'
        const world = await preparedGame(run, file)
        await as(run, browser, world, 'headCoach')
        await browser.swapInSettings(world.gameId)
        await browser.waitText('Game proposal sent', 30000).catch(async () => {
          await browser.waitText('Game changes saved', 5000)
        })
        const away = await stack.clientOf(world, 'awayCoach')
        const pending = await away.gameProposals({
          kind: 'team',
          id: world.teams.away
        })
        const request = pending.find(
          r => r.gameId === world.gameId && r.status === 'pending'
        )
        if (request != null)
          await away.decideGameRequest(request.requestId, 'accept')
        await browser.go(`/games/${world.gameId}`)
        await browser.waitText('Visitors', 60000)
        await browser.capture('game-after-swap.png')
        const row = await stack.sides(file, world.gameId)
        expect(row.home).equals('Visitors')
        // Game Settings again, framed as the refusal was: at Save, with no error.
        await browser.go(`/games/${world.gameId}/settings`)
        await browser.page.waitForSelector(
          '[aria-label="Swap home and away"]',
          { timeout: 60000 }
        )
        await browser.showButton('Save')
        const shown = await browser.text()
        expect(shown).not.includes(REFUSED)
        expect(shown).not.includes('original teams')
        await browser.capture('game-settings-swap-after.png')
        stack.note(
          file,
          `Game Settings after the swap: Save offered, no refusal shown\n`
        )
      })
    },

    'open-scoring-follows': async ctx => {
      await scenario(ctx, async run => {
        const { stack, browser } = run
        const file = 'scoring-after-swap-after.log'
        const world = await preparedGame(run, file)
        await as(run, browser, world, 'scorekeeper')
        await browser.scoreGame(world.gameId)
        await browser.waitText(`Batter ${world.players.away[0].name}`, 60000)
        await stack.swapGame(world, file)
        await browser.waitText(`Batter ${world.players.home[0].name}`, 60000)
        await pause(1500)
        const shown = await browser.text()
        expect(shown).not.includes(UNLOADED)
        expect(shown).not.includes(UNREAD)
        await browser.capture('scoring-after-swap-after.png')
        stack.note(
          file,
          `scoring screen after the swap: reopened, ${world.players.home[0].name} due up\n`
        )
      })
    },

    'after-pitch-refused-then-reset': async ctx => {
      await scenario(ctx, async run => {
        const { stack, browser } = run
        const file = 'swap-after-pitch-refused.log'
        const world = await preparedGame(run, file)
        await stack.score(world, [{ type: 'pitch', call: 'B' }])
        stack.note(
          file,
          `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper: one pitch, a ball)\nsaved\n`
        )
        const before = await stack.sides(file, world.gameId)
        const { HttpError } = await import('../../../../src/common/errors')
        let refusal: unknown
        try {
          await stack.proposeSwap(world, 'headCoach')
        } catch (error) {
          refusal = error
        }
        stack.note(
          file,
          `$ POST ${stack.api}/game-requests  (home head coach: Swap home and away)\n${refusal instanceof HttpError ? `${refusal.code} ${refusal.message}` : String(refusal)}\n`
        )
        expect(refusal, 'the swap was accepted after a pitch').not.equals(
          undefined
        )
        expect(refusal instanceof HttpError ? refusal.message : '').equals(
          REFUSED
        )
        expect((await stack.sides(file, world.gameId)).home).equals(before.home)

        // A scorekeeper may swap there: the game's plays are reset first.
        await as(run, browser, world, 'scorekeeper')
        await browser.swapInSettings(world.gameId)
        await browser.waitText(
          'Resets all game plays: 1 at-bat in 1 inning will be lost.',
          30000
        )
        await browser.capture('game-settings-after-pitch.png')
        await browser.tap('Reset and Swap')
        await browser.waitText('Home and away swapped', 30000)
        const reset = await stack.sides(file, world.gameId)
        expect(reset.home).equals(before.away)
        stack.note(
          file,
          'scorekeeper in Game Settings: Swap home and away, Save, Reset and Swap; the game was reset and swapped\n'
        )
      })
    },

    'schedule-import-flips': async ctx => {
      await scenario(ctx, async ({ stack }) => {
        const file = 'schedule-import-swap.log'
        const world = await stack.lineupGame(file)
        await stack.query(
          file,
          `insert into scope_roles (id, user_id, scope_type, scope_id, role)
             values ('sr_' || md5(random()::text), $1, 'team', $2, 'admin'),
                    ('sr_' || md5(random()::text), $1, 'season', $3, 'admin')
             on conflict do nothing returning scope_type, role`,
          [world.users.headCoach.userId, world.teams.home, world.seasonId]
        )
        const token = await stack.tokenOf(world, 'headCoach')
        const startAt = new Date(Date.now() + 3 * 86400_000).toISOString()
        const row = (side: 'home' | 'away'): Record<string, unknown> => ({
          opponent: { name: 'Riverside Otters' },
          side,
          startAt,
          externalId: { system: 'sideSwapE2e', id: `otters-${world.gameId}` }
        })
        const post = async (side: 'home' | 'away'): Promise<unknown> => {
          const response = await fetch(
            `${stack.api}/teams/${world.teams.home}/games`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json'
              },
              body: JSON.stringify({ games: [row(side)] })
            }
          )
          const body = (await response.json()) as unknown
          stack.note(
            file,
            `$ POST ${stack.api}/teams/${world.teams.home}/games  ${JSON.stringify({ games: [row(side)] })}\n${response.status} ${JSON.stringify(body)}\n`
          )
          return body
        }
        const created = (await post('home')) as {
          results: Array<{ gameId: string }>
        }
        const gameId = created.results[0].gameId
        const imported = { ...world, gameId }
        const { setupOf } = await import('../../../../src/common/scoring/state')
        // The opponent is outside TeamStation: only the home lineup is saved.
        await stack.score(imported, state => [
          {
            type: 'lineup',
            kind: 'roster',
            setup: setupOf(state),
            confirmed: ['home']
          }
        ])
        stack.note(
          file,
          `$ POST ${stack.api}/games/${gameId}/events  (scorekeeper: the home lineup saved, no pitch)\nsaved\n`
        )
        await (
          await stack.clientOf(world, 'headCoach')
        ).createGuestPlayer(gameId, 'home', {
          firstName: 'Gus',
          lastName: 'Guest',
          jersey: '77',
          positions: [],
          bats: null,
          throws: null
        })
        const before = await stack.sides(file, gameId)
        const flipped = (await post('away')) as {
          results: Array<{ result: string }>
        }
        expect(flipped.results[0].result).equals('updated')
        const after = await stack.sides(file, gameId)
        expect(after.home).equals(before.away)
        expect((after.guests as { away: number[] }).away).deep.equals(
          (before.guests as { home: number[] }).home
        )
        // The Hosts' lineup is now the away one, in its order.
        const lineups = await (
          await stack.clientOf(world, 'headCoach')
        ).gameLineups(gameId)
        stack.note(
          file,
          `$ GET ${stack.api}/games/${gameId}/lineups\n${JSON.stringify(
            {
              away: {
                teamName: lineups.away.teamName,
                batters: lineups.away.current?.batters.map(
                  batter => batter.name
                )
              },
              home: {
                teamName: lineups.home.teamName,
                batters: lineups.home.current?.batters.map(
                  batter => batter.name
                )
              }
            },
            null,
            2
          )}\n`
        )
        expect(lineups.away.teamId).equals(world.teams.home)
        expect(
          lineups.away.current?.batters.map(batter => batter.name)
        ).deep.equals(world.players.home.slice(0, 9).map(player => player.name))
        // No matchup is written either way: the Otters, outside TeamStation,
        // have no lineup and no pitcher.
      })
    },

    'scoring-menu-swap': async ctx => {
      await scenario(ctx, async run => {
        const { stack, browser } = run
        const file = 'scoring-menu-swap.log'
        const world = await preparedGame(run, file)
        const before = await stack.sides(file, world.gameId)
        await as(run, browser, world, 'scorekeeper')
        await browser.scoreGame(world.gameId)
        await browser.waitText(`Batter ${world.players.away[0].name}`, 60000)
        await browser.tap('Open scoring menu')
        await browser.waitText('Swap Home and Away')
        expect(await browser.menuOrder()).deep.equals([
          'Exit Current Game',
          'Settings',
          'Overrides',
          'End Half Inning',
          'Set Team Rosters',
          'Swap Home and Away',
          'End Game'
        ])
        await browser.capture('scoring-menu-after.png')
        await browser.tap('Swap Home and Away')
        await browser.tap('Confirm Swap')
        await browser.waitText(`Batter ${world.players.home[0].name}`, 60000)
        await browser.waitText('Home and away were swapped')
        await browser.capture('scoring-menu-swapped.png')
        const after = await stack.sides(file, world.gameId)
        expect(after.home).equals(before.away)
        expect(after.away).equals(before.home)
        stack.note(
          file,
          `scoring menu: Swap Home and Away, then Confirm Swap; the screen opened again with ${world.players.home[0].name} due up\n`
        )

        // After a pitch the item is on, and says it resets the game's plays.
        const pitched = await preparedGame(run, null)
        await stack.score(pitched, [{ type: 'pitch', call: 'B' }])
        await as(run, browser, pitched, 'scorekeeper')
        await browser.scoreGame(pitched.gameId)
        await browser.tap('Open scoring menu')
        await browser.waitText('resets all game plays')
        expect(await browser.isDisabled('Swap Home and Away')).equals(false)
        stack.note(
          file,
          `$ POST ${stack.api}/games/${pitched.gameId}/events  (scorekeeper: one pitch, a ball)\nsaved\nscoring menu after the pitch: Swap Home and Away, "resets all game plays"\n`
        )

        // At a phone's size every row shows, End Game included.
        const small = await preparedGame(run, null)
        await phone(run, async narrow => {
          await as(run, narrow, small, 'scorekeeper')
          await narrow.scoreGame(small.gameId)
          await narrow.waitText(`Batter ${small.players.away[0].name}`, 60000)
          await narrow.tap('Open scoring menu')
          await narrow.waitText('End Game')
          expect(await narrow.onScreen('End Game')).equals(true)
          await narrow.capture('scoring-menu-phone-after.png')
        })
      })
    },

    'speaker-mutes-and-stays-muted': async ctx => {
      await scenario(ctx, async run => {
        const { stack, browser } = run
        const file = 'scoring-sound-cues.log'
        const world = await preparedGame(run, file)
        await as(run, browser, world, 'scorekeeper')
        await browser.scoreGame(world.gameId)
        await browser.waitText(`Batter ${world.players.away[0].name}`, 60000)
        // A window may keep the scorekeeper's preferences: start from sounds on.
        await browser.waitText('game sounds')
        if (await browser.has('Unmute game sounds')) {
          await browser.tap('Unmute game sounds')
          await browser.waitText('Mute game sounds')
        }
        await browser.capture('scoring-sound-after.png')

        // The first pitch opens the page's audio; the recording takes two
        // pitches with the speaker on, then two after the tap.
        await browser.tap('Called Strike')
        await pause(2500)
        expect(
          await browser.page.evaluate('window.__gameAudio.start()')
        ).equals(true)
        const started = Date.now()
        for (let pitch = 0; pitch < 2; pitch++) {
          await browser.tap('Called Strike')
          await pause(2500)
        }
        const muted = (Date.now() - started) / 1000
        await browser.tap('Mute game sounds')
        await browser.waitText('Unmute game sounds')
        await browser.capture('scoring-sound-muted.png')
        for (let pitch = 0; pitch < 2; pitch++) {
          await browser.tap('Called Strike')
          await pause(2500)
        }
        const recorded = String(
          await browser.page.evaluate('window.__gameAudio.stop()')
        )
        const length = (Date.now() - started) / 1000
        writeFileSync(
          ctx.artifact('scoring-sound-cues.webm'),
          Buffer.from(recorded, 'base64')
        )
        stack.note(
          file,
          `$ # the page's recording, scoring-sound-cues.webm\n(the speaker tapped at ${muted.toFixed(1)} s of ${length.toFixed(1)} s)\n`
        )
        // The loudest sample of a stretch, in dB, as volumedetect's max_volume.
        const loudness = async (
          from: number,
          span: number,
          which: string
        ): Promise<number> => {
          const peak = (await browser.page.evaluate(
            `window.__gameAudio.peak(${from}, ${span})`
          )) as number | null
          stack.note(
            file,
            `$ # peak of ${from.toFixed(2)} s for ${span.toFixed(2)} s   (${which})\nmax_volume: ${peak == null ? '-inf' : peak.toFixed(1)} dB\n`
          )
          return peak ?? -Infinity
        }
        const on = await loudness(0, muted, 'speaker on: two pitches')
        const off = await loudness(
          muted + 0.5,
          length - muted - 0.5,
          'speaker off: two pitches'
        )
        expect(on, 'the cues with the speaker on').above(-40)
        expect(off, 'nothing after the tap').below(-60)

        // Opened again, it is still muted, and Settings agrees.
        await browser.scoreGame(world.gameId)
        await browser.waitText('Unmute game sounds')
        await browser.tap('Open scoring menu')
        await browser.tap('Settings')
        await browser.waitText('Scoring sound')
        expect(await browser.switchOn('Toggle scoring sound')).equals(false)
        stack.note(
          file,
          'opened again: the speaker reads Unmute game sounds, and Settings has Scoring sound off\n'
        )
        // Settings' switch is the same setting: turned on there, the speaker
        // follows.
        await browser.tap('Toggle scoring sound')
        await browser.waitText('Mute game sounds')
        expect(await browser.switchOn('Toggle scoring sound')).equals(true)
        stack.note(
          file,
          "Settings' Scoring sound switched back on: the speaker reads Mute game sounds\n"
        )

        // At a phone's size: the speaker clear of the scoreboard and ☰, and
        // the instruction toast between them.
        const small = await preparedGame(run, null)
        await phone(run, async narrow => {
          await as(run, narrow, small, 'scorekeeper')
          await narrow.scoreGame(small.gameId)
          await narrow.waitText(`Batter ${small.players.away[0].name}`, 60000)
          await narrow.waitText('game sounds')
          const speaker = (await narrow.has('Mute game sounds'))
            ? 'Mute game sounds'
            : 'Unmute game sounds'
          await narrow.capture('scoring-sound-phone-after.png')
          // A single: the screen asks where the ball went.
          await narrow.tap('Swing in Play')
          await narrow.tap('Single')
          await pause(800)
          expect(await narrow.uncovered(speaker)).equals(true)
          expect(await narrow.uncovered('Open scoring menu')).equals(true)
          await narrow.capture('scoring-sound-phone-instruction.png')
        })
      })
    }
  }
})
