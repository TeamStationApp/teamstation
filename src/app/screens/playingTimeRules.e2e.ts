import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { PlayingTimeRules } from '../../common/playingTimeRules'
import { SESSION_COOKIE } from '../../server/auth/tokens'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import {
  type BrowserSession,
  browserSession,
  capture,
  contains,
  maestro
} from '../../test/refinementsMaestro.e2e'

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
 * Rules row, then runs R1: the season's administrator turns Mandatory Play
 * on; the team follows it, grayed out, until Override season rules is on;
 * the team's own Max Sits is saved; a later change to the season leaves
 * the team's set as it was; and the season turning its rules off, after a
 * confirmation, stores none and still leaves the team's (`playing-time-season.png`,
 * `playing-time-team-inherited.png`, `playing-time-team-override.png`).
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
    id: string
  ): Promise<{
    playingTimeRules: PlayingTimeRules | null
    seasonPlayingTimeRules: { rules: PlayingTimeRules } | null
  }> => {
    const answer = await f.h.request(
      'GET',
      `/${kind === 'season' ? 'seasons' : 'teams'}/${id}`,
      undefined,
      ADMIN
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
      '[role="switch"][aria-label="Mandatory Play"]'
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

  it('R1: a team follows its season’s rules, grayed, until it overrides them, and then keeps its own', async function () {
    if (PHASE === 'before') this.skip()
    const seasonSubtitle = 'Configures the playing time rules for this season.'
    const teamSubtitle = 'Configures the playing time rules for this team.'

    // The season's administrator turns Mandatory Play on.
    await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
    await openRules('Off', seasonSubtitle)
    expect(new URL(session.page.url()).pathname).equals(
      `/groups/season/${f.seasonA}/settings/playing-time`
    )
    expect(await grayed()).includes('Must Be Consecutive')
    await toggle('Mandatory Play')
    expect(await grayed()).not.includes('Must Be Consecutive')
    // The short pickers' labels sit whole on their pill's straight run.
    const pills = await session.page.$$eval('[role="radio"]', nodes =>
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
      'Always',
      'Local Option',
      'Never',
      'Full only',
      'Any appearance'
    ])
    for (const pill of pills) {
      expect(pill.fits, String(pill.text)).equals(true)
      expect(pill.clear, String(pill.text)).equals(true)
    }
    await tallCapture('playing-time-season.png', seasonSubtitle)
    await save('SEASON DETAILS')
    await contains(session.page, 'Season rules')
    expect((await read('season', f.seasonA)).playingTimeRules).deep.include({
      mandatoryPlay: true
    })

    // The team's administrator sees the season's values, grayed out.
    await open(`/groups/team/${f.teamA}/settings`, 'TEAM DETAILS')
    await openRules('Season rules', teamSubtitle)
    await contains(session.page, 'Following Demo Regular')
    expect(await switched('Override season rules')).equals(false)
    expect(await switched('Mandatory Play')).equals(true)
    const allGrayed = await grayed()
    expect(allGrayed).includes.members([
      'Mandatory Play',
      'Must Be Consecutive',
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
    expect(await switched('Mandatory Play')).equals(true)
    // Only the rows whose own parent is off stay gray.
    const editable = await grayed()
    for (const row of [
      'Mandatory Play',
      'Must Be Consecutive',
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
      mandatoryPlay: true,
      enforceSittingLimits: true,
      maxSitsPerGame: 2
    })

    // The season changes; the team's set does not.
    await open(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
    await openRules('Season rules', seasonSubtitle)
    await toggle('Mandatory Play')
    await save('SEASON DETAILS')
    const team = await read('team', f.teamA)
    expect(team.seasonPlayingTimeRules?.rules.mandatoryPlay).equals(false)
    expect(team.playingTimeRules).deep.equals(own)
    await open(`/groups/team/${f.teamA}/settings`, 'TEAM DETAILS')
    await openRules('Overridden for this team', teamSubtitle)
    expect(await switched('Override season rules')).equals(true)
    expect(await switched('Mandatory Play')).equals(true)
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
})
