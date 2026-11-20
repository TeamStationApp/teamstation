import { expect } from 'chai'

import type { WebSession } from '../../../core/spec'
import {
  answered,
  apiClient,
  byLabel,
  byLabelStart,
  exactly,
  expectFieldOnTop,
  fieldPlacement,
  proveScreen,
  searchSpec,
  searchWorld,
  within
} from '../../../rigs/search/searchRig'

const SEARCH_PLAYERS = 'Search players'

/** The names the candidate list offers, as `Choose <name>`. */
const CHOICES = `[...document.querySelectorAll('[aria-label^="Choose "]')].map(node => node.getAttribute('aria-label').slice(7))`

/** The names the candidate list offers. */
async function choices(web: WebSession): Promise<string[]> {
  return (await web.page.evaluate(CHOICES)) as string[]
}

/** The Roster tab's cards, by their accessible names. */
const ROSTER_CARDS = `[...document.querySelectorAll('[data-testid="Edit roster players"] [role="button"]')].map(node => node.getAttribute('aria-label'))`

/**
 * Add Player finds people through the search engine, people only and
 * inside the adder's reach; offline, Set Team Rosters filters the players
 * the phone kept, and never shows rows an earlier query found.
 */
export default searchSpec({
  id: 'people/add-existing/engine',
  title:
    'Add Player finds only people in the adder’s groups, and offline filters the kept players with no stale rows',
  covers: [
    'src/app/hooks/useRosterCandidates.ts',
    'src/app/screens/AddPlayerScene.tsx',
    'src/app/scoring/ExistingPlayerSheet.tsx',
    'src/server/users/rosterCandidates.ts',
    'src/server/search/**'
  ],
  minutes: 5,
  scenarios: {
    'team-settings': async ctx => {
      const { world, web, frames } = await searchWorld(ctx, 'coach')
      const m = web.m
      // Each check reads the engine's answer to the whole typed text.
      const search = async (text: string): Promise<void> => {
        await m.tapOn({ css: byLabel(SEARCH_PLAYERS), timeout: 15000 })
        await m.inputText({ text })
        await answered(web, frames, text, { read: choices })
      }
      await m.openLink({
        link: `${ctx.stack.origin}/groups/team/${world.ids.team}/settings`
      })
      await m.assertVisible({ text: 'TEAM MANAGEMENT', timeout: 60000 })
      await m.tapOn({ text: 'Add Player', timeout: 15000 })
      await m.assertVisible({ css: byLabel(SEARCH_PLAYERS), timeout: 15000 })
      // A player of the same season.
      await search('Corbin')
      await ctx.checkpoint('same-season-found', {
        expect: [{ text: 'Choose Corbin.*' }],
        readBack: async () => {
          // At the top in a browser, as Search's (search/one-field).
          expectFieldOnTop(
            await fieldPlacement(
              web,
              '[data-testid="Player search field"]',
              byLabelStart('Choose ')
            )
          )
        }
      })
      await proveScreen(ctx, web, 'add-player-after.png')
      // A player only in another league is nobody, even by the whole name.
      await m.tapOn({ css: byLabel('Clear search'), timeout: 15000 })
      await search('Yoshinobu Yamamoto')
      await ctx.checkpoint('other-league-not-found', {
        expect: [
          { text: exactly('No players match “Yoshinobu Yamamoto”.') },
          { text: 'Choose Yoshinobu.*', absent: true }
        ]
      })
      // Adding works.
      await m.tapOn({ css: byLabel('Clear search'), timeout: 15000 })
      await search('Corbin')
      await m.tapOn({ css: byLabelStart('Choose Corbin'), timeout: 15000 })
      await m.assertVisible({ css: byLabel('Add to Roster'), timeout: 15000 })
      await m.tapOn({ css: byLabel('Jersey number'), timeout: 15000 })
      await m.inputText({ text: '39' })
      await m.tapOn({ css: byLabel('Add to Roster'), timeout: 15000 })
      const coach = await apiClient(ctx, world.accounts.coach)
      await ctx.checkpoint('added', {
        expect: [{ text: '.*Added Corbin.* to the roster.*' }],
        readBack: async () => {
          const roster = (await coach.roster(world.ids.team)) as Array<{
            userId?: string
          }>
          expect(
            roster.some(
              entry => entry.userId === world.accounts.seasonPlayer.userId
            ),
            'Corbin Burnes is on the roster'
          ).equals(true)
        }
      })
    },

    'scoring-offline': async ctx => {
      const { world, web, frames } = await searchWorld(ctx, 'coach')
      const m = web.m
      const type = async (text: string): Promise<void> => {
        await m.tapOn({ css: byLabel(SEARCH_PLAYERS), timeout: 15000 })
        await m.inputText({ text })
      }
      // Online, each check reads the engine's answer to the whole text.
      const search = async (text: string): Promise<void> => {
        await type(text)
        await answered(web, frames, text, { read: choices })
      }
      // The page's sockets, read (never acted on) to know when the search
      // socket is gone.
      const cdp = await web.page.createCDPSession()
      await cdp.send('Network.enable')
      const sockets = new Set<string>()
      cdp.on('Network.webSocketCreated', event => {
        sockets.add(event.requestId)
      })
      cdp.on('Network.webSocketClosed', event => {
        sockets.delete(event.requestId)
      })
      await m.openLink({
        link: `${ctx.stack.origin}/games/${world.ids.game}/score`
      })
      await m.assertVisible({
        css: byLabel('Open scoring menu'),
        timeout: 60000
      })
      await m.tapOn({ css: byLabel('Open scoring menu'), timeout: 15000 })
      await m.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
      await m.assertVisible({ css: byLabel('Roster'), timeout: 15000 })
      await m.tapOn({ css: byLabel('Home Team'), timeout: 15000 })

      // Online: add LaTroy Hawkins from the engine's answer.
      await m.tapOn({ css: byLabel('Add Existing Player'), timeout: 15000 })
      await m.assertVisible({ css: byLabelStart('Choose '), timeout: 30000 })
      await search('LaTroy')
      await m.tapOn({ css: byLabelStart('Choose LaTroy'), timeout: 15000 })
      await m.assertVisible({ css: byLabel('Add to Roster'), timeout: 15000 })
      await m.tapOn({ css: byLabel('Jersey Number'), timeout: 15000 })
      await m.inputText({ text: '32' })
      await m.tapOn({ css: byLabel('Add to Roster'), timeout: 15000 })
      await ctx.checkpoint('added-online', {
        readBack: async () => {
          await within(15000, async () => {
            const cards = (await web.page.evaluate(ROSTER_CARDS)) as string[]
            expect(
              cards.some(card => card?.startsWith('LaTroy')),
              'LaTroy Hawkins is on the home roster'
            ).equals(true)
          })
        }
      })

      // Online again: an earlier query that finds Max Fried.
      await m.tapOn({ css: byLabel('Add Existing Player'), timeout: 15000 })
      await m.assertVisible({ css: byLabelStart('Choose '), timeout: 30000 })
      await search('Max')
      await ctx.checkpoint('online-query', {
        expect: [{ text: 'Choose Max.*' }]
      })

      // Offline, for real. The stack's fault server drops the open search
      // socket and refuses every new one (`socket-drop`), and Chrome's
      // network goes, so no API call answers either; maestro-d still does
      // the acting. A scenario run under `detect` keeps the fault it was
      // given (`ctx.fault`). A checkpoint would read the browser's own
      // offline errors as the app's, so from here the checks are the
      // driver's and the page's.
      const setFault = ctx.stack.setFault
      if (setFault == null)
        ctx.degrade(
          'this target has no fault server to drop the search socket, so the browser may keep it open'
        )
      const owned = ctx.fault == null ? setFault : undefined
      await owned?.('socket-drop')
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1
      })
      try {
        // The socket's offline state: no search socket open, and none
        // opened since that stayed open.
        const gone = within(15000, async () => {
          if (sockets.size > 0)
            throw new Error(`${sockets.size} search socket(s) still open`)
        })
        // Without the fault server (degraded above) the browser may keep it.
        await (owned == null ? gone.catch(() => undefined) : gone)
        await m.tapOn({ css: byLabel('Clear search'), timeout: 15000 })
        await type('Corbin')
        await m.assertVisible({
          css: byLabelStart('Choose Corbin'),
          timeout: 15000
        })
        await m.assertNotVisible({ css: byLabelStart('Choose Max') })
        const shown = await choices(web)
        expect(shown.length, 'the kept players, filtered').greaterThan(0)
        expect(
          shown.every(name => name.startsWith('Corbin')),
          `only rows for "Corbin", none from the earlier query: ${shown.join(', ')}`
        ).equals(true)
        if (owned != null)
          expect(
            sockets.size,
            'no search socket reopened while offline'
          ).equals(0)
      } finally {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1
        })
        await owned?.(null)
      }
    }
  }
})
