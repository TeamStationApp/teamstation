import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'

/**
 * Adding a player who already exists, from Set Team Rosters, on the web
 * scorer in the runner's browser through maestro-d, in the
 * `existing-player` world: the Falcons' coach, the guardian of Mookie
 * Betts (an Owl), and a Heron.
 *
 * W8 lists the people already found at once, lets the server's join them
 * over a slow network, and shows them alone offline with the field on.
 */

type Step = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7' | 'W8'

/**
 * Signs the coach in, opens the game's scoring screen, then runs `steps`:
 * each the legacy check of that name. `before` opens what the first step
 * expects open.
 */
async function adding(
  ctx: HarnessContext,
  before: Array<'rosters' | 'home-search'>,
  steps: Step[]
): Promise<void> {
  const world = await ctx.fixture('existing-player')
  await clearSignInLimits(ctx)
  const APP = ctx.stack.origin
  const API = `${ctx.stack.origin}/api/v1`
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  let browser: any
  /** Reads a value out of the page. */
  const probe = async <T>(script: string): Promise<T> => {
    await browser.evalBrowserScript({
      script: `return JSON.stringify(${script})`,
      output: 'probe'
    })
    return JSON.parse((await browser.vars()).probe) as T
  }
  const label = (name: string): string => `[aria-label="${name}"]`
  const tap = async (name: string): Promise<void> => {
    await browser.tapOn({ css: label(name), timeout: 15000 })
  }
  const shot = async (name: string): Promise<void> => {
    // A sheet slides up: let it land.
    await new Promise(resolve => setTimeout(resolve, 800))
    await browser.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
  }
  /** One API sign-in per account per run: the server limits attempts. */
  const tokens = new Map<string, string>()
  const tokenOf = async (role: string): Promise<string> => {
    const held = tokens.get(role)
    if (held != null) return held
    const token = await signInTestAccount(API, world.accounts[role])
    tokens.set(role, token)
    return token
  }
  /** Each role's own browser, signed in once through the password form. */
  const browsers = new Map<string, any>()
  /** Opens `path` as `role` in that role's browser, the one driven from then on. */
  const openAs = async (role: string, path: string): Promise<string> => {
    let m = browsers.get(role)
    if (m == null) {
      // The password form's signed-in check reads the phone layout's menu,
      // so the browser signs in at a phone's width and then widens.
      const session = await ctx.browser({ width: 390, height: 844 })
      m = session.m
      await m.openLink({ link: `${APP}/` })
      await ctx.signIn(role, m)
      await session.resize({ width: 1280, height: 900 })
      browsers.set(role, m)
    }
    browser = m
    await browser.openLink({ link: `${APP}${path}` })
    return await tokenOf(role)
  }
  /** A GET against the API as the holder of `token`. */
  const apiGet = async (
    token: string,
    path: string
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    return { status: response.status, body: await response.json() }
  }
  /** The candidate cards drawn, top to bottom, as their short names. */
  const candidates = async (): Promise<string[]> =>
    await probe<string[]>(
      `[...document.querySelectorAll('[aria-label^="Choose "]')].map(n => [n.getBoundingClientRect().top, n.getAttribute('aria-label').slice(7)]).sort((a, b) => a[0] - b[0]).map(p => p[1])`
    )
  /** Every candidate the list shows, scrolling it to its end page by page. */
  const allCandidates = async (): Promise<string[]> => {
    const seen: string[] = []
    for (let page = 0; page < 6; page++) {
      for (const name of await candidates())
        if (!seen.includes(name)) seen.push(name)
      await browser.evalBrowserScript({
        script: `const box = document.querySelector('[data-testid="Candidate list"] > div'); box.scrollTop += box.clientHeight; return ''`,
        output: 'scrolled'
      })
      await new Promise(resolve => setTimeout(resolve, 1200))
    }
    return seen
  }
  const openRosters = async (): Promise<void> => {
    await browser.assertVisible({
      css: label('Open scoring menu'),
      timeout: 60000
    })
    await tap('Open scoring menu')
    await browser.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
    await browser.assertVisible({ css: label('Roster'), timeout: 15000 })
  }
  const pageText = async (): Promise<string> =>
    await probe<string>('document.body.innerText')
  /** The accessible names of the Roster tab's cards, in order. */
  const rosterCards = async (): Promise<string[]> =>
    await probe<string[]>(
      `[...document.querySelectorAll('[data-testid="Edit roster players"] [role="button"]')].map(n => n.getAttribute('aria-label'))`
    )

  let coachToken = await openAs('coach', `/games/${world.ids.game}/score`)
  await browser.assertVisible({
    css: label('Open scoring menu'),
    timeout: 60000
  })
  for (const step of before) {
    if (step === 'rosters') await openRosters()
    else {
      await tap('Home Team')
      await tap('Add Existing Player')
    }
  }
  const STEPS: Record<Step, () => Promise<void>> = {
    // W1 opens Set Team Rosters on the roster, which ends in the two add rows
    W1: async () => {
      await tap('Open scoring menu')
      await browser.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
      await browser.assertVisible({ css: label('Roster'), timeout: 15000 })
      expect(
        await probe<string | null>(
          `document.querySelector('[aria-label="Roster"]').getAttribute('aria-selected')`
        )
      ).equals('true')
      const cards = await rosterCards()
      expect(cards.slice(-2)).deep.equals([
        'Create Player',
        'Add Existing Player'
      ])
      // One row: Cancel and Save, two buttons, either side of the microphone
      // when the server dictates.
      expect(
        await probe<string>(
          `Array.from(document.querySelector('[data-testid="Roster footer bar"]').children).filter(child => child.getAttribute('data-testid') !== 'Roster mic').map(child => child.textContent + ':' + child.querySelectorAll('[role="button"]').length).join('|')`
        )
      ).equals('Cancel:1|Save Rosters:1')
      await shot('web-roster-rows')
    },
    // W2 offers placeholders only, from Create Player, for the opposing team
    W2: async () => {
      await tap('Away Team')
      await tap('Create Player')
      await browser.assertVisible({
        css: label('Number of placeholder players'),
        timeout: 15000
      })
      expect(
        await probe<boolean>(
          `document.querySelector('[aria-label="First Name"]') == null`
        )
      ).equals(true)
      await shot('web-opposing-create-player')
      const cancels = await probe<number>(
        `document.querySelectorAll('[aria-label="Cancel"]').length`
      )
      expect(cancels).greaterThan(0)
      await browser.evalBrowserScript({
        script: `const all = document.querySelectorAll('[aria-label="Cancel"]'); all[all.length - 1].click(); return ''`,
        output: 'cancelled'
      })
    },
    // W3 lists the Owls first, then the season and league, finds them by name too, never a stranger or a Falcon
    W3: async () => {
      await tap('Home Team')
      await tap('Add Existing Player')
      await browser.assertVisible({
        css: label('Choose Aaron J'),
        timeout: 30000
      })
      // The coach's own team, by name: every card on the first screen is an Owl.
      const first = await candidates()
      expect(first[0]).equals('Aaron J')
      expect(
        await probe<number>(
          `document.querySelector('[data-testid="Candidate list"]').innerText.split('Ridgeview Owls').length - 1`
        )
      ).greaterThanOrEqual(first.length - 1)
      await shot('web-search-first-page')
      // One answer holds the engine's fifty, nearest first: the forty-two
      // Owls, then the season's players, then the league's.
      const all = await allCandidates()
      expect(all.length).lessThanOrEqual(50)
      const burnes = all.indexOf('Corbin B')
      expect(burnes, 'Burnes listed').greaterThan(-1)
      expect(all.indexOf('Max F'), 'Fried after Burnes').greaterThan(burnes)
      // Every Owl comes before anybody else.
      expect(
        all
          .slice(0, 42)
          .every(
            name => !['Corbin B', 'Max F', 'Ryan H', 'Jordan W'].includes(name)
          )
      ).equals(true)
      expect(all).not.includes('Jose R')
      expect(all).not.includes('Clayton K')
      for (const [typed, name] of [
        ['Corbin', 'Corbin B'],
        ['Max', 'Max F']
      ]) {
        await tap('Search players')
        await browser.inputText({ text: typed })
        await browser.assertVisible({
          css: label(`Choose ${name}`),
          timeout: 15000
        })
        await tap('Clear search')
        await browser.assertVisible({
          css: label('Choose Aaron J'),
          timeout: 15000
        })
      }
    },
    // W4 asks the search socket as each letter is typed, and never finds a stranger, by the name he shows or by his surname
    W4: async () => {
      // The browser's own record of what it fetched, from here on: the
      // search asks the socket, not `GET /users?forTeam=`.
      await browser.evalBrowserScript({
        script: `performance.clearResourceTimings(); performance.setResourceTimingBufferSize(1000); return ''`,
        output: 'counting'
      })
      // Jose Ramirez plays only for the Coastal Gulls, of another league:
      // outside the coach's reach. Three letters once found him as a stranger;
      // now they find only Jose Altuve, an Owl.
      await tap('Search players')
      await browser.inputText({ text: 'Jos' })
      await browser.assertVisible({
        css: label('Choose Jose A'),
        timeout: 15000
      })
      expect(await candidates()).not.includes('Jose R')
      expect(await pageText()).not.includes('Coastal Gulls')
      await shot('web-search-jos')
      await tap('Clear search')
      await browser.assertVisible({
        css: label('Choose Aaron J'),
        timeout: 15000
      })
      // His surname, or his whole name, finds nobody.
      for (const typed of ['Ramirez', 'Jose Ramirez']) {
        await tap('Search players')
        await browser.inputText({ text: typed })
        await browser.assertVisible({
          text: `.*No players match.*${typed}.*`,
          timeout: 15000
        })
        expect(await candidates()).not.includes('Jose R')
        await tap('Clear search')
        await browser.assertVisible({
          css: label('Choose Aaron J'),
          timeout: 15000
        })
      }
      await tap('Search players')
      await browser.inputText({ text: 'Mookie' })
      await browser.assertVisible({
        css: label('Choose Mookie B'),
        timeout: 15000
      })
      const asked = await probe<string[]>(
        `performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('forTeam'))`
      )
      console.log(
        `      candidate requests over HTTP while searching: ${JSON.stringify(asked)}`
      )
      expect(asked).deep.equals([])
      await tap('Clear search')
      await browser.assertVisible({
        css: label('Choose Aaron J'),
        timeout: 15000
      })
    },
    // W5 adds Betts to the Falcons with #50, and tells his guardian, who may reject
    W5: async () => {
      // Both his names typed whole find him, though the coach reads "Mookie B".
      await tap('Search players')
      await browser.inputText({ text: 'Mookie Betts' })
      await tap('Choose Mookie B')
      await browser.assertVisible({
        css: label('Add to Roster'),
        timeout: 15000
      })
      expect(
        await probe<boolean[]>(
          `['First Name', 'Last Name'].map(name => document.querySelector('[aria-label="' + name + '"]').readOnly)`
        )
      ).deep.equals([true, true])
      await shot('web-add-to-roster')
      await tap('Jersey Number')
      await browser.inputText({ text: '50' })
      await tap('Add to Roster')
      await browser.assertVisible({
        text: '.*Their guardians were notified.*',
        timeout: 15000
      })
      expect(
        (await rosterCards()).some(name =>
          name.startsWith('Mookie B, jersey 50')
        )
      ).equals(true)
      await shot('web-added-to-roster')
      await tap('Save Rosters')
      const roster = await apiGet(
        coachToken,
        `/teams/${world.ids.falcons}/roster`
      )
      const betts = (roster.body as any[]).find(
        entry => entry.userId === world.ids['Mookie Betts']
      )
      expect(betts).to.include({ shortName: 'Mookie B', jersey: '50' })

      await openAs('guardian', '/notifications')
      await browser.assertVisible({
        css: '[data-testid="notification-reject"]',
        timeout: 30000
      })
      // His guardian reads him in full.
      expect(await pageText()).includes('Mookie Betts')
      await shot('web-guardian-notice')
    },
    // W6 takes Betts off when his guardian rejects, and the next add needs approval
    W6: async () => {
      await browser.tapOn({
        css: '[data-testid="notification-reject"]',
        timeout: 15000
      })
      await browser.assertNotVisible({
        css: '[data-testid="notification-reject"]',
        timeout: 15000
      })
      const roster = await apiGet(
        coachToken,
        `/teams/${world.ids.falcons}/roster`
      )
      expect(
        (roster.body as any[]).some(
          entry =>
            entry.userId === world.ids['Mookie Betts'] &&
            entry.isPlayer === true
        )
      ).equals(false)

      coachToken = await openAs('coach', `/games/${world.ids.game}/score`)
      await openRosters()
      await tap('Home Team')
      await tap('Add Existing Player')
      await tap('Search players')
      await browser.inputText({ text: 'Mookie' })
      await tap('Choose Mookie B')
      await tap('Add to Roster')
      await browser.assertVisible({
        text: '.*needs approval first.*',
        timeout: 15000
      })
      await shot('web-approval-needed')
      // Back out of Add to Roster and the search.
      for (let sheet = 0; sheet < 2; sheet++)
        await browser.evalBrowserScript({
          script: `const all = document.querySelectorAll('[aria-label="Cancel"]'); all[all.length - 1].click(); return ''`,
          output: 'cancelled'
        })
    },
    // W7 adds Freeman to the Herons for this game only, and opens his page to no Heron
    W7: async () => {
      await tap('Away Team')
      await tap('Add Existing Player')
      await tap('Search players')
      await browser.inputText({ text: 'Freddie' })
      await tap('Choose Freddie F')
      // The Herons are not the coach's to manage: the pool is all there is.
      expect(
        await probe<boolean>(
          `document.querySelector('[aria-label="Add to Roster"]') == null`
        )
      ).equals(true)
      await tap('Add as Pool Player')
      await browser.assertVisible({
        text: '.*Freddie F was added.*',
        timeout: 15000
      })
      expect(await pageText()).includes('Game-only player')
      await shot('web-pool-player')
      await tap('Save Rosters')
      const heron = await tokenOf('heron')
      expect(
        (await apiGet(heron, `/players/${world.ids['Freddie Freeman']}`)).status
      ).equals(404)
    },
    // W8 lists the people already found at once, the server’s join them, and offline only those, with the field on
    W8: async () => {
      coachToken = await openAs('coach', `/games/${world.ids.game}/score`)
      await openRosters()
      await tap('Home Team')
      // Online: the first page, and a search, found once.
      await tap('Add Existing Player')
      await browser.assertVisible({
        css: label('Choose Aaron J'),
        timeout: 30000
      })
      await tap('Search players')
      await browser.inputText({ text: 'Mookie' })
      await browser.assertVisible({
        css: label('Choose Mookie B'),
        timeout: 15000
      })
      const closeSearch = async (): Promise<void> => {
        await browser.evalBrowserScript({
          script: `const all = document.querySelectorAll('[aria-label="Cancel"]'); all[all.length - 1].click(); return ''`,
          output: 'cancelled'
        })
        await new Promise(resolve => setTimeout(resolve, 800))
      }
      await closeSearch()
      const shownWithin = async (name: string): Promise<number> => {
        const started = Date.now()
        await tap('Add Existing Player')
        for (;;) {
          const listed = await candidates()
          if (listed.includes(name) || Date.now() - started > 20000) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        return Date.now() - started
      }
      // A slow network: the people found before are listed at once, and the
      // server's answer joins them when it comes.
      await browser.setNetworkConditions({ latency: 4000 })
      try {
        const took = await shownWithin('Aaron J')
        console.log(
          `      slow network: the people already found showed ${took} ms after the tap`
        )
        const loadingMore = await probe<boolean>(
          `document.querySelector('[data-testid="Candidates loading more"]') != null`
        )
        console.log(`      the server's page still on its way: ${loadingMore}`)
        expect(took).lessThan(2500)
        expect(loadingMore).equals(true)
        // Corbin Burnes, of the season, was not found before.
        await tap('Search players')
        await browser.inputText({ text: 'Corbin' })
        const started = Date.now()
        await browser.assertVisible({
          css: label('Choose Corbin B'),
          timeout: 30000
        })
        console.log(
          `      a person not found before arrived from the server ${Date.now() - started} ms after typing`
        )
        await closeSearch()
      } finally {
        await browser.setNetworkConditions({ latency: 0 })
      }
      // Offline: only the people found before, and the field still takes text.
      await browser.setNetworkConditions({ offline: true })
      try {
        const took = await shownWithin('Aaron J')
        const text = await pageText()
        const field = await probe<{ disabled: boolean; readOnly: boolean }>(
          `(n => ({ disabled: n.disabled, readOnly: n.readOnly }))(document.querySelector('[aria-label="Search players"]'))`
        )
        console.log(
          `      offline: listed ${JSON.stringify((await candidates()).slice(0, 3))}… ${took} ms after the tap; field ${JSON.stringify(field)}`
        )
        await shot('player-search-offline-after')
        expect(text).not.includes('Searching needs a connection.')
        expect(field).deep.equals({ disabled: false, readOnly: false })
        // Matched on the phone by the names it shows.
        await tap('Search players')
        await browser.inputText({ text: 'Moo' })
        await browser.assertVisible({
          css: label('Choose Mookie B'),
          timeout: 5000
        })
        expect(await candidates()).not.includes('Aaron J')
        await closeSearch()
      } finally {
        await browser.setNetworkConditions({ offline: false })
      }
    }
  }
  for (const step of steps) await STEPS[step]()
}

export default defineHarness({
  id: 'scoring/existing-player/add-from-rosters',
  title: 'Set Team Rosters adds a player who already exists',
  kind: 'e2e',
  covers: [
    'src/app/scoring/**',
    'src/server/routes/users.ts',
    'src/server/games/guestPlayers.ts'
  ],
  stack: 'isolated',
  fixtures: ['existing-player'],
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
  quarantine: {
    reason: '#361: "Jose Ramirez" no longer shows "No players match"',
    since: '2026-11-26',
    scenarios: ['search-socket']
  },
  scenarios: {
    'roster-rows': async ctx => {
      await adding(ctx, [], ['W1'])
    },
    'opposing-placeholders': async ctx => {
      await adding(ctx, ['rosters'], ['W2'])
    },
    'candidate-order': async ctx => {
      await adding(ctx, ['rosters'], ['W3'])
    },
    'search-socket': async ctx => {
      await adding(ctx, ['rosters', 'home-search'], ['W4'])
    },
    'guardian-rejects': async ctx => {
      await adding(ctx, ['rosters', 'home-search'], ['W5', 'W6'])
    },
    'pool-player': async ctx => {
      await adding(ctx, ['rosters'], ['W7'])
    },
    'offline-search': async ctx => {
      await adding(ctx, [], ['W8'])
    }
  }
})
