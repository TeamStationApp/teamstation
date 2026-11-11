import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  type BrowserSession,
  browserSession,
  capture,
  contains,
  maestro
} from '../../../e2e/rigs/refinementsMaestro'
import type { PlayingTimeRules } from '../../common/playingTimeRules'
import { SESSION_COOKIE } from '../../server/auth/tokens'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

/**
 * Playing Time Rules end to end, self-contained like
 * `playerNamePrivacy.e2e.ts`: `groupFixture` makes the leagues, seasons and
 * teams in a scratch database and serves the API with the worktree's `dist/`
 * in-process, and maestro-d's Chromium drives it at an iPhone's 402×874.
 * Build `dist/` first with `npm run build.web`.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_CREATION_ARTIFACTS=<dir> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 600000 src/app/screens/playingTimeRules.e2e.ts
 *
 * `TS_RULES_PHASE=before` only captures Team Settings and Season Settings,
 * each with its Details card, as `team-settings-before.png` and
 * `season-settings-before.png`, and asserts nothing. `TS_RULES_PHASE`
 * defaults to `after`, which captures the same two with the Playing Time
 * Rules row, then runs R1: the season's administrator turns Require
 * Defensive Playing Time on; the team follows it, grayed out, until Override season rules is on;
 * the team's own Max Sits is saved; a later change to the season leaves
 * the team's set as it was; and the season turning its rules off, after a
 * confirmation, stores none and still leaves the team's (`playing-time-season.png`,
 * `playing-time-team-inherited.png`, `playing-time-team-override.png`).
 * Either phase also opens a season's Playing Time Rules, as they open with
 * nothing set, and captures them at their whole length as
 * `rules-<phase>.png`, reading only what every version has: the settings
 * row "Playing Time Rules" and the screen's subtitle.
 *
 * R2, after R1, is league B's administrator on its own season and team: the
 * season opens in Innings, the left option; it sets a large roster's innings
 * block, which its team follows, grayed; it switches to Defensive Outs (6,
 * and 3 for the large roster), the catcher to Outfield, Catcher Inning
 * Limit from None to 4 and Catching Blocks Pitching from Disable to 3, each
 * pill at its row's right and sliding there; `rules-outs.png` captures the
 * whole screen in outs, and the stored set is checked for the new shape.
 */
const ARTIFACTS = process.env.TS_CREATION_ARTIFACTS
const PHASE = process.env.TS_RULES_PHASE ?? 'after'
const WIDTH = 402
const HEIGHT = 874
/** The fixture's administrator of league A, its seasons and its team. */
const ADMIN = 101

