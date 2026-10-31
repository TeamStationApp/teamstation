import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/* eslint-disable @typescript-eslint/prefer-optional-chain --
   The functions puppeteer runs in the page are transpiled by sucrase, which
   turns ?. and ?? into helpers the page does not have. */
import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import type { Page } from 'puppeteer'

import { fakeMicrophone } from '../../../e2e/rigs/fakeMicrophone'
import {
  type BrowserSession,
  browserSession,
  maestro
} from '../../../e2e/rigs/refinementsMaestro'
import { DEFAULT_DICTATION_MODEL } from '../../common/api'
import { ONE_CATEGORY_AT_A_TIME } from '../../common/scoring/rosterCommands'
import type { LineupFixture } from '../../server/dev/lineupFixture'
import { signInTestAccount } from '../../test/passwordFixtures'

/**
 * The roster screen and lineup dictation end to end, as the scorekeeper, in
 * maestro-d's Chromium at an iPhone's 402×874, against the real local stack:
 * the API (`npm start`), the web app built against it (`npm run start.web`)
 * and a game from `npm run lineup-fixture`, which every scenario makes
 * afresh, so none sees another's saves.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8180 \
 *   TS_API_TEST_URL=http://127.0.0.1:9180/api/v1 \
 *   TS_LINEUP_PASSWORD=<the fixture's password> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/scoring/lineupDictation.e2e.ts
 *
 * `TS_LINEUP_ARTIFACTS=<dir>` saves the screenshots E1, E2, R2, R5, S1, S4
 * and S5 take there, R1–R6's video, and S4's stored pinch runner as curl and
 * jq read it.
 *
 * The dictation scenarios play clips from `fixtures/audio` into the page's
 * microphone (`fakeMicrophone`): R into the roster screen's, S into the
 * scoring screen's. The recogniser and the model are the API's real ones,
 * and every sentence names the default model, Claude Haiku 5.5, which the
 * API must offer.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8180'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9180/api/v1'
const PASSWORD = process.env.TS_LINEUP_PASSWORD ?? ''
const ARTIFACTS = process.env.TS_LINEUP_ARTIFACTS
const WIDTH = 402
const HEIGHT = 874
const CLIPS = resolve('src/app/scoring/fixtures/audio')
/** The away lineup `setThisLineup.wav` says, in order. */
const NINE = [
  'Betts',
  'Springer',
  'Judge',
  'Altuve',
  'Bregman',
  'Alvarez',
  'Tucker',
  'Semien',
  'Pena'
]
const clip = (name: string): string =>
  readFileSync(join(CLIPS, `${name}.wav`)).toString('base64')

interface Box {
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

/** A new game, its rosters and the five people who use it. */
function lineupFixture(): LineupFixture {
  const out = execFileSync(
    'npm',
    ['run', '--silent', 'lineup-fixture', '--', '--password', PASSWORD],
    { encoding: 'utf8' }
  )
  return JSON.parse(out) as LineupFixture
}

describe('the roster screen for a scorekeeper', function () {
  let daemon: Awaited<ReturnType<typeof maestro>>
  let session: BrowserSession
  let page: Page
  let token: string

  before(async function () {
    if (PASSWORD === '')
      throw new Error('Supply TS_LINEUP_PASSWORD, the lineup fixture password')
    for (const url of [APP, API])
      if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
        throw new Error(`${url} must be a local server`)
    if (ARTIFACTS != null) await mkdir(ARTIFACTS, { recursive: true })
    const fixture = lineupFixture()
    token = await signInTestAccount(API, {
      email: fixture.users.scorekeeper.email,
      password: PASSWORD
    })
    daemon = await maestro(process.env.MAESTRO_D ?? 'lineupDictation')
    const support = join(tmpdir(), 'lineup-dictation-e2e')
    session = await browserSession(
      daemon,
      'lineup-scorekeeper',
      WIDTH,
      HEIGHT,
      support
    )
    page = session.page
    page.setDefaultTimeout(30000)
    // A silent microphone the R scenarios play their clips into, and every
    // dictation frame both ways, for what the API was asked and answered.
    await page.evaluateOnNewDocument(fakeMicrophone, '')
    await page.evaluateOnNewDocument(() => {
      const heard = { sent: [] as unknown[], received: [] as unknown[] }
      ;(window as any).__dictation = heard
      const Native = window.WebSocket
      const json = (data: unknown): unknown => {
        try {
          return JSON.parse(String(data))
        } catch {
          return null
        }
      }
      class Watched extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (!String(url).endsWith('/dictation')) return
          this.addEventListener('message', event => {
            heard.received.push(json(event.data))
          })
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          if (typeof data === 'string' && this.url.endsWith('/dictation'))
            heard.sent.push(json(data))
          super.send(data)
        }
      }
      window.WebSocket = Watched
    })
    await page.browserContext().setCookie({
      name: 'ts_session',
      value: encodeURIComponent(token),
      domain: new URL(APP).hostname,
      path: '/'
    })
  })

  after(async function () {
    await session?.m.detach()
    await daemon?.shutdown()
  })

