import { appendFileSync, writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import {
  eventsReads,
  gamesOf,
  latestShown,
  openGame,
  openPlays,
  openPlaysApp,
  pagePosition,
  PHONE,
  type PlaysApp,
  scoreHit,
  screenRecorder,
  tapControl,
  undoName,
  wheel,
  WIDE
} from '../../../rigs/plays/playsApp'

/**
 * A game's Plays tab, the whole game as a stream: its pill right after
 * Videos from the first recorded pitch, its at-bats oldest first under the
 * pinned pills, a summary closing each half, each line opening into its
 * pitches. A member reads it; a non-member and a guest are asked to become
 * members, and the page never asks for the plays.
 */

const MEMBERS_ONLY =
  "You need to be a member of one of these teams to see this game's Plays."
const SIGN_IN_FIRST = 'Log in or create an account first to request membership.'

/** The lines of the stream, by their at-bat index, in page order. */
async function lineIndexes(app: PlaysApp): Promise<number[]> {
  return (await app.testIds(/^plays-line-\d+$/)).map(id =>
    Number(id.slice('plays-line-'.length))
  )
}

/** The index of the first line whose words include `words`. */
async function lineReading(app: PlaysApp, words: string): Promise<number> {
  const index = await app.web.page.evaluate((wanted: string) => {
    const line = Array.from(
      document.querySelectorAll('[data-testid^="plays-line-"]')
    ).find(node => String(node.textContent).includes(wanted))
    return line == null
      ? null
      : Number(String(line.getAttribute('data-testid')).slice(11))
  }, words)
  if (index == null) throw new Error(`no line reads "${words}"`)
  return index
}

/** Whether the line can be opened: it has a button. */
async function opens(app: PlaysApp, atBatIndex: number): Promise<boolean> {
  return await app.web.page.evaluate(
    (index: number) =>
      document.querySelector(
        `[data-testid="plays-line-${index}"] [role="button"]`
      ) != null,
    atBatIndex
  )
}

/** The line's half, by its key: `top-1`. */
async function halfOf(app: PlaysApp, atBatIndex: number): Promise<string> {
  return await app.web.page.evaluate((index: number) => {
    const line = document.querySelector(`[data-testid="plays-line-${index}"]`)
    const half =
      line == null ? null : line.closest('[data-testid^="plays-half-"]')
    // No `?.` in the page: it has no sucrase helpers.
    return half == null
      ? ''
      : String(half.getAttribute('data-testid')).slice(11)
  }, atBatIndex)
}

/** The stream's checks on the final game, at either width. */
async function finalStream(app: PlaysApp): Promise<void> {
  const halves = await app.testIds(/^plays-half-/)
  expect(halves[0]).equals('plays-half-top-1')
  expect(halves[1]).equals('plays-half-bottom-1')
  // Every half of a final game ends with its summary.
  expect(await app.testIds(/^plays-summary-/)).length(halves.length)
  const indexes = await lineIndexes(app)
  expect(indexes.length).greaterThan(10)
  expect(indexes).deep.equals([...indexes].sort((a, b) => a - b))
  const text = await app.text()
  expect(text).includes('Top 1st')
  expect(text).includes('Bottom 1st')
  expect(text).includes('Pitcher: ')
  expect(text).match(/Runs: \d+, Hits: \d+/)
  expect(await app.testIds(/^plays-scoring$/)).not.deep.equals([])
  // One line per at-bat, each with a picture or its letters.
  const emblems = await app.web.page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-testid^="plays-line-"] [data-testid="emblem"], [data-testid^="plays-line-"] img'
      ).length
  )
  expect(emblems).greaterThanOrEqual(indexes.length)
  expect(await app.testIds(/^plays-latest$/)).deep.equals([])
}

/** How close to its end the page counts as at it. */
const AT_END = 2

/** Whether the page stands at its end, with no room kept under the stream. */
async function atEnd(app: PlaysApp): Promise<boolean> {
  const at = await pagePosition(app)
  return at.y >= at.end - AT_END && at.spacer <= 1
}