describe('Playing Time Rules', function () {
  let f: GroupFixture
  let daemon: Awaited<ReturnType<typeof maestro>>
  let session: BrowserSession

  const signIn = async (userId: number): Promise<void> => {
    await session.browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(userId)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
  }
  const open = async (path: string, text: string): Promise<void> => {
    await session.m.openLink({ link: f.h.origin + path })
    await contains(session.page, text)
  }

  before(async function () {
    if (ARTIFACTS == null) throw new Error('Set TS_CREATION_ARTIFACTS')
    await mkdir(ARTIFACTS, { recursive: true })
    f = await groupFixture(resolve('dist'))
    daemon = await maestro(
      process.env.MAESTRO_D ?? `playingTimeRules-${process.pid}`
    )
    session = await browserSession(
      daemon,
      `playingTimeRules-chromium-${process.pid}`,
      WIDTH,
      HEIGHT,
      join(tmpdir(), 'playing-time-rules-e2e')
    )
    session.page.setDefaultTimeout(30000)
    await session.page.setViewport({
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true
    })
    await signIn(ADMIN)
  })

  after(async function () {
    try {
      await session?.browser.disconnect()
      await session?.m.detach().catch(() => undefined)
      await daemon?.shutdown().catch(() => undefined)
    } finally {
      await f?.h.close()
    }
  })

  /**
   * The whole of a screen that scrolls, in one frame: the window, as wide as
   * ever, is made as tall as the content of the scroller around `text`
   * needs for the shot, then put back.
   */
  const tallCapture = async (name: string, text: string): Promise<void> => {
    const viewport = {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true
    }
    try {
      for (let pass = 0; pass < 3; pass++) {
        const extra = await session.page.evaluate(anchor => {
          const leaf = [...document.querySelectorAll('body *')].find(
            node => node.children.length === 0 && node.textContent === anchor
          )
          let node = leaf == null ? null : leaf.parentElement
          const scrolls = (each: HTMLElement): boolean =>
            ['auto', 'scroll'].includes(getComputedStyle(each).overflowY) &&
            each.scrollHeight > each.clientHeight
          while (node != null && !scrolls(node)) node = node.parentElement
          if (node == null) return 0
          node.scrollTop = 0
          return node.scrollHeight - node.clientHeight
        }, text)
        if (extra <= 0) break
        viewport.height += extra
        await session.page.setViewport(viewport)
        await new Promise(resolve => setTimeout(resolve, 600))
      }
      await capture(session.m, ARTIFACTS!, name)
    } finally {
      await session.page.setViewport({ ...viewport, height: HEIGHT })
      await new Promise(resolve => setTimeout(resolve, 600))
    }
  }

  /** A group's detail as its administrator reads it. */
  const read = async (
    kind: 'season' | 'team',
    id: string,
    userId = ADMIN
  ): Promise<{
    playingTimeRules: PlayingTimeRules | null
    seasonPlayingTimeRules: { rules: PlayingTimeRules } | null
  }> => {
    const answer = await f.h.request(
      'GET',
      `/${kind === 'season' ? 'seasons' : 'teams'}/${id}`,
      undefined,
      userId
    )
    expect(answer.status).equals(200)
    return (await answer.json()) as Awaited<ReturnType<typeof read>>
  }
  const toggle = async (label: string): Promise<void> => {
    await session.m.tapOn({
      css: `[role="switch"][aria-label="${label}"]`,
      timeout: 15000
    })
  }
  const switched = async (label: string): Promise<boolean> =>
    await session.page.$eval(
      `[role="switch"][aria-label="${label}"]`,
      node => (node as HTMLInputElement).checked
    )
  /** The labels of the switches that cannot be changed now. */
  const grayed = async (): Promise<string[]> =>
    await session.page.$$eval('[role="switch"]', nodes =>
      nodes
        .filter(node => (node as HTMLInputElement).disabled)
        .map(node => String(node.getAttribute('aria-label')))
    )
  /** Opens the Playing Time Rules row of the settings on screen. */
  const openRules = async (detail: string, subtitle: string): Promise<void> => {
    await session.m.tapOn({
      css: `[role="button"][aria-label="Playing Time Rules, ${detail}"]`,
      timeout: 15000
    })
    await contains(session.page, subtitle)
    // The rows come once the rules have loaded.
    await session.page.waitForSelector(
      '[role="switch"][aria-label="Require Defensive Playing Time"]'
    )
  }
  const save = async (settings: string): Promise<void> => {
    await session.m.tapOn({ text: 'Save', role: 'button', timeout: 15000 })
    await contains(session.page, settings)
  }

  it('captures Team Settings and Season Settings with their Details cards', async function () {
    await open(`/groups/team/${f.teamA}/settings`, 'TEAM DETAILS')
    if (PHASE !== 'before') await contains(session.page, 'Playing Time Rules')
    await capture(session.m, ARTIFACTS!, `team-settings-${PHASE}.png`)
    await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
    if (PHASE !== 'before') await contains(session.page, 'Playing Time Rules')
    await capture(session.m, ARTIFACTS!, `season-settings-${PHASE}.png`)
  })

  it('captures a season’s Playing Time Rules at their whole length', async function () {
    const subtitle = 'Configures the playing time rules for this season.'
    await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
    await session.m.tapOn({
      css: '[role="button"][aria-label^="Playing Time Rules"]',
      timeout: 15000
    })
    await contains(session.page, subtitle)
    // The rows come once the rules have loaded.
    await session.page.waitForSelector('[role="switch"]')
    await tallCapture(`rules-${PHASE}.png`, subtitle)
  })

  /**
   * Every pill on screen: whether it sits at its row's right edge, wholly
   * right of its name or, on a narrow screen, wholly under it, and whether
   * its selected region has slid to cover the selected tab; and its name's
   * width and how many lines its title takes.
   */
  const placed = async (): Promise<
    Array<{
      row: string
      right: boolean
      clear: boolean
      below: boolean
      covers: boolean
      nameWidth: number
      lines: number
    }>
  > => {
    // The slide takes 220 ms.
    await new Promise(resolve => setTimeout(resolve, 600))
    return await session.page.$$eval('[data-testid="segmented-pill"]', nodes =>
      nodes.map(node => {
        const box = node.getBoundingClientRect()
        const row = node.parentElement!
        const rowBox = row.getBoundingClientRect()
        const pad = parseFloat(getComputedStyle(row).paddingRight)
        const name = row.firstElementChild!
        const label = name.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(name.firstElementChild!)
        const tops = new Set(
          [...range.getClientRects()].map(rect => Math.round(rect.top))
        )
        const tab = node.querySelector('[role="tab"][aria-selected="true"]')!
        const fill = node.querySelector('[data-testid="segmented-pill-fill"]')!
        const tabBox = tab.getBoundingClientRect()
        const fillBox = fill.getBoundingClientRect()
        return {
          row: String(node.getAttribute('aria-label')),
          right: Math.abs(rowBox.right - pad - box.right) < 1,
          clear: label.right <= box.left,
          below: label.bottom <= box.top,
          covers:
            Math.abs(fillBox.left - tabBox.left) < 1 &&
            Math.abs(fillBox.width - tabBox.width) < 1,
          nameWidth: label.width,
          lines: tops.size
        }
      })
    )
  }
  /**
   * On a 402-point phone every pill is beside its name. On a narrower
   * screen a pill may take its own line under its name, which keeps at
   * least 120 points. Either way the name's title takes two lines at most.
   */
  const expectPlaced = async (narrow = false): Promise<void> => {
    const pills = await placed()
    expect(pills.length).greaterThan(0)
    for (const one of pills) {
      expect(one.right, `${one.row} at the right`).equals(true)
      expect(one.covers, `${one.row} slid to its choice`).equals(true)
      if (narrow) {
        expect(
          one.clear || one.below,
          `${one.row} beside or under its name`
        ).equals(true)
        expect(one.nameWidth, `${one.row}'s name`).greaterThanOrEqual(119.5)
      } else expect(one.clear, `${one.row} beside its label`).equals(true)
      expect(one.lines, `${one.row}'s lines`).lessThanOrEqual(2)
    }
  }

  it('R1: a team follows its season’s rules, grayed, until it overrides them, and then keeps its own', async function () {
    if (PHASE === 'before') this.skip()
    const seasonSubtitle = 'Configures the playing time rules for this season.'
    const teamSubtitle = 'Configures the playing time rules for this team.'

    // The season's administrator turns Defensive Playing Time on.
    await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
    await openRules('Off', seasonSubtitle)
    expect(new URL(session.page.url()).pathname).equals(
      `/groups/season/${f.seasonA}/settings/playing-time`
    )
    expect(await grayed()).includes('Reduced Requirement for Large Rosters')
    await toggle('Require Defensive Playing Time')
    expect(await grayed()).not.includes('Reduced Requirement for Large Rosters')
    // The short pickers' labels sit whole on their pill's straight run.
    const pills = await session.page.$$eval(
      '[data-testid="segmented-pill"] [role="tab"]',
      nodes =>
        nodes.map(node => {
          const label = node.firstElementChild as HTMLElement
          const box = node.getBoundingClientRect()
          return {
            text: label.textContent,
            fits: label.scrollWidth <= label.clientWidth,
            clear:
              parseFloat(getComputedStyle(node).paddingLeft) >= box.height / 2
          }
        })
    )
    expect(pills.map(pill => pill.text)).includes.members([
      'Innings',
      'Defensive Outs',
      '3rd',
      'n/a',
      'Full only',
      'Any appearance',
      'Infield',
      'Outfield',
      'None',
      'Disable'
    ])
    for (const pill of pills) {
      expect(pill.fits, String(pill.text)).equals(true)
      expect(pill.clear, String(pill.text)).equals(true)
    }
    await tallCapture('playing-time-season.png', seasonSubtitle)
    await save('SEASON DETAILS')
    await contains(session.page, 'Season rules')
    expect((await read('season', f.seasonA)).playingTimeRules).deep.include({
      defensivePlayingTime: true
    })

    // The team's administrator sees the season's values, grayed out.
    await open(`/groups/team/${f.teamA}/settings`, 'TEAM DETAILS')
    await openRules('Season rules', teamSubtitle)
    await contains(session.page, 'Following Demo Regular')
    expect(await switched('Override season rules')).equals(false)
    expect(await switched('Require Defensive Playing Time')).equals(true)
    const allGrayed = await grayed()
    expect(allGrayed).includes.members([
      'Require Defensive Playing Time',
      'Reduced Requirement for Large Rosters',
      'Enforce Sitting Limits',
      'Continuous Batting Order'
    ])
    expect(allGrayed).not.includes('Override season rules')
    expect(
      await session.page.$eval(
        '[aria-label="Increase Max Sits Per Game"]',
        node => node.getAttribute('aria-disabled')
      )
    ).equals('true')
    await capture(session.m, ARTIFACTS!, 'playing-time-team-inherited.png')

    // Override: the season's values, now the team's to change.
    await toggle('Override season rules')
    expect(await switched('Require Defensive Playing Time')).equals(true)
    // Only the rows whose own parent is off stay gray.
    const editable = await grayed()
    for (const row of [
      'Require Defensive Playing Time',
      'Reduced Requirement for Large Rosters',
      'Enforce Sitting Limits',
      'Continuous Batting Order'
    ])
      expect(editable).not.includes(row)
    expect(editable).includes('No Consecutive Sits')
    await capture(session.m, ARTIFACTS!, 'playing-time-team-override.png')
    await toggle('Enforce Sitting Limits')
    await session.m.tapOn({
      css: '[aria-label="Increase Max Sits Per Game"]',
      timeout: 15000
    })
    await session.page.waitForSelector('[aria-label="Max Sits Per Game: 2"]')
    await save('TEAM DETAILS')
    await contains(session.page, 'Overridden for this team')
    const own = (await read('team', f.teamA)).playingTimeRules
    expect(own).deep.include({
      defensivePlayingTime: true,
      enforceSittingLimits: true,
      maxSitsPerGame: 2
    })

    // The season changes; the team's set does not.
    await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
    await openRules('Season rules', seasonSubtitle)
    await toggle('Require Defensive Playing Time')
    await save('SEASON DETAILS')
    const team = await read('team', f.teamA)
    expect(team.seasonPlayingTimeRules?.rules.defensivePlayingTime).equals(
      false
    )
    expect(team.playingTimeRules).deep.equals(own)
    await open(`/groups/team/${f.teamA}/settings`, 'TEAM DETAILS')
    await openRules('Overridden for this team', teamSubtitle)
    expect(await switched('Override season rules')).equals(true)
    expect(await switched('Require Defensive Playing Time')).equals(true)
    expect(await switched('Enforce Sitting Limits')).equals(true)
    expect(
      await session.page.$eval(
        '[aria-label^="Max Sits Per Game: "]',
        node => node.textContent
      )
    ).equals('2')

    // The season turns its rules off, to none; the team keeps its own.
    await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
    await openRules('Season rules', seasonSubtitle)
    await session.m.tapOn({
      css: '[role="button"][aria-label="Turn Off Playing Time Rules"]',
      timeout: 15000
    })
    await contains(
      session.page,
      'Turn off playing time rules for Demo Regular?'
    )
    await session.m.tapOn({
      css: '[data-testid="playing-time-turn-off-confirm"]',
      timeout: 15000
    })
    await session.page.waitForSelector(
      '[role="button"][aria-label="Playing Time Rules, Off"]'
    )
    expect((await read('season', f.seasonA)).playingTimeRules).equals(null)
    expect((await read('team', f.teamA)).playingTimeRules).deep.equals(own)
  })

  it('R2: the reshaped rules, in innings then outs, each pill at its row’s right', async function () {
    if (PHASE === 'before') this.skip()
    const LEAGUE_B_ADMIN = 102
    const seasonSubtitle = 'Configures the playing time rules for this season.'
    const teamSubtitle = 'Configures the playing time rules for this team.'
    const large = (label: string): string => `${label} (large rosters)`
    const pill = (row: string): string =>
      `[role="tablist"][aria-label="${row}"]`
    const choose = async (row: string, label: string): Promise<void> => {
      await session.m.tapOn({
        css: `${pill(row)} [role="tab"][aria-label="${label}"]`,
        timeout: 15000
      })
      await session.page.waitForSelector(
        `${pill(row)} [role="tab"][aria-label="${label}"][aria-selected="true"]`
      )
    }
    /** The label of a pill's selected tab, and whether it can change. */
    const holds = async (
      row: string
    ): Promise<{ selected: string; disabled: boolean }> =>
      await session.page.$eval(pill(row), node => {
        const tab = node.querySelector('[role="tab"][aria-selected="true"]')
        return {
          selected: String(tab == null ? null : tab.textContent),
          disabled: node.closest('[aria-disabled="true"]') != null
        }
      })
    const labels = async (row: string): Promise<string[]> =>
      await session.page.$$eval(`${pill(row)} [role="tab"]`, nodes =>
        nodes.map(node => String(node.textContent))
      )
    const shown = async (label: string): Promise<boolean> =>
      (await session.page.$(`[aria-label="${label}"]`)) != null
    await signIn(LEAGUE_B_ADMIN)
    try {
      // The season opens in Innings, the left option, with the innings rows.
      await open(`/groups/season/${f.seasonB}/settings`, 'SEASON DETAILS')
      await openRules('Off', seasonSubtitle)
      expect(await labels('Playing time measured in')).deep.equals([
        'Innings',
        'Defensive Outs'
      ])
      expect((await holds('Playing time measured in')).selected).equals(
        'Innings'
      )
      expect(await shown('Must Complete by Inning')).equals(true)
      expect(await shown('Defensive Outs Required')).equals(false)
      // Catcher Inning Limit and Catching Blocks Pitching start off.
      expect(await labels('Catcher Inning Limit')).deep.equals([
        '3',
        '4',
        '5',
        'None'
      ])
      expect((await holds('Catcher Inning Limit')).selected).equals('None')
      expect(await labels('Catching Blocks Pitching')).deep.equals([
        '3',
        '4',
        '5',
        'Disable'
      ])
      expect((await holds('Catching Blocks Pitching')).selected).equals(
        'Disable'
      )
      await contains(
        session.page,
        'After N innings catching, no pitching that calendar day'
      )
      for (const gone of [
        'Also block if catcher catches any part of 4th inning',
        'Apply in Shortened Games',
        'Season Tracking',
        'SEASON TRACKING',
        'Mandatory Play',
        'MANDATORY PLAY'
      ])
        expect(
          await session.page.evaluate(() => String(document.body.textContent)),
          gone
        ).not.includes(gone)

      // A large roster's block, in innings: by the 4th, full innings only.
      await toggle('Require Defensive Playing Time')
      await toggle('Reduced Requirement for Large Rosters')
      await choose(large('Must Complete by Inning'), '4th')
      await choose(large('Count Partial Innings'), 'Full only')
      await expectPlaced()
      await save('SEASON DETAILS')
      await contains(session.page, 'Season rules')

      // The team follows it, grayed.
      await open(`/groups/team/${f.teamB}/settings`, 'TEAM DETAILS')
      await openRules('Season rules', teamSubtitle)
      await contains(session.page, 'Following Demo Tournament')
      expect(await holds(large('Must Complete by Inning'))).deep.equals({
        selected: '4th',
        disabled: true
      })
      expect(await holds(large('Count Partial Innings'))).deep.equals({
        selected: 'Full only',
        disabled: true
      })

      // Back on the season, Defensive Outs: dragged across, its pill slides
      // there, and its rows take the innings rows' place.
      await open(`/groups/season/${f.seasonB}/settings`, 'SEASON DETAILS')
      await openRules('Season rules', seasonSubtitle)
      // A drag begun as the screen opens can come before the pill has
      // measured its choices; a person's comes later.
      await new Promise(resolve => setTimeout(resolve, 1000))
      const unit = await session.page.$eval(
        pill('Playing time measured in'),
        node => {
          const box = node.getBoundingClientRect()
          return {
            left: box.left,
            right: box.right,
            y: box.top + box.height / 2
          }
        }
      )
      await session.page.mouse.move(unit.left + 20, unit.y)
      await session.page.mouse.down()
      for (let step = 1; step <= 8; step++)
        await session.page.mouse.move(
          unit.left + 20 + ((unit.right - unit.left - 40) * step) / 8,
          unit.y
        )
      await session.page.mouse.up()
      await session.page.waitForSelector(
        `${pill('Playing time measured in')} [aria-label="Defensive Outs"][aria-selected="true"]`
      )
      expect(await shown('Must Complete by Inning')).equals(false)
      expect((await holds('Defensive Outs Required')).selected).equals('6')
      expect((await holds(large('Defensive Outs Required'))).selected).equals(
        '3'
      )
      await contains(session.page, 'Require 6 defensive outs')

      // The catcher counts toward the outfield; it limits and blocks.
      await toggle('Require Minimum Outfield')
      await choose('Catcher counts as', 'Outfield')
      await choose('Catcher Inning Limit', '4')
      await choose('Catching Blocks Pitching', '3')
      await contains(
        session.page,
        'After 3 innings catching, no pitching that calendar day'
      )
      await expectPlaced()
      await tallCapture('rules-outs.png', seasonSubtitle)
      await save('SEASON DETAILS')

      // The stored set is the new shape, and only that.
      const stored = (await read('season', f.seasonB, LEAGUE_B_ADMIN))
        .playingTimeRules!
      expect(stored).deep.include({
        defensivePlayingTime: true,
        measuredIn: 'outs',
        outs: { required: 6, consecutive: false },
        catcherCountsAs: 'outfield',
        requireMinimumOutfield: true,
        catcherMaxInnings: 4,
        catcherBlocksPitching: 3
      })
      expect(stored.largeRoster).deep.equals({
        enabled: true,
        players: 15,
        outs: { required: 3, consecutive: false },
        innings: { minimum: 1, completeBy: 4, countPartial: 'fullOnly' }
      })
      for (const gone of [
        'mandatoryPlay',
        'applyInShortenedGames',
        'stricterMinimumInnings',
        'infieldPositions',
        'catcherInningLimit',
        'catcherBlocksIfCatchesFourth',
        'trackSeasonInfieldBalance',
        'rotateLeadoff',
        'mustPlayNextSuggestions'
      ])
        expect(stored, gone).not.have.property(gone)
    } finally {
      await signIn(ADMIN)
    }
  })

  it('R3: on 320- and 375-point screens a control without room beside its name takes its own line, at the right, no name breaks inside a word, and no pill row’s name takes three lines', async function () {
    if (PHASE === 'before') this.skip()
    /**
     * Every stepper row: its name's width and title lines, and whether −
     * and + sit beside it or under it, at the row's right.
     */
    const steppers = async (): Promise<
      Array<{
        row: string
        right: boolean
        placed: boolean
        nameWidth: number
        lines: number
      }>
    > =>
      await session.page.$$eval(
        '[role="button"][aria-label^="Increase "]',
        nodes =>
          nodes.map(node => {
            const stepper = node.parentElement!
            const row = stepper.parentElement!
            const rowBox = row.getBoundingClientRect()
            const box = stepper.getBoundingClientRect()
            const pad = parseFloat(getComputedStyle(row).paddingRight)
            const name = row.firstElementChild!
            const label = name.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(name.firstElementChild!)
            const tops = new Set(
              [...range.getClientRects()].map(rect => Math.round(rect.top))
            )
            return {
              row: String(node.getAttribute('aria-label')),
              right: Math.abs(rowBox.right - pad - box.right) < 1,
              placed: label.right <= box.left || label.bottom <= box.top,
              nameWidth: label.width,
              lines: tops.size
            }
          })
      )
    for (const [width, height] of [
      [320, 568],
      [375, 667]
    ]) {
      const viewport = {
        width,
        height,
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true
      }
      await session.page.setViewport(viewport)
      try {
        await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
        await openRules(
          'Off',
          'Configures the playing time rules for this season.'
        )
        await toggle('Require Defensive Playing Time')
        await toggle('Reduced Requirement for Large Rosters')
        await expectPlaced(true)
        // Some pill there is under its name: the narrow case is reached.
        expect(
          (await placed()).some(one => one.below),
          `${width}`
        ).equals(true)
        const rows = await steppers()
        expect(rows.length).greaterThan(0)
        for (const one of rows) {
          expect(one.right, `${width}: ${one.row} at the right`).equals(true)
          expect(one.placed, `${width}: ${one.row} beside or under`).equals(
            true
          )
          expect(one.nameWidth, `${width}: ${one.row}`).greaterThanOrEqual(
            119.5
          )
        }
        // "Following requirements when ≥ 15 players present" breaks no
        // word: its name keeps 120 points, wider than any word in it.
        expect(
          rows.some(one => one.row.includes('players present')),
          `${width}: the large roster's row`
        ).equals(true)
      } finally {
        await session.page.setViewport({
          ...viewport,
          width: WIDTH,
          height: HEIGHT
        })
      }
    }
  })
})
