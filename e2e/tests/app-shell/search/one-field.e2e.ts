import { expect } from 'chai'

import {
  alerts,
  answered,
  apiClient,
  byLabel,
  clearSearch,
  exactly,
  jevOf,
  named,
  openSearch,
  Overtaken,
  ownRows,
  proveLog,
  proveScreen,
  readRows,
  rowKind,
  rowName,
  type SearchRow,
  searchSpec,
  searchWorld,
  typeSearch
} from '../../../rigs/search/searchRig'

const COVERS = [
  'src/app/screens/SearchScreen.tsx',
  'src/app/components/SearchResultRow.tsx',
  'src/common/searchSocket.ts',
  'src/common/search/**',
  'src/server/search/**'
]

/** The hint the Search tab shows under its title. */
const SEARCH_HINT =
  'Find leagues, seasons, teams and people. Public profiles show location, parent organizations, schedules and results.'

/** The labels of the page's buttons and tabs. */
const CONTROLS = `[...document.querySelectorAll('[role="button"], [role="tab"]')].map(node => node.getAttribute('aria-label') || node.innerText.trim())`

/**
 * How long the Jev stand-in waits before answering `jev-reorders`: with
 * the server's one-second pause, the lexicographic answer shows for about
 * 2.5 s. It stays under the server's three-second Jev timeout.
 */
const JEV_WAIT_MS = 1500

/** Where one row is among others, by its name. */
const at = (rows: SearchRow[], name: string): number =>
  rows.findIndex(row => rowName(row) === name)

/**
 * The Search tab's one field: every kind in one list, Jev's order taking
 * over from the lexicographic one, and neither a Jev failure nor older
 * typing ever reaching the screen.
 */