/** The pitch rows of the line, how many. */
async function pitchCount(app: PlaysApp, atBatIndex: number): Promise<number> {
  return (await app.pitchRows(atBatIndex)).length
}

/** The scorer's Score Game screen, its pitch controls drawn. */
async function openScoring(app: PlaysApp, gameId: string): Promise<void> {
  await app.go(`/games/${gameId}/score`)
  await app.until(
    'the pitch controls',
    async () =>
      (await app.web.page.evaluate(
        () => document.querySelector('[aria-label="Ball"]') != null
      ))
        ? true
        : undefined,
    90000
  )
}

export default defineE2e({
  id: 'scoring/plays/all-plays',
  title:
    "A game's Plays tab streams its at-bats after Videos, opens each into its pitches, and keeps them for members",
  kind: 'e2e',
  covers: [
    'src/app/plays/**',
    'src/app/screens/gameTabs.ts',
    'src/app/screens/GameScreen.tsx',
    'src/app/scoring/tailFollow.ts',
    'src/app/components/usePinnedHead*.ts',
    'src/app/screens/MembershipAccess.tsx',
    'src/app/navigation/routes.ts',
    'src/server/dev/fixtures/playsGame.ts'
  ],
  stack: 'isolated',
  fixtures: ['plays-game'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: ['api-500', 'hidden-element', 'blank-screen', 'socket-drop'],
  manual: false,
  scenarios: {
    'phone-final': async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const app = await openPlaysApp(ctx, world.accounts.member, PHONE)
      await openGame(app, games.final)
      await ctx.checkpoint(
        'final-pills',
        {
          expect: [{ text: 'Plays', timeout: 60000 }],
          readBack: async () => {
            expect(await app.pills()).deep.equals([
              'Box score',
              'Videos',
              'Plays',
              'Replay',
              'Info'
            ])
          }
        },
        app.m
      )
      await openPlays(app)
      await finalStream(app)
      expect(await app.text()).includes(world.ids.awayTeamName)
      // The hero scrolls away and the pills stay pinned under the header.
      const pinned = await app.rect('gameSection')
      const before = await app.web.page.evaluate(() => {
        const tab = document.querySelector('[role="tab"]')
        return tab == null ? null : tab.getBoundingClientRect().top
      })
      // Down the stream to its last half.
      await app.m.scrollUntilVisible({ element: { text: 'Top 3rd' } })
      await app.m.waitForAnimationToEnd()
      const after = await app.web.page.evaluate(() => {
        const tab = document.querySelector('[role="tab"]')
        return tab == null ? null : tab.getBoundingClientRect().top
      })
      expect(pinned, 'the game section').not.equals(null)
      expect(before).to.be.a('number')
      expect(after).to.be.a('number')
      expect(after!).lessThan(before!)
      expect(after!).greaterThan(0)
      const hero = await app.rect('event-hero')
      expect(
        hero == null || hero.bottom <= after!,
        'the hero scrolled away'
      ).equals(true)
      await app.screenshot('plays-final-phone.png')

      // The first home run opens into its pitches, clocked by the radar.
      const homer = await lineReading(app, 'hits a home run')
      await app.tapLine(homer)
      const rows = await app.until('the home run’s pitches', async () => {
        const found = await app.pitchRows(homer)
        return found.length > 0 ? found : undefined
      })
      await ctx.checkpoint(
        'expanded-line',
        {
          readBack: async () => {
            expect(rows[0]).match(/^1/)
            for (const row of rows) {
              expect(row).match(/\d-\d/)
              expect(row).match(/\d+ mph/)
            }
            expect(rows.at(-1)).match(/Exit velocity \d+ mph/)
          }
        },
        app.m
      )
      await app.screenshot('plays-expanded-phone.png')
      await app.tapLine(homer)
      await app.until('the line closed', async () =>
        (await app.pitchRows(homer)).length === 0 ? true : undefined
      )
      expect(await app.testIds(/^plays-latest$/)).deep.equals([])
    },

    'wide-final': async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const app = await openPlaysApp(ctx, world.accounts.member, WIDE)
      await openGame(app, games.final)
      await openPlays(app)
      await finalStream(app)
      const column = await app.rect('plays-stream')
      // The game's pane, beside the app's sidebar.
      const pane = await app.rect('gameSection')
      await ctx.checkpoint(
        'wide-column',
        {
          expect: [{ text: 'Top 1st' }],
          readBack: async () => {
            expect(column).not.equals(null)
            expect(pane).not.equals(null)
            // One column at reading width, centred in the pane: never the
            // pane's whole width, and no side panel beside it.
            expect(column!.width).lessThan(pane!.width * 0.85)
            const left = column!.left - pane!.left
            const right = pane!.right - column!.right
            expect(Math.abs(left - right)).lessThan(40)
          }
        },
        app.m
      )
      await app.screenshot('plays-final-wide.png')
    },

    imported: async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const app = await openPlaysApp(ctx, world.accounts.member, PHONE)
      await openGame(app, games.mixed)
      expect(await app.pills()).includes('Plays')
      await openPlays(app)
      const indexes = await lineIndexes(app)
      const first = indexes[0]
      expect(await halfOf(app, first)).equals('top-1')
      expect(await opens(app, first)).equals(false)
      const text = await app.text()
      expect(text).includes('Pitcher: ')
      expect(text).match(/\d outs?/)
      // A tap on a line with no pitches opens nothing.
      await app.m.tapOn({ css: `[data-testid="plays-line-${first}"]` })
      await app.m.waitForAnimationToEnd()
      expect(await app.pitchRows(first)).deep.equals([])
      await ctx.checkpoint(
        'no-detail-line',
        { expect: [{ text: 'Top 1st' }] },
        app.m
      )
      await app.screenshot('plays-imported-phone.png')
      let third: number | undefined
      for (const index of indexes)
        if ((await halfOf(app, index)).endsWith('-3')) {
          third = index
          break
        }
      expect(third, 'a line of the 3rd').not.equals(undefined)
      expect(await opens(app, third!)).equals(true)
      await app.tapLine(third!)
      await app.until('the 3rd inning line’s pitches', async () =>
        (await app.pitchRows(third!)).length > 0 ? true : undefined
      )
    },

    'members-only': async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const app = await openPlaysApp(ctx, world.accounts.outsider, PHONE)
      await openGame(app, games.final)
      expect(await app.pills()).includes('Plays')
      await openPlays(app)
      await ctx.checkpoint(
        'members-only',
        {
          expect: [{ text: MEMBERS_ONLY }, { text: 'Request membership' }],
          readBack: async () => {
            expect(await eventsReads(app, games.final)).deep.equals([])
            // The page did ask the API, for the game itself: the timings see it.
            expect(await app.requests()).includes(
              `/api/v1/games/${games.final}`
            )
          }
        },
        app.m
      )
      await app.screenshot('plays-members-only-phone.png')
    },

    'signed-out': async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const app = await openPlaysApp(ctx, null, PHONE)
      const log = ctx.artifact('plays-signed-out.log')
      writeFileSync(
        log,
        `$ npm run -s e2e -- run scoring/plays/all-plays#signed-out --surface web-chromium --stack "$STACK"\n`
      )
      await openGame(app, games.final)
      await openPlays(app)
      await ctx.checkpoint(
        'signed-out',
        {
          expect: [{ text: SIGN_IN_FIRST }, { text: 'Log in / Sign up' }],
          readBack: async () => {
            expect(await eventsReads(app, games.final)).deep.equals([])
            // The page did ask the API, for the game itself: the timings see it.
            expect(await app.requests()).includes(
              `/api/v1/games/${games.final}`
            )
          }
        },
        app.m
      )
      appendFileSync(
        log,
        [
          `checkpoint signed-out: "${MEMBERS_ONLY}" / "${SIGN_IN_FIRST}" / Log in / Sign up`,
          `selected pill: ${await app.selected()}`,
          'requests:',
          ...(await app.requests()).map(path => `  ${path}`),
          `events reads: ${(await eventsReads(app, games.final)).length}`,
          ''
        ].join('\n')
      )
      await app.screenshot('plays-signed-out-phone.png')
    },

    'live-follow': async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const log = ctx.artifact('plays-live-follow.log')
      const started = Date.now()
      writeFileSync(
        log,
        `$ npm run -s e2e -- run scoring/plays/all-plays#live-follow --surface web-chromium --stack "$STACK"\n`
      )
      const note = (line: string): void => {
        appendFileSync(
          log,
          `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}\n`
        )
      }
      const scorer = await openPlaysApp(ctx, world.accounts.scorer, PHONE)
      await openScoring(scorer, games.inProgress)
      note('scorer: Score Game open on the game in progress')
      const viewer = await openPlaysApp(ctx, world.accounts.member, PHONE)
      await openGame(viewer, games.inProgress)
      await openPlays(viewer)
      const recorder = screenRecorder(viewer.m)
      let recorded = false
      try {
        const muncy = await viewer.until('the at-bat in progress', async () => {
          const at = await pagePosition(viewer)
          return at.lastLine ?? undefined
        })
        await viewer.until('the page at its end', async () =>
          (await atEnd(viewer)) ? true : undefined
        )
        await ctx.checkpoint(
          'live-open',
          {
            expect: [{ text: 'batting, ' }],
            readBack: async () => {
              expect(await pitchCount(viewer, muncy)).equals(1)
              expect(await latestShown(viewer)).equals(false)
              expect(await atEnd(viewer)).equals(true)
            }
          },
          viewer.m
        )
        note(
          `viewer: Plays open at its end, line ${muncy} in progress with 1 pitch, no button`
        )

        /** A scorer's tap, then the viewer's line until it has `pitches`. */
        const pitchAndSee = async (
          control: string,
          line: number,
          pitches: number
        ): Promise<number> => {
          const tapped = Date.now()
          await tapControl(scorer, control)
          await viewer.until(
            `pitch ${pitches} on the viewer's line`,
            async () =>
              (await pitchCount(viewer, line)) >= pitches ? true : undefined,
            15000
          )
          return Date.now() - tapped
        }
        for (const [control, pitches] of [
          ['Ball', 2],
          ['Called Strike', 3]
        ] as const) {
          const lag = await pitchAndSee(control, muncy, pitches)
          expect(lag, `${control} reached the viewer`).lessThan(3000)
          await viewer.until('the page at its end', async () =>
            (await atEnd(viewer)) ? true : undefined
          )
          note(
            `scorer: ${control}; viewer: pitch ${pitches} in ${lag} ms, at the end`
          )
        }

        await scoreHit(scorer, 'Single')
        const next = await viewer.until('the next batter', async () => {
          const at = await pagePosition(viewer)
          return at.lastLine != null && at.lastLine !== muncy
            ? at.lastLine
            : undefined
        })
        await viewer.until('the page at its end', async () =>
          (await atEnd(viewer)) ? true : undefined
        )
        const settled = await pagePosition(viewer)
        await ctx.checkpoint(
          'live-single',
          {
            expect: [{ text: 'singles' }],
            readBack: async () => {
              // Stored, Muncy's line is shut; the next batter's is last, at
              // the bottom margin, with no room left under it.
              expect(await pitchCount(viewer, muncy)).equals(0)
              expect(settled.lastLine).equals(next)
              expect(settled.spacer).lessThanOrEqual(1)
              expect(settled.y).greaterThanOrEqual(settled.end - AT_END)
              expect(settled.lastLineBottom!).lessThanOrEqual(PHONE.height)
              expect(await latestShown(viewer)).equals(false)
            }
          },
          viewer.m
        )
        note(
          `scorer: single to center; viewer: line ${muncy} shut, line ${next} last, at the end, spacer ${settled.spacer}`
        )

        // Up two screens (or to the top): the page stops following and the
        // button fades in.
        for (let turn = 0; turn < 20; turn++) {
          const at = await pagePosition(viewer)
          if (at.end - at.y >= 2 * at.viewport || at.y <= 0) break
          await wheel(viewer, 'up', 1)
        }
        const up = await pagePosition(viewer)
        // Two screens, or the top: a game in its 2nd inning is not that long.
        expect(
          up.y <= 0 || up.end - up.y >= 2 * up.viewport - AT_END,
          `scrolled up to ${up.y} of ${up.end}`
        ).equals(true)
        expect(up.end - up.y).greaterThan(up.viewport)
        await viewer.until('the button', async () =>
          (await latestShown(viewer)) ? true : undefined
        )
        note(`viewer: scrolled up to ${up.y} of ${up.end}; the button shows`)
        await tapControl(scorer, 'Ball')
        await viewer.until(
          'the pitch to the next batter',
          async () =>
            (await pitchCount(viewer, next)) >= 1 ? true : undefined,
          15000
        )
        // The open line grew below the viewer, who stays where they were.
        await new Promise(resolve => setTimeout(resolve, 1500))
        const held = await pagePosition(viewer)
        expect(Math.abs(held.y - up.y)).lessThanOrEqual(1)
        expect(held.end).greaterThan(up.end)
        expect(await latestShown(viewer)).equals(true)
        note(
          `scorer: Ball; viewer: still at ${held.y}, the end now ${held.end}`
        )

        // The button takes the viewer back down, and the page follows again.
        await viewer.m.tapOn({ css: '[data-testid="plays-latest"]' })
        await viewer.until('the page at its end', async () =>
          (await atEnd(viewer)) ? true : undefined
        )
        await viewer.until('the button gone', async () =>
          (await latestShown(viewer)) ? undefined : true
        )
        note('viewer: tapped the button; at the end, the button faded')
        const ballsBefore = (await viewer.pitchRows(next)).length
        await pitchAndSee('Ball', next, ballsBefore + 1)
        await viewer.until('the page at its end', async () =>
          (await atEnd(viewer)) ? true : undefined
        )
        note('scorer: Ball; viewer: followed it to the end')

        // Up, then back to the end by hand: following again.
        await wheel(viewer, 'up', 3)
        await viewer.until('the button', async () =>
          (await latestShown(viewer)) ? true : undefined
        )
        for (let turn = 0; turn < 12 && !(await atEnd(viewer)); turn++)
          await wheel(viewer, 'down', 1)
        expect(await atEnd(viewer)).equals(true)
        await viewer.until('the button gone', async () =>
          (await latestShown(viewer)) ? undefined : true
        )
        note(
          'viewer: scrolled up, then back to the end by hand; the button faded'
        )

        // The single taken back and a double recorded: the same line changes.
        for (
          let tap = 0;
          tap < 8 && (await undoName(scorer)) !== 'Undo Called Strike';
          tap++
        ) {
          await tapControl(scorer, 'Undo*')
          await new Promise(resolve => setTimeout(resolve, 800))
        }
        expect(await undoName(scorer)).equals('Undo Called Strike')
        await scoreHit(scorer, 'Double')
        const doubled = await viewer.until(
          'the double on the same line',
          async () => {
            const line = await viewer.web.page.evaluate((index: number) => {
              // No `?.` in the page: it has no sucrase helpers.
              const node = document.querySelector(
                `[data-testid="plays-line-${index}"]`
              )
              return node == null ? '' : String(node.textContent)
            }, muncy)
            return line.includes('double') ? line : undefined
          },
          20000
        )
        expect(doubled).not.includes('singles')
        note(
          `scorer: undid the single, recorded a double; viewer: line ${muncy} reads the double`
        )
        await new Promise(resolve => setTimeout(resolve, 1500))
        await recorder.stop(ctx.artifact('plays-live-follow.mp4'))
        recorded = true
        note('recorded plays-live-follow.mp4')
      } finally {
        if (!recorded)
          await recorder
            .stop(ctx.artifact('plays-live-follow.mp4'))
            .catch(() => undefined)
      }
    },

    'undo-hides-pill': async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const log = ctx.artifact('plays-pill-undo.log')
      writeFileSync(
        log,
        `$ npm run -s e2e -- run scoring/plays/all-plays#undo-hides-pill --surface web-chromium --stack "$STACK"\n`
      )
      const scorer = await openPlaysApp(ctx, world.accounts.scorer, PHONE)
      await openScoring(scorer, games.onePitch)
      const viewer = await openPlaysApp(ctx, world.accounts.member, PHONE)
      await openGame(viewer, games.onePitch)
      await openPlays(viewer)
      appendFileSync(
        log,
        `viewer on the onePitch game: pills ${(await viewer.pills()).join(', ')}; tab ${await viewer.selected()}\n`
      )
      await tapControl(scorer, 'Undo*')
      await viewer.until('the pill gone', async () =>
        (await viewer.pills()).includes('Plays') ? undefined : true
      )
      await ctx.checkpoint(
        'pill-gone',
        {
          expect: [{ text: 'Info' }],
          readBack: async () => {
            expect(await viewer.pills()).not.includes('Plays')
            await viewer.until('Info', async () =>
              (await viewer.selected()) === 'Info' ? true : undefined
            )
            expect(await viewer.testIds(/^plays-/)).deep.equals([])
            await viewer.until('the address', async () =>
              (await viewer.address()).endsWith('?tab=info') ? true : undefined
            )
          }
        },
        viewer.m
      )
      appendFileSync(
        log,
        `scorer: Undo (the only pitch); viewer: pills ${(await viewer.pills()).join(', ')}; tab ${await viewer.selected()}; address ${(await viewer.address()).replace(games.onePitch, '<onePitch>')}\n`
      )
      await tapControl(scorer, 'Ball')
      await viewer.until('the pill back', async () =>
        (await viewer.pills()).includes('Plays') ? true : undefined
      )
      appendFileSync(
        log,
        `scorer: Ball; viewer: pills ${(await viewer.pills()).join(', ')}; tab ${await viewer.selected()}\n`
      )
    },

    'tab-address': async ctx => {
      const world = await ctx.fixture('plays-game')
      const games = gamesOf(world)
      const app = await openPlaysApp(ctx, world.accounts.member, PHONE)
      const log = ctx.artifact('plays-tab-address.log')
      writeFileSync(
        log,
        `$ npm run -s e2e -- run scoring/plays/all-plays#tab-address --surface web-chromium --stack "$STACK"\n`
      )
      await openGame(app, games.final, '?tab=plays')
      await app.until('the stream', async () =>
        (await app.testIds(/^plays-stream$/)).length > 0 ? true : undefined
      )
      expect(await app.selected()).equals('Plays')
      appendFileSync(
        log,
        `opened /games/<final>?tab=plays: tab ${await app.selected()}, address ${(await app.address()).replace(games.final, '<final>')}\n`
      )
      await app.screenshot('plays-tab-address-phone.png')

      // Nobody has pitched: no Plays pill, so the game's default, Info
      // (it has not ended), and the address follows.
      await openGame(app, games.unplayed, '?tab=plays')
      await app.until('Info', async () =>
        (await app.selected()) === 'Info' ? true : undefined
      )
      await ctx.checkpoint(
        'no-plays-pill',
        {
          expect: [{ text: 'Info' }],
          readBack: async () => {
            expect(await app.pills()).not.includes('Plays')
            expect(await app.testIds(/^plays-/)).deep.equals([])
            await app.until('the address', async () =>
              (await app.address()).endsWith('?tab=info') ? true : undefined
            )
          }
        },
        app.m
      )
      appendFileSync(
        log,
        `opened /games/<unplayed>?tab=plays: pills ${(await app.pills()).join(', ')}; tab ${await app.selected()}, address ${(await app.address()).replace(games.unplayed, '<unplayed>')}\n`
      )
    }
  }
})
