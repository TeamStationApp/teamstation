import { appendFileSync, writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import {
  eventsReads,
  gamesOf,
  openGame,
  openPlays,
  openPlaysApp,
  PHONE,
  type PlaysApp,
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
  minutes: 6,
  guards: [],
  faults: ['api-500', 'hidden-element', 'blank-screen'],
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
      await ctx.checkpoint(
        'wide-column',
        {
          expect: [{ text: 'Top 1st' }],
          readBack: async () => {
            expect(column).not.equals(null)
            // One column at reading width, centred: never the whole window.
            expect(column!.width).lessThan(WIDE.width * 0.75)
            const left = column!.left
            const right = WIDE.width - column!.right
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
            expect(eventsReads(app, games.final)).deep.equals([])
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
            expect(eventsReads(app, games.final)).deep.equals([])
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
          ...app.requests.map(path => `  ${path}`),
          `events reads: ${eventsReads(app, games.final).length}`,
          ''
        ].join('\n')
      )
      await app.screenshot('plays-signed-out-phone.png')
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