export default searchSpec({
  id: 'app-shell/search/one-field',
  title:
    'One field finds leagues, seasons, teams and people; Jev re-ranks them, and a Jev failure or older typing never shows',
  covers: COVERS,
  minutes: 4,
  scenarios: {
    'mixed-kinds': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'coach')
      await openSearch(ctx, web)
      await ctx.checkpoint('one-field', {
        expect: [{ text: exactly(SEARCH_HINT) }],
        readBack: async () => {
          const controls = (await web.page.evaluate(CONTROLS)) as string[]
          for (const kind of ['Leagues', 'Seasons', 'Teams'])
            expect(controls, 'no kind buttons').not.includes(kind)
        }
      })
      await typeSearch(web, `hawk ${tag}`)
      await answered(web, frames, `hawk ${tag}`)
      const ridge = named(world, 'Ridge Hawks')
      const own = named(world, 'Demo Hawks')
      await ctx.checkpoint('mixed-kinds', {
        expect: [
          { text: exactly(`Open ${named(world, 'Hawks League')}`) },
          { text: exactly(`Open ${named(world, 'Hawks Spring 2026')}`) },
          { text: exactly(`Open ${own}`) },
          { text: 'Open LaTroy Hawkins' },
          { text: exactly(`Follow ${ridge}`) },
          { text: exactly(`Follow ${own}`), absent: true }
        ],
        readBack: async () => {
          const { rows } = await answered(web, frames, `hawk ${tag}`)
          expect(rows.length, 'at most 50 rows').within(1, 50)
          const kinds = new Set(ownRows(rows, tag).map(rowKind))
          for (const row of rows.filter(row =>
            row.label.startsWith('Open LaTroy')
          ))
            kinds.add(rowKind(row))
          expect(
            [...kinds].sort((a, b) => (a ?? '').localeCompare(b ?? ''))
          ).deep.equals(['League', 'Person', 'Season', 'Team'])
          expect(
            rows.find(row => rowName(row) === own)?.follow,
            'no Follow on the coach’s own team'
          ).equals(null)
          expect(rows.find(row => rowName(row) === ridge)?.follow).equals(
            `Follow ${ridge}`
          )
        }
      })
      await proveScreen(ctx, web, 'search-screen-after.png')
    },

    'jev-reorders': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'coach')
      const jev = jevOf(ctx)
      const gold = named(world, 'Hawks Gold')
      const blue = named(world, 'Hawks Blue')
      const query = `hawk ${tag}`
      // Jev puts the 2026 team above the 2024 one, which the names put
      // first. Every other candidate gets 0, below both: a stack holding
      // other search worlds has their "Hawks" rows in this answer too, and
      // they must not push Hawks Blue out of the 50 shown. The stand-in
      // waits JEV_WAIT_MS, so the lexicographic answer stays on screen for
      // the server's one-second pause plus that: about 2.5 s to read it.
      await jev.set({
        queries: {
          [query]: {
            nouls: { [gold]: 0.95, [blue]: 0.05 },
            defaultNoul: 0,
            delayMs: JEV_WAIT_MS
          }
        }
      })
      await openSearch(ctx, web)
      // Only this world's rows are compared.
      const own = async (): Promise<SearchRow[]> =>
        ownRows(await readRows(web), tag)
      const both = (rows: SearchRow[]): void => {
        if (at(rows, gold) < 0 || at(rows, blue) < 0)
          throw new Error('not yet: a row is missing')
      }
      // The lexicographic answer to the whole query, read before Jev's
      // frame for the same search arrived. A read that Jev overtook proves
      // nothing either way, so the query is typed again.
      let typed = 0
      let lexicographic: { rows: SearchRow[]; seenAt: number } | undefined
      for (let attempt = 1; lexicographic == null; attempt++) {
        if (attempt > 1) await clearSearch(web)
        await typeSearch(web, query)
        typed = Date.now()
        try {
          lexicographic = await answered(web, frames, query, {
            stage: 'lexicographic',
            read: own,
            ready: both
          })
        } catch (error) {
          if (!(error instanceof Overtaken) || attempt >= 3) throw error
          proveLog(
            ctx,
            'jev-reorders.log',
            `attempt ${attempt}: ${error.message}\n`
          )
        }
      }
      const first = lexicographic.rows
      // The frame that asked for the whole query: the last keystroke as the
      // page sent it, which a slow driver or a reconnect can put after the
      // driver's own return.
      const asked = frames.lastSent()!
      expect(
        at(first, blue),
        'the lexicographic answer shows first: Hawks Blue above Hawks Gold'
      ).lessThan(at(first, gold))
      const reordered = (
        await answered(web, frames, query, {
          stage: 'jev',
          read: own,
          ready: rows => {
            both(rows)
            if (!(at(rows, gold) < at(rows, blue))) throw new Error('not yet')
          },
          timeoutMs: 6000
        })
      ).seenAt
      // Jev's own time: from the last keystroke, less the stand-in's wait.
      const jevMs = reordered - asked.at - JEV_WAIT_MS
      proveLog(
        ctx,
        'jev-reorders.log',
        `the page sent its last search frame ${asked.at - typed} ms after the driver typed (${frames.sockets()} socket${frames.sockets() === 1 ? '' : 's'}); ` +
          `lexicographic order read ${lexicographic.seenAt - asked.at} ms after that frame; ` +
          `Jev's order shown ${reordered - asked.at} ms after it (${reordered - typed} ms after typing), ` +
          `${jevMs} ms less the stand-in's ${JEV_WAIT_MS} ms wait\n`
      )
      // About 1.2 s: the one-second pause and the answer's trip.
      expect(jevMs, 'ms until Jev’s order, less the stand-in’s wait').lessThan(
        3500
      )
      await ctx.checkpoint('jev-order', {
        expect: [{ text: exactly(`Open ${gold}`) }],
        readBack: async () => {
          const seen = (await jev.read()).requests
          expect(
            seen.some(row => row.query === query && row.status === 200),
            'the stand-in ranked this search'
          ).equals(true)
          const rows = await own()
          expect(at(rows, blue), 'Hawks Blue still shown').greaterThan(-1)
          expect(at(rows, gold)).lessThan(at(rows, blue))
        }
      })
      await jev.set({})
    },

    'jev-down': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'coach')
      const jev = jevOf(ctx)
      await jev.set({ rule: { status: 529 } })
      await openSearch(ctx, web)
      const order = async (): Promise<string[]> =>
        ownRows(await readRows(web), tag).map(rowName)
      const settled = async (): Promise<string[]> => {
        const { rows: shown } = await answered(web, frames, `hawk ${tag}`, {
          read: order,
          ready: names => {
            if (names.length === 0) throw new Error('no rows yet')
          }
        })
        // Past Jev's pause and its answer.
        await new Promise(resolve => setTimeout(resolve, 2500))
        expect(await order(), 'the lexicographic order stays').deep.equals(
          shown
        )
        return shown
      }
      await typeSearch(web, `hawk ${tag}`)
      const failing = await settled()
      await ctx.checkpoint('jev-529', {
        expect: [{ text: exactly(`Open ${named(world, 'Hawks Blue')}`) }],
        readBack: async () => {
          expect(await alerts(web), 'no error shown').deep.equals([])
          const seen = (await jev.read()).requests
          expect(seen.map(row => row.status)).includes(529)
        }
      })

      // With no key, Jev is not asked at all.
      const admin = await apiClient(ctx, world.accounts.nodeAdmin)
      await admin.clearJevKey()
      await jev.set({})
      await clearSearch(web)
      await typeSearch(web, `hawk ${tag}`)
      expect(await settled()).deep.equals(failing)
      await ctx.checkpoint('no-key', {
        expect: [
          { text: exactly(`Open ${named(world, 'Hawks Blue')}`) },
          { text: 'Search needs a connection', absent: true }
        ],
        readBack: async () => {
          expect(await alerts(web)).deep.equals([])
          expect((await jev.read()).requests, 'Jev not asked').deep.equals([])
          expect((await admin.nodeSettings()).jev).deep.equals({
            configured: false
          })
        }
      })
    },

    'stale-typing': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'coach')
      const jev = jevOf(ctx)
      const gold = named(world, 'Hawks Gold')
      const blue = named(world, 'Hawks Blue')
      const older = `hawk ${tag}`
      // Jev's answer to the older typing would put Hawks Blue first, two
      // seconds late.
      await jev.set({
        queries: {
          [older]: { delayMs: 2000, nouls: { [blue]: 1, [gold]: 0 } }
        }
      })
      await openSearch(ctx, web)
      await typeSearch(web, older)
      // Past the one-second pause: its Jev call is on its way, two seconds
      // from an answer, when the newer typing comes.
      await new Promise(resolve => setTimeout(resolve, 1300))
      await typeSearch(web, ' gold')
      await new Promise(resolve => setTimeout(resolve, 4000))
      // The newer typing's answer, Jev's included, and nothing after it.
      const { rows: newer } = await answered(web, frames, `${older} gold`, {
        stage: 'jev'
      })
      await ctx.checkpoint('newer-rows-stay', {
        expect: [{ text: exactly(`Open ${gold}`) }],
        readBack: async () => {
          const rows = ownRows(newer, tag)
          expect(rowName(rows[0]), 'the newer typing’s first row').equals(gold)
          expect(at(rows, gold)).lessThan(at(rows, blue))
          const seen = (await jev.read()).requests
          expect(
            seen.some(row => row.query === older),
            'Jev was asked about the older typing'
          ).equals(true)
          expect(
            seen.some(row => row.query === `${older} gold`),
            'Jev ranked the newer typing'
          ).equals(true)
        }
      })
      await web.m.assertVisible({
        css: byLabel(`Open ${gold}`),
        timeout: 5000
      })
      await jev.set({})
    }
  }
})