  const box = async (selector: string): Promise<Box> => {
    await page.waitForSelector(selector)
    return await page.$eval(selector, node => {
      const r = node.getBoundingClientRect()
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom
      }
    })
  }
  const tap = async (label: string, role?: string): Promise<void> => {
    const css =
      role == null
        ? `[aria-label="${label}"]`
        : `[aria-label="${label}"][role="${role}"]`
    await page.waitForSelector(css)
    await session.m.tapOn({ css, timeout: 15000 })
  }
  const shot = async (name: string): Promise<void> => {
    if (ARTIFACTS == null) return
    await session.m.waitForAnimationToEnd()
    await writeFile(join(ARTIFACTS, name), await session.m.screenshot())
  }
  const saveDisabled = async (): Promise<boolean> =>
    await page.$eval(
      '[aria-label="Save Rosters"]',
      node => node.getAttribute('aria-disabled') === 'true'
    )
  const waitSave = async (disabled: boolean): Promise<void> => {
    await page.waitForFunction(
      disabled =>
        document
          .querySelector('[aria-label="Save Rosters"]')!
          .getAttribute('aria-disabled') === (disabled ? 'true' : null),
      { timeout: 10000 },
      disabled
    )
  }
  /** The batting order shown, as each row's text. */
  const lineup = async (): Promise<string[]> =>
    await page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes => nodes.map(node => String(node.textContent))
    )
  /** The names on the roster column or grid beside the lineup or field. */
  const bench = async (): Promise<string[]> =>
    await page.$$eval(
      '[data-roster-target="roster"] [data-roster-player]',
      nodes => nodes.map(node => String(node.textContent))
    )
  /** The scoring screen for this game, its help dismissed. */
  const scoreGame = async (gameId: string): Promise<void> => {
    await page.goto(`${APP}/games/${gameId}/score`, {
      waitUntil: 'domcontentloaded'
    })
    await page.waitForSelector('[aria-label="Open scoring menu"]', {
      timeout: 60000
    })
    for (const label of ['OK', 'Close'])
      if ((await page.$(`[aria-label="${label}"]`)) != null) await tap(label)
  }
  const openRosters = async (
    side?: 'Away Team' | 'Home Team'
  ): Promise<void> => {
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
    if (side != null) await tap(side, 'tab')
  }
  /**
   * Saves the lineups the fixture's fresh game opens on, as they stand. The
   * game holds none yet, so Save Rosters is lit with no change; once they
   * are saved it waits for one.
   */
  const acceptLineups = async (): Promise<void> => {
    await openRosters()
    await waitSave(false)
    await tap('Save Rosters')
    await page.waitForSelector('[aria-label="Save Rosters"]', { hidden: true })
    await page.waitForFunction(
      () => !document.body.textContent!.includes('Saving'),
      { timeout: 20000 }
    )
  }
  /**
   * A mouse drag of the lineup row at `from` to the boundary after `to`, or
   * before it with `before`: the press is held until the row lifts.
   */
  const dragRow = async (
    source: string,
    target: string,
    edge: 'before' | 'after'
  ): Promise<void> => {
    const at = async (
      selector: string,
      where: 'top' | 'bottom' | 'middle'
    ): Promise<{ x: number; y: number }> => {
      const r = await box(selector)
      return {
        x: r.x + Math.min(40, r.width / 2),
        y:
          where === 'top'
            ? r.y + 8
            : where === 'bottom'
              ? r.bottom - 8
              : r.y + r.height / 2
      }
    }
    const start = await at(source, 'middle')
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 750))
    const end = await at(target, edge === 'after' ? 'bottom' : 'top')
    await page.mouse.move(end.x, end.y, { steps: 12 })
    await new Promise(resolve => setTimeout(resolve, 200))
    await page.mouse.up()
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  it('E1: labels the tabs Roster, Lineup and Defense over a bar of Create Player, a round mic and a dim Save', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await acceptLineups()
    await openRosters('Home Team')
    const tabs = await page.$$eval('[role="tab"]', nodes =>
      nodes.map(node => node.getAttribute('aria-label'))
    )
    expect(tabs).deep.equals([
      'Away Team',
      'Home Team',
      'Roster',
      'Lineup',
      'Defense'
    ])
    for (const label of ['Roster', 'Lineup', 'Defense'])
      expect(
        await page.$eval(`[aria-label="${label}"]`, node => node.textContent)
      ).equals(label)
    for (const tab of ['Roster', 'Lineup', 'Defense']) {
      await tap(tab, 'tab')
      await page.waitForSelector(`[aria-label="${tab}"][aria-selected="true"]`)
      const add = await page.$eval('[aria-label="Create Player"]', node => {
        const words = node.querySelector('div')!
        const style = getComputedStyle(node)
        return {
          text: node.textContent,
          color: getComputedStyle(words).color,
          border: style.borderTopWidth,
          background: style.backgroundColor
        }
      })
      expect(add.text).equals('Create Player')
      // Green text, with no outline and no fill.
      const [red, green, blue] = add.color.match(/\d+/g)!.map(Number)
      expect(green).greaterThan(red + 60)
      expect(green).greaterThan(blue)
      expect(add.border).equals('0px')
      expect(add.background).equals('rgba(0, 0, 0, 0)')
      const bar = await box('[data-testid="Roster footer bar"]')
      const mic = await box('[data-testid="Roster mic"]')
      const save = await box('[aria-label="Save Rosters"]')
      const cancel = await box('[aria-label="Cancel"]')
      // Round, centred, and twelve points taller than Save Rosters.
      expect(mic.width).closeTo(mic.height, 0.5)
      expect(
        await page.$eval(
          '[data-testid="Roster mic"]',
          node => getComputedStyle(node).borderTopLeftRadius
        )
      ).equals(`${mic.width / 2}px`)
      expect(mic.x + mic.width / 2).closeTo(bar.x + bar.width / 2, 1)
      expect(mic.height).closeTo(save.height + 12, 0.5)
      expect(await saveDisabled()).equals(true)
      expect(
        Number(
          await page.$eval(
            '[aria-label="Save Rosters"]',
            node => getComputedStyle(node).opacity
          )
        )
      ).lessThan(1)
      // Cancel sits under the bar.
      expect(cancel.y).at.least(bar.bottom - 0.5)
      expect(cancel.bottom).at.most(HEIGHT)
      if (tab === 'Lineup') await shot('roster-lineup-after.png')
      if (tab === 'Defense') await shot('roster-defense-after.png')
    }
    await tap('Cancel')
  })

  it('E2: lights Save Rosters for a moved batter, dims it when he is moved back, and keeps a saved order', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await acceptLineups()
    await openRosters('Home Team')
    await tap('Lineup', 'tab')
    const original = await lineup()
    expect(original[0]).includes('Ohtani')
    await dragRow(
      '[data-roster-target="lineup-0"]',
      '[data-roster-target="lineup-2"]',
      'after'
    )
    const moved = await lineup()
    expect(moved[2]).includes('Ohtani')
    expect(moved[0]).includes('Lindor')
    await waitSave(false)
    await shot('roster-save-dirty.png')
    await dragRow(
      '[data-roster-target="lineup-2"]',
      '[data-roster-target="lineup-0"]',
      'before'
    )
    expect((await lineup()).map(row => row.replace(/^\d+\. /, ''))).deep.equals(
      original.map(row => row.replace(/^\d+\. /, ''))
    )
    await waitSave(true)
    await dragRow(
      '[data-roster-target="lineup-0"]',
      '[data-roster-target="lineup-2"]',
      'after'
    )
    const saved = await lineup()
    await waitSave(false)
    await tap('Save Rosters')
    await page.waitForSelector('[aria-label="Save Rosters"]', { hidden: true })
    // Saved to the server: a fresh page reads it back.
    await page.waitForFunction(
      () => !document.body.textContent!.includes('Saving'),
      { timeout: 20000 }
    )
    await scoreGame(fixture.gameId)
    await openRosters('Home Team')
    await tap('Lineup', 'tab')
    expect(await lineup()).deep.equals(saved)
    expect(await saveDisabled()).equals(true)
    await tap('Cancel')
    // Saved before the game, when nobody is due: the new leadoff, not
    // Ohtani, bats first once the visitors' half is over.
    const scoreboardSays = async (text: string): Promise<void> => {
      await page.waitForFunction(
        text =>
          String(
            document
              .querySelector('[aria-label*=" balls "]')!
              .getAttribute('aria-label')
          ).includes(text),
        { timeout: 30000 },
        text
      )
    }
    const tapEnabled = async (label: string): Promise<void> => {
      await page.waitForFunction(
        label => {
          const node = document.querySelector(`[aria-label="${label}"]`)
          return node != null && node.getAttribute('aria-disabled') !== 'true'
        },
        { timeout: 30000 },
        label
      )
      await tap(label)
    }
    await scoreboardSays('Batter Judge ')
    for (let i = 0; i < 3; i++) await tapEnabled('Called Strike')
    await scoreboardSays('1 outs')
    await page.waitForFunction(
      () => {
        const ball = document.querySelector('[aria-label="Ball"]')
        return ball != null && ball.getAttribute('aria-disabled') !== 'true'
      },
      { timeout: 30000 }
    )
    await tap('Open scoring menu')
    await tapEnabled('End Half Inning')
    await tapEnabled('Confirm End Half Inning')
    await scoreboardSays('Bottom 1st')
    await scoreboardSays('Batter Lindor ')
  })

  it('E3: builds the lineup by dragging from the roster, reordering and removing, and keeps it', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await openRosters('Away Team')
    await tap('Lineup', 'tab')
    expect((await bench()).join()).includes('Betts')
    await dragRow(
      '[data-roster-target="roster"] [data-roster-player]:first-child',
      '[data-roster-target="lineup-2"]',
      'before'
    )
    let rows = await lineup()
    expect(rows).length(10)
    const dragged = rows[2].replace(/^3\. /, '')
    expect(await bench()).not.includes(dragged)
    await dragRow(
      '[data-roster-target="lineup-1"]',
      '[data-roster-target="lineup-0"]',
      'before'
    )
    rows = await lineup()
    expect(rows[0]).includes('Altuve')
    expect(rows[1]).includes('Judge')
    expect(rows[2]).includes(dragged)
    await tap('Remove Bregman')
    rows = await lineup()
    expect(rows.join()).not.includes('Bregman')
    expect((await bench()).join()).includes('Bregman')
    const kept = await lineup()
    await waitSave(false)
    await tap('Save Rosters')
    await page.waitForSelector('[aria-label="Save Rosters"]', { hidden: true })
    await page.waitForFunction(
      () => !document.body.textContent!.includes('Saving'),
      { timeout: 20000 }
    )
    await scoreGame(fixture.gameId)
    await openRosters('Away Team')
    await tap('Lineup', 'tab')
    expect(await lineup()).deep.equals(kept)
    expect((await bench()).join()).includes('Bregman')
    await tap('Cancel')
  })

  it('E4: places a bench player at short, clears center and moves a fielder, and keeps the field', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await openRosters('Home Team')
    await tap('Defense', 'tab')
    const slot = async (position: string): Promise<string> =>
      await page.$eval(`[data-roster-target="defense-${position}"]`, node =>
        String(node.textContent)
      )
    const drop = async (name: string, position: string): Promise<void> => {
      const source = await page.$$eval(
        '[data-roster-target="roster"] [data-roster-player]',
        (nodes, name) =>
          nodes.findIndex(node => String(node.textContent).includes(name)),
        name
      )
      expect(source, name).at.least(0)
      const from = await page.$$eval(
        '[data-roster-target="roster"] [data-roster-player]',
        (nodes, index) => {
          const r = nodes[index].getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        },
        source
      )
      const to = await box(`[data-roster-target="defense-${position}"]`)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
        steps: 12
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      await page.mouse.up()
      await page.waitForFunction(
        (position, name) =>
          String(
            document.querySelector(
              `[data-roster-target="defense-${position}"]`
            )!.textContent
          ).includes(name),
        { timeout: 10000 },
        position,
        name
      )
    }
    expect(await slot('SS')).includes('Marte')
    await drop('Soto', 'SS')
    expect(await slot('SS')).includes('Soto')
    expect((await bench()).join()).includes('Marte')
    expect((await bench()).join()).not.includes('Soto')
    expect(await slot('CF')).includes('Canha')
    await tap('Clear CF')
    expect(await slot('CF')).not.includes('Canha')
    expect((await bench()).join()).includes('Canha')
    // The center fielder taken off now plays left, and center stays empty.
    await drop('Canha', 'LF')
    expect(await slot('LF')).includes('Canha')
    expect(await slot('CF')).not.includes('Canha')
    expect((await bench()).join()).not.includes('Canha')
    expect((await bench()).join()).includes('Escobar')
    await waitSave(false)
    await tap('Save Rosters')
    await page.waitForSelector('[aria-label="Save Rosters"]', { hidden: true })
    await page.waitForFunction(
      () => !document.body.textContent!.includes('Saving'),
      { timeout: 20000 }
    )
    await scoreGame(fixture.gameId)
    await openRosters('Home Team')
    await tap('Defense', 'tab')
    expect(await slot('SS')).includes('Soto')
    expect(await slot('LF')).includes('Canha')
    expect(await page.$('[aria-label="Assign CF"]')).not.equals(null)
    await tap('Cancel')
  })

  it('E5: keeps the bar inside the screen, clear of the lists and of itself, on every tab and under the player sheet', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await openRosters('Home Team')
    const inside = (b: Box): void => {
      expect(b.x).at.least(-0.5)
      expect(b.y).at.least(-0.5)
      expect(b.right).at.most(WIDTH + 0.5)
      expect(b.bottom).at.most(HEIGHT + 0.5)
    }
    const apart = (a: Box, b: Box): void => {
      expect(a.right <= b.x + 0.5 || b.right <= a.x + 0.5).equals(true)
    }
    const lists: Record<string, string[]> = {
      Roster: ['[data-testid="Edit roster players"]'],
      Lineup: [
        '[aria-label="Roster players"]',
        '[aria-label="Batting lineup"]'
      ],
      Defense: ['[aria-label="Roster players"]']
    }
    for (const tab of ['Roster', 'Lineup', 'Defense']) {
      await tap(tab, 'tab')
      await page.waitForSelector(`[aria-label="${tab}"][aria-selected="true"]`)
      await new Promise(resolve => setTimeout(resolve, 300))
      const footer = await box('[data-testid="Roster footer"]')
      inside(footer)
      const add = await box('[aria-label="Create Player"]')
      const mic = await box('[data-testid="Roster mic"]')
      const save = await box('[aria-label="Save Rosters"]')
      const cancel = await box('[aria-label="Cancel"]')
      for (const each of [add, mic, save, cancel]) inside(each)
      apart(add, mic)
      apart(mic, save)
      apart(add, save)
      for (const selector of lists[tab]) {
        const list = await box(selector)
        // The list ends above the bar, and scrolls under it rather than
        // running into it.
        expect(list.bottom, `${tab} ${selector}`).at.most(footer.y + 0.5)
        const overflow = await page.$eval(selector, node => {
          const style = getComputedStyle(node)
          return style.overflowY
        })
        expect(['auto', 'scroll']).includes(overflow)
      }
    }
    await tap('Create Player')
    await page.waitForSelector('[aria-label="First Name"]')
    await new Promise(resolve => setTimeout(resolve, 500))
    const sheets = await page.$$('[data-testid="Scoring sheet"]')
    const entry = await sheets.at(-1)!.evaluate(node => {
      const r = node.getBoundingClientRect()
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom
      }
    })
    inside(entry)
    const controls = await sheets
      .at(-1)!
      .$$eval('[aria-label="Create Player"], [aria-label="Cancel"]', nodes =>
        nodes.map(node => {
          const r = node.getBoundingClientRect()
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            right: r.right,
            bottom: r.bottom
          }
        })
      )
    expect(controls.length).at.least(2)
    for (const control of controls) inside(control)
    inside(await box('[data-testid="Roster footer"]'))
    const close = await sheets.at(-1)!.$('[aria-label="Cancel"]')
    await close!.click()
    await page.waitForSelector('[aria-label="First Name"]', { hidden: true })
    expect(await page.$('[aria-label="Cancel"]')).not.equals(null)
    await tap('Cancel')
  })

  /** The roster screen's own microphone, not the scoring screen's under it. */
  const ROSTER_MIC = '[data-testid="Roster mic"] [aria-label="Dictation"]'
  /** The scoring screen's microphone pill, with the roster sheet closed. */
  const SCORING_MIC = '[aria-label="Dictation"]'
  const statusOf = (mic: string): string =>
    mic === ROSTER_MIC
      ? '[data-testid="Roster mic"] [aria-label="Dictation status"]'
      : '[aria-label="Dictation status"]'
  const status = async (mic = ROSTER_MIC): Promise<string | null> =>
    await page.evaluate(selector => {
      const node = document.querySelector(selector)
      return node == null ? null : node.textContent
    }, statusOf(mic))
  const waitStatus = async (text: string, mic = ROSTER_MIC): Promise<void> => {
    await page.waitForFunction(
      (text, selector) => {
        const node = document.querySelector(selector)
        return node != null && node.textContent === text
      },
      { timeout: 30000 },
      text,
      statusOf(mic)
    )
  }
  /** A tap on the round microphone, which switches it on. */
  const switchOn = async (): Promise<void> => {
    const mic = await box(ROSTER_MIC)
    await page.mouse.click(mic.x + mic.width / 2, mic.y + mic.height / 2)
    await waitStatus('Push to talk')
  }
  /** A tap on the scoring screen's microphone pill, which switches it on. */
  const scoringMicOn = async (): Promise<void> => {
    await page.waitForSelector(SCORING_MIC, { timeout: 30000 })
    const pill = await box(SCORING_MIC)
    await page.mouse.click(pill.x + pill.width / 2, pill.y + pill.height / 2)
    await waitStatus('Push to talk', SCORING_MIC)
  }
  /** The sheet closed, the scoring screen's microphone is on again by itself. */
  const scoringMicBackOn = async (): Promise<void> => {
    await page.waitForSelector('[aria-label="Save Rosters"]', { hidden: true })
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[aria-label="Dictation"]')
        return node != null && node.getAttribute('aria-pressed') === 'true'
      },
      { timeout: 15000 }
    )
  }
  /** The models each sentence so far asked the API for. */
  const models = async (): Promise<string[]> =>
    await page.evaluate(() =>
      (window as any).__dictation.sent
        .filter((frame: any) => frame != null && frame.kind === 'start')
        .map((frame: any) => frame.model)
    )
  /** The API's last reply to the last sentence: actions, a question or an error. */
  const reply = async (
    kinds = ['actions', 'ask', 'error']
  ): Promise<Record<string, any>> => {
    const handle = await page.waitForFunction(
      kinds => {
        const heard = (window as any).__dictation
        const starts = heard.sent.filter(
          (frame: any) => frame != null && frame.kind === 'start'
        )
        const start = starts[starts.length - 1]
        if (start == null) return null
        const answers = heard.received.filter(
          (frame: any) =>
            frame != null && frame.id === start.id && kinds.includes(frame.kind)
        )
        return answers.length === 0 ? null : answers[answers.length - 1]
      },
      { timeout: 90000 },
      kinds
    )
    return (await handle.jsonValue()) as Record<string, any>
  }
  const used: string[] = []
  /**
   * Holds a microphone — the roster screen's, or the scoring screen's pill —
   * while a clip plays into it, and a moment after, and waits for the API's
   * answer.
   */
  const dictate = async (
    name: string,
    microphone = ROSTER_MIC
  ): Promise<Record<string, any>> => {
    expect(await status(microphone)).equals('Push to talk')
    const mic = await box(microphone)
    await page.mouse.move(mic.x + mic.width / 2, mic.y + mic.height / 2)
    await page.mouse.down()
    await waitStatus('Listening…', microphone)
    await page.evaluate(async wav => {
      await (window as any).__playClip(wav)
    }, clip(name))
    await new Promise(resolve => setTimeout(resolve, 600))
    await page.mouse.up()
    const answer = await reply()
    const asked = await models()
    expect(asked.at(-1), `${name}: the model asked for`).equals(
      DEFAULT_DICTATION_MODEL
    )
    used.push(`${name}: ${String(asked.at(-1))}`)
    console.log(
      `    ${name} (${String(asked.at(-1))}): ${JSON.stringify(answer)}`
    )
    return answer
  }
  const tabOn = async (label: string): Promise<void> => {
    await page.waitForSelector(
      `[aria-label="${label}"][role="tab"][aria-selected="true"]`,
      { timeout: 15000 }
    )
  }
  const texts = async (testId: string): Promise<string[]> =>
    await page.$$eval(`[data-testid="${testId}"]`, nodes =>
      nodes.map(node => String(node.textContent))
    )
  const slot = async (position: string): Promise<string> =>
    await page.$eval(`[data-roster-target="defense-${position}"]`, node =>
      String(node.textContent)
    )
  /** A lineup's names: each row is its handle, `3. #1 Judge`, and its ×. */
  const names = (rows: string[]): string[] =>
    rows.map(row => row.replace(/^\D*\d+\. (#\d+ )?/, '').replace(/×$/, ''))

  after(function () {
    if (used.length > 0) console.log(`    models: ${used.join('; ')}`)
  })

  /** The scoreboard names `name` as the batter. */
  const batterSaid = async (name: string): Promise<void> => {
    await page.waitForFunction(
      name =>
        String(
          document
            .querySelector('[aria-label*=" balls "]')!
            .getAttribute('aria-label')
        ).includes(`Batter ${name} `),
      { timeout: 30000 },
      name
    )
  }

  it('R1, R3, R6: stages a dictated lineup change and then a whole lineup, and saves both', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await acceptLineups()
    // The scoring screen's microphone, switched on, goes to the sheet on.
    await scoringMicOn()
    // maestro-d does not record a web session, so puppeteer does, as WebM;
    // its successor, `record`, writes MP4 only.
    const recording =
      ARTIFACTS == null
        ? undefined
        : // eslint-disable-next-line @typescript-eslint/no-deprecated
          await page.screencast({
            path: join(ARTIFACTS, 'roster-dictation.webm') as `${string}.webm`
          })
    try {
      await openRosters('Away Team')
      await tap('Roster', 'tab')
      await tabOn('Roster')
      await waitStatus('Push to talk')
      expect(
        await page.$eval(ROSTER_MIC, node => node.getAttribute('aria-pressed'))
      ).equals('true')
      expect(await saveDisabled()).equals(true)

      // R1
      const first = await dictate('lineupJudgeFourth')
      expect(first.kind).equals('actions')
      await tabOn('Lineup')
      await tabOn('Away Team')
      expect((await lineup())[3]).includes('Judge')
      expect(await texts('Roster chat line')).deep.equals([
        'Judge to 4th in the lineup'
      ])
      const said = await page.$eval(
        '[data-testid="Roster chat said"]',
        node => {
          const style = getComputedStyle(node)
          return {
            text: node.textContent,
            align: style.textAlign,
            italic: style.fontStyle,
            color: style.color
          }
        }
      )
      expect(said.text).equals(first.transcript)
      expect(said).deep.include({
        align: 'right',
        italic: 'italic',
        color: 'rgb(255, 255, 255)'
      })
      const line = await page.$eval(
        '[data-testid="Roster chat line"]',
        node => getComputedStyle(node).textAlign
      )
      expect(line).equals('left')
      await waitSave(false)

      // R3
      const second = await dictate('setThisLineup')
      expect(second.kind).equals('actions')
      await page.waitForFunction(
        first =>
          String(
            document.querySelector('[data-roster-target="lineup-0"]')!
              .textContent
          ).includes(first),
        { timeout: 10000 },
        NINE[0]
      )
      expect(names(await lineup())).deep.equals(NINE)
      const benched = (await bench()).join()
      for (const name of ['Diaz', 'Maldonado', 'Valdez', 'Freeman'])
        expect(benched).includes(name)
      expect(await texts('Roster chat said')).has.length(2)

      // R6
      await waitSave(false)
      await tap('Save Rosters')
      await page.waitForSelector('[aria-label="Save Rosters"]', {
        hidden: true
      })
      expect(await page.$('[data-testid="Roster chat"]')).equals(null)
      await page.waitForFunction(
        () => !document.body.textContent!.includes('Saving'),
        { timeout: 20000 }
      )
      // The scoring screen has the change, one step for Undo, and its
      // microphone back on.
      await page.waitForSelector('[aria-label="Undo Set team roster"]', {
        timeout: 15000
      })
      await scoringMicBackOn()
      // Saved before the game, when nobody is due: the new order's leadoff
      // is the batter, not Judge.
      await batterSaid('Betts')
      await new Promise(resolve => setTimeout(resolve, 1000))
    } finally {
      await recording?.stop()
    }
    const response = await fetch(`${API}/games/${fixture.gameId}/lineups`, {
      headers: { cookie: `ts_session=${encodeURIComponent(token)}` }
    })
    const saved = (await response.json()) as {
      away: { current: { batters: Array<{ name: string }> } | null }
    }
    expect(saved.away.current!.batters.map(batter => batter.name)).deep.equals(
      NINE
    )
    // And a fresh page reads it back: Betts up, the sheet in that order.
    await scoreGame(fixture.gameId)
    await batterSaid('Betts')
    await openRosters('Away Team')
    await tap('Lineup', 'tab')
    expect(names(await lineup())).deep.equals(NINE)
    await tap('Cancel')
  })

  it('R2: stages three positions on the Defense tab of the team said, leaving the order', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    // The scoring screen's microphone goes to the sheet on, and comes back
    // on after Cancel as it does after Save (R6).
    await scoringMicOn()
    await openRosters('Home Team')
    await tap('Lineup', 'tab')
    const order = await lineup()
    await tap('Away Team', 'tab')
    await tap('Roster', 'tab')
    await tabOn('Roster')
    await waitStatus('Push to talk')
    const answer = await dictate('defenseThree')
    expect(answer.kind).equals('actions')
    await tabOn('Defense')
    await tabOn('Home Team')
    expect(await slot('SS')).includes('Soto')
    expect(await slot('2B')).includes('Harper')
    expect(await slot('CF')).includes('Turner')
    expect(await texts('Roster chat line')).to.include.members([
      'Soto to SS',
      'Harper to 2B',
      'Turner to CF'
    ])
    await waitSave(false)
    await shot('roster-chat-defense.png')
    await tap('Lineup', 'tab')
    expect(await lineup()).deep.equals(order)
    await tap('Cancel')
    await scoringMicBackOn()
  })

  it('R4: refuses a lineup change and a defense change in one sentence, staging nothing', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await acceptLineups()
    await openRosters('Away Team')
    await tap('Lineup', 'tab')
    const order = await lineup()
    await tap('Roster', 'tab')
    await tabOn('Roster')
    await switchOn()
    const answer = await dictate('mixedLineupDefense')
    expect(answer.kind).equals('actions')
    await page.waitForSelector('[data-testid="Roster chat problem"]')
    expect(await texts('Roster chat problem')).deep.equals([
      ONE_CATEGORY_AT_A_TIME
    ])
    await tabOn('Roster')
    expect(await saveDisabled()).equals(true)
    await tap('Lineup', 'tab')
    expect(await lineup()).deep.equals(order)
    await tap('Cancel')
  })

  it('R5: asks which team’s Freeman in the chat, and stages Home’s at first', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    await acceptLineups()
    await openRosters('Away Team')
    await tap('Roster', 'tab')
    await tabOn('Roster')
    await switchOn()
    // The model reports Freeman as said; the screen finds one on each team
    // and asks which, staging nothing until he is chosen.
    const said = await dictate('freemanAtFirst')
    expect(said.kind).equals('actions')
    expect(said.actions).deep.equals([])
    expect(said.roster).has.length(1)
    await page.waitForSelector(
      '[data-testid="Roster chat"] [aria-label="Dictation question"]'
    )
    const options = await page.$$eval(
      '[data-testid="Roster chat"] [aria-label="Dictation question"] [role="button"]',
      nodes => nodes.map(node => String(node.getAttribute('aria-label')))
    )
    const home = options.find(label => /home|hosts/i.test(label))
    expect(home, options.join(', ')).not.equals(undefined)
    expect(options.some(label => /away|visitors/i.test(label))).equals(true)
    expect(await saveDisabled()).equals(true)
    await shot('roster-chat-ask.png')
    await tap(home!)
    await tabOn('Defense')
    await tabOn('Home Team')
    expect(await slot('1B')).includes('Freeman')
    expect(await page.$('[aria-label="Dictation question"]')).equals(null)
    await waitSave(false)
    await tap('Cancel')
  })

  /** Each side's batting order as the fixture opens the game. */
  const OPENING = {
    away: [
      'Judge',
      'Altuve',
      'Bregman',
      'Alvarez',
      'Tucker',
      'Pena',
      'Diaz',
      'Maldonado',
      'Valdez'
    ],
    home: [
      'Ohtani',
      'Lindor',
      'Alonso',
      'Nimmo',
      'Marte',
      'McNeil',
      'Escobar',
      'Canha',
      'Senga'
    ]
  }
  interface Saved {
    batters: Array<{ name: string }>
    defense: Record<string, { name: string } | null>
  }
  /** The lineups the API has for the game now. */
  const lineups = async (
    gameId: string
  ): Promise<{ away: Saved; home: Saved }> => {
    const response = await fetch(`${API}/games/${gameId}/lineups`, {
      headers: { cookie: `ts_session=${encodeURIComponent(token)}` }
    })
    const body = (await response.json()) as {
      away: { current: Saved }
      home: { current: Saved }
    }
    return { away: body.away.current, home: body.home.current }
  }
  /** Every play event the API has stored for the game, the open play's last. */
  const storedEvents = async (
    gameId: string
  ): Promise<Array<Record<string, any>>> => {
    const response = await fetch(`${API}/games/${gameId}/events`, {
      headers: { cookie: `ts_session=${encodeURIComponent(token)}` }
    })
    const body = (await response.json()) as {
      plays: Array<{ gumbo: { playEvents: Array<Record<string, any>> } }>
      currentPlay: { playEvents: Array<Record<string, any>> } | null
    }
    return [
      ...body.plays.flatMap(play => play.gumbo.playEvents),
      ...(body.currentPlay?.playEvents ?? [])
    ]
  }
  /** A control that takes a tap once it is enabled, tapped. */
  const tapEnabled = async (label: string): Promise<void> => {
    await page.waitForFunction(
      label => {
        const node = document.querySelector(`[aria-label="${label}"]`)
        return node != null && node.getAttribute('aria-disabled') !== 'true'
      },
      { timeout: 30000 },
      label
    )
    await tap(label)
  }
  /** Every save has gone out and come back. */
  const waitSaved = async (): Promise<void> => {
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 30000 })
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Save status"]') == null,
      { timeout: 30000 }
    )
  }
  /** The scoreboard's summary: score, half inning, count and outs. */
  const scoreboard = async (): Promise<string> =>
    await page.$eval('[aria-label*=" balls "]', node =>
      String(node.getAttribute('aria-label'))
    )
  /**
   * The game begun and at the top of the second: the leadoff man struck out
   * looking, then both halves of the first ended from the menu. Altuve, the
   * visitors' second batter, is due up.
   */
  const topOfSecond = async (gameId: string): Promise<void> => {
    await scoreGame(gameId)
    for (let i = 0; i < 3; i++) await tapEnabled('Called Strike')
    // Struck out: the next batter is up, the pitch buttons waiting for him.
    await page.waitForFunction(
      () =>
        String(
          document
            .querySelector('[aria-label*=" balls "]')!
            .getAttribute('aria-label')
        ).includes('1 outs'),
      { timeout: 15000 }
    )
    for (const half of ['Top 1st', 'Bottom 1st']) {
      await page.waitForFunction(
        half =>
          String(
            document
              .querySelector('[aria-label*=" balls "]')!
              .getAttribute('aria-label')
          ).includes(half),
        { timeout: 15000 },
        half
      )
      // At rest: the pitch buttons take a tap.
      await page.waitForFunction(
        () => {
          const ball = document.querySelector('[aria-label="Ball"]')
          return ball != null && ball.getAttribute('aria-disabled') !== 'true'
        },
        { timeout: 30000 }
      )
      await tap('Open scoring menu')
      await tapEnabled('End Half Inning')
      await tapEnabled('Confirm End Half Inning')
      await page.waitForSelector('[aria-label="Confirm End Half Inning"]', {
        hidden: true
      })
    }
    await page.waitForFunction(
      () =>
        String(
          document
            .querySelector('[aria-label*=" balls "]')!
            .getAttribute('aria-label')
        ).includes('Top 2nd'),
      { timeout: 15000 }
    )
    await waitSaved()
  }
  /**
   * A walk is decided and stays open for correction for a while; once it
   * closes, the next batter is up and every save has come back.
   */
  const batterUp = async (name: string): Promise<void> => {
    await page.waitForFunction(
      name =>
        String(
          document
            .querySelector('[aria-label*=" balls "]')!
            .getAttribute('aria-label')
        ).includes(`Batter ${name} `),
      { timeout: 30000 },
      name
    )
    await waitSaved()
  }
  /** The roster sheet, opened by a sentence said on the scoring screen. */
  const sheetOpened = async (): Promise<void> => {
    await page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
  }

  it('S1: opens the sheet on Defense of the side in the field with a substitution said on the scoring screen by a jersey both teams wear, and saves it', async function () {
    const fixture = lineupFixture()
    await topOfSecond(fixture.gameId)
    await scoringMicOn()
    // "Number 3 subs in at third base": both teams have a #3. The model
    // reports the number as said, and the screen takes the side in the
    // field's, Alonso, from first base, with no question. A side the model
    // adds unasked is at most the side in the field's own.
    const answer = await dictate('subThirdBase', SCORING_MIC)
    expect(answer.transcript).match(/\b(3|three)\b/i)
    expect(answer.kind).equals('actions')
    expect(answer.actions).deep.equals([])
    expect(JSON.stringify(answer.roster)).not.match(/"side":"away"/)
    await sheetOpened()
    await tabOn('Defense')
    await tabOn('Home Team')
    expect(await slot('3B')).includes('Alonso')
    expect(await texts('Roster chat said')).deep.equals([answer.transcript])
    expect(await texts('Roster chat line')).includes('Alonso to 3B')
    await waitSave(false)
    await shot('scoring-sub-third.png')
    await tap('Lineup', 'tab')
    expect(names(await lineup())).deep.equals(OPENING.home)
    await tap('Save Rosters')
    await scoringMicBackOn()
    await page.waitForSelector('[aria-label="Undo Set team roster"]')
    await waitSaved()
    const saved = await lineups(fixture.gameId)
    expect(saved.home.defense['3B']!.name).equals('Alonso')
    expect(saved.home.batters.map(batter => batter.name)).deep.equals(
      OPENING.home
    )
  })

  it('S2: stages a new pitcher said on the scoring screen, and Cancel leaves the pitcher', async function () {
    const fixture = lineupFixture()
    await topOfSecond(fixture.gameId)
    await scoringMicOn()
    const answer = await dictate('sotoPitches', SCORING_MIC)
    expect(answer.kind).equals('actions')
    await sheetOpened()
    await tabOn('Defense')
    await tabOn('Home Team')
    expect(await slot('P')).includes('Soto')
    await waitSave(false)
    await tap('Cancel')
    await scoringMicBackOn()
    expect(await page.$('[aria-label="Undo Set team roster"]')).equals(null)
    await waitSaved()
    const saved = await lineups(fixture.gameId)
    expect(saved.home.defense.P!.name).equals('Ohtani')
  })

  it('S3: puts a pinch hitter said on the scoring screen in the due batter’s slot, and he bats', async function () {
    const fixture = lineupFixture()
    await topOfSecond(fixture.gameId)
    await scoringMicOn()
    const answer = await dictate('bettsPinchHits', SCORING_MIC)
    expect(answer.kind).equals('actions')
    await sheetOpened()
    await tabOn('Lineup')
    await tabOn('Away Team')
    // Altuve was due; Betts takes his place in the order.
    const staged = names(await lineup())
    expect(staged).deep.equals(
      OPENING.away.map(name => (name === 'Altuve' ? 'Betts' : name))
    )
    expect(await texts('Roster chat line')).deep.equals([
      'Betts pinch-hits for Altuve'
    ])
    await waitSave(false)
    await tap('Save Rosters')
    await scoringMicBackOn()
    await page.waitForSelector('[aria-label="Undo Set team roster"]')
    await waitSaved()
    const saved = await lineups(fixture.gameId)
    expect(saved.away.batters.map(batter => batter.name)).deep.equals(staged)
    // He is the batter now: the scoreboard names him, and the next pitch,
    // saved, is to him.
    await batterUp('Betts')
    await tapEnabled('Ball')
    await waitSaved()
    expect((await storedEvents(fixture.gameId)).at(-1)!.isPitch).equals(true)
    const response = await fetch(`${API}/games/${fixture.gameId}/events`, {
      headers: { cookie: `ts_session=${encodeURIComponent(token)}` }
    })
    const body = (await response.json()) as {
      currentPlay: { matchup: { batter: { fullName: string } } }
    }
    expect(body.currentPlay.matchup.batter.fullName).equals('Betts')
  })

  it('S4: stages a pinch runner said on the scoring screen, keeps the order, and one Undo takes it back', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    // Two walks: Judge on second, Altuve on first.
    for (let i = 0; i < 8; i++) await tapEnabled('Ball')
    await batterUp('Bregman')
    await scoringMicOn()
    const answer = await dictate('freemanRunsSecond', SCORING_MIC)
    expect(answer.kind).equals('actions')
    await sheetOpened()
    await tabOn('Lineup')
    await tabOn('Away Team')
    expect(names(await lineup())).deep.equals(OPENING.away)
    expect(await texts('Roster chat line')).deep.equals([
      'Freeman runs for Judge'
    ])
    await waitSave(false)
    await tap('Save Rosters')
    await scoringMicBackOn()
    const undo = '[aria-label="Undo Set team roster"]'
    await page.waitForSelector(undo)
    await waitSaved()
    expect(await page.$eval(undo, node => String(node.textContent))).includes(
      'Freeman runs for Judge'
    )
    await shot('scoring-pinch-runner.png')
    const runner = (await storedEvents(fixture.gameId)).filter(
      event => event.details?.eventType === 'ts_courtesy_runner'
    )
    expect(runner).has.length(1)
    expect(runner[0].details.description).equals(
      'Pinch-runner Freeman runs for Judge; the batting order is unchanged'
    )
    expect(runner[0]).not.has.property('runners')
    const saved = await lineups(fixture.gameId)
    expect(saved.away.batters.map(batter => batter.name)).deep.equals(
      OPENING.away
    )
    if (ARTIFACTS != null) {
      // The stored event and the order, as curl and jq read them, the
      // session in a variable rather than in the log.
      const run = (path: string, filter: string): string => {
        const command = `curl -s -H "Cookie: ts_session=$TS_SESSION" ${API}/games/${fixture.gameId}/${path} | jq '${filter}'`
        const output = execFileSync('sh', ['-c', command], {
          encoding: 'utf8',
          env: { ...process.env, TS_SESSION: encodeURIComponent(token) }
        })
        return `$ ${command}\n${output}`
      }
      await writeFile(
        join(ARTIFACTS, 'courtesy-runner-stored.log'),
        [
          run(
            'events',
            '[.plays[].gumbo.playEvents[], (.currentPlay.playEvents // [])[]] | map(select(.details.eventType == "ts_courtesy_runner")) | map({type, eventType: .details.eventType, event: .details.event, description: .details.description, player, replacedPlayer, runnerEntries: (.runners // [] | length)})'
          ),
          run(
            'lineups',
            '{away: {start: [.away.start.batters[].name], current: [.away.current.batters[].name], changes: (.away.changes | length)}}'
          )
        ].join('\n')
      )
    }
    // One Undo takes back the runner and the roster together.
    await tap('Undo Set team roster')
    await page.waitForSelector(undo, { hidden: true })
    await waitSaved()
    expect(
      (await storedEvents(fixture.gameId)).filter(
        event => event.details?.eventType === 'ts_courtesy_runner'
      )
    ).has.length(0)
  })

  it('S5: refuses a play and a substitution in one sentence in the scoring log, scoring neither', async function () {
    const fixture = lineupFixture()
    await scoreGame(fixture.gameId)
    // A walk: Judge on first, Altuve up.
    for (let i = 0; i < 4; i++) await tapEnabled('Ball')
    await batterUp('Altuve')
    await scoringMicOn()
    const before = await scoreboard()
    const answer = await dictate('ballAndPinchRunner', SCORING_MIC)
    expect(answer.kind).equals('actions')
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[aria-label="Dictation message"]')
        return (
          node != null &&
          node.textContent === 'Say a substitution separately from a play'
        )
      },
      { timeout: 15000 }
    )
    await shot('scoring-mixed-refused.png')
    expect(await scoreboard()).equals(before)
    expect(await page.$('[aria-label="Save Rosters"]')).equals(null)
    await waitSaved()
    expect(
      (await storedEvents(fixture.gameId)).filter(
        event =>
          event.details?.eventType === 'ts_courtesy_runner' ||
          event.isPitch === true
      )
    ).has.length(4)
  })
})
