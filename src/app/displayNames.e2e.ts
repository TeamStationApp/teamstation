/* eslint-disable @typescript-eslint/prefer-optional-chain -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { Page } from 'puppeteer'

import {
  absent,
  browserSession,
  capture,
  contains,
  fill,
  maestro,
  tap
} from '../../e2e/rigs/refinementsMaestro'
import { userIdOfGumbo } from '../common/userId'
import { SESSION_COOKIE } from '../server/auth/tokens'
import type { MountExtra } from '../test/accountHarness'
import {
  BARRY,
  CAL,
  DEREK,
  JOSH_SMITH,
  JOSH_STAUMONT,
  KIRBY,
  seedDisplayNames
} from '../test/displayNamesFixture'
import { groupFixture } from '../test/groupFixtures'
import { leagueTint, personTint, teamTint } from './components/teamTile'

/**
 * The finished app names people and draws tiles as the display names work
 * leaves them (D1–D9): a league administrator reads Lakeshore's other
 * administrator, Cal Ripken, in full on the people list and in the
 * new-message picker, while the league's plain member reads `Cal R`; Josh
 * Smith and Josh Staumont both read `Josh S`, told apart by their
 * affiliation lines; every person, team and league tile sits on its tint;
 * Lakeshore's season, which has no picture, draws the league's; a Demo
 * Hawks practice names its coach in full for the league administrator and
 * short for the member; and the season's coach reads a player Demo Owls
 * holds only by an open add short, with no guardian of his.
 *
 * Run once with `TS_DISPLAY_BEFORE=1` on the base branch for the before
 * screenshots, asserting the labels it shows (`Cal R`, `Josh Sm` /
 * `Josh St`, no lines, initials for the season; D8 and D9 run only after),
 * and again without it:
 *
 *   npm run build.web
 *   MAESTRO_D_BIN=... TS_MAESTRO_D_CLIENT=... TS_CREATION_ARTIFACTS=<dir> \
 *     node -r sucrase/register src/app/displayNames.e2e.ts
 */
const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Set TS_CREATION_ARTIFACTS')
const before = process.env.TS_DISPLAY_BEFORE === '1'
const phase = before ? 'before' : 'after'

/**
 * Chat on the fixture's server (`src/test/displayNamesChat.ts`). Required
 * rather than imported: chat's server code uses Node's timers, and this file
 * is type-checked with the app's DOM library, where a timer is a number.
 */

const chat = require('../test/displayNamesChat') as {
  mountChat: MountExtra
  reconcileChats: (db: unknown) => Promise<void>
}

/** `#1565c0` → `rgb(21, 101, 192)`, as `getComputedStyle` reads it. */
const rgb = (hex: string): string =>
  `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

/**
 * The background of every tile whose letters are `letters`, within `within`
 * (a CSS selector) when it is given.
 */
async function tilesOf(
  page: Page,
  letters: string,
  within = 'body'
): Promise<string[]> {
  return await page.evaluate(
    (letters, within) =>
      Array.from(document.querySelectorAll<HTMLElement>(`${within} *`))
        .filter(
          node => node.children.length === 0 && node.textContent === letters
        )
        .map(node =>
          node.parentElement == null
            ? ''
            : getComputedStyle(node.parentElement).backgroundColor
        ),
    letters,
    within
  )
}

/** The text of every leaf that holds `text`. */
async function leavesWith(page: Page, text: string): Promise<string[]> {
  return await page.evaluate(
    text =>
      Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter(
          node =>
            node.children.length === 0 &&
            node.textContent !== null &&
            node.textContent.includes(text)
        )
        .map(node => String(node.textContent)),
    text
  )
}

/**
 * Every picture shown on screen whose address holds `name`, within `within`
 * (a CSS selector): an image's source, or a background React Native Web
 * draws one with. A screen the stack keeps behind the one shown is not
 * counted: what is hidden or off screen is left out.
 */
async function picturesOf(
  page: Page,
  name: string,
  within = 'body'
): Promise<string[]> {
  await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => undefined)
  return await page.evaluate(
    (name, within) =>
      Array.from(document.querySelectorAll<HTMLElement>(`${within} *`))
        .filter(node => {
          const box = node.getBoundingClientRect()
          return (
            node.checkVisibility() &&
            box.width > 0 &&
            box.height > 0 &&
            box.bottom > 0 &&
            box.right > 0 &&
            box.top < innerHeight &&
            box.left < innerWidth
          )
        })
        .flatMap(node => [
          node instanceof HTMLImageElement ? node.src : '',
          getComputedStyle(node).backgroundImage
        ])
        .filter(address => address.includes(name)),
    name,
    within
  )
}

/**
 * What the tile beside a name shows: the row holding the leaf that reads
 * exactly `name` on screen, its pictures whose address holds `picture`, and
 * any letters drawn in it.
 */
async function tileBeside(
  page: Page,
  name: string,
  picture: string
): Promise<{ pictures: string[]; letters: string[] }> {
  await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => undefined)
  return await page.evaluate(
    (name, picture) => {
      const leaf = Array.from(
        document.querySelectorAll<HTMLElement>('body *')
      ).find(node => {
        const box = node.getBoundingClientRect()
        return (
          node.children.length === 0 &&
          node.textContent === name &&
          node.checkVisibility() &&
          box.width > 0 &&
          box.top >= 0 &&
          box.top < innerHeight
        )
      })
      const row = leaf === undefined ? null : leaf.parentElement
      if (row === null) return { pictures: [], letters: [] }
      const inside = Array.from(row.querySelectorAll<HTMLElement>('*'))
      return {
        pictures: inside
          .flatMap(node => [
            node instanceof HTMLImageElement ? node.src : '',
            getComputedStyle(node).backgroundImage
          ])
          .filter(address => address.includes(picture)),
        letters: inside
          .filter(
            node =>
              node !== leaf &&
              node.children.length === 0 &&
              /^[A-Z]{1,2}$/.test(String(node.textContent))
          )
          .map(node => String(node.textContent))
      }
    },
    name,
    picture
  )
}

/** Brings the first leaf reading exactly `text` into view. */
async function scrollTo(page: Page, text: string): Promise<void> {
  await page.evaluate(text => {
    const leaf = Array.from(
      document.querySelectorAll<HTMLElement>('body *')
    ).find(node => node.children.length === 0 && node.textContent === text)
    if (leaf !== undefined) leaf.scrollIntoView({ block: 'center' })
  }, text)
}

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  // Chat, as the server serves it, for the picker and the season's chats.
  const f = await groupFixture(resolve('dist'), undefined, chat.mountChat)
  const { db, tokens, origin } = f.h
  const world = await seedDisplayNames(f)
  await chat.reconcileChats(db)

  const daemon = await maestro(`displayNames-${process.pid}`)
  const { browser, page, m } = await browserSession(
    daemon,
    `displayNames-chromium-${process.pid}`,
    402,
    874,
    artifacts!
  )
  const signIn = async (userId: number): Promise<void> => {
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: tokens.get(userId)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
  }
  const open = async (path: string, text: string): Promise<void> => {
    await m.openLink({ link: origin + path })
    await contains(page, text)
  }
  const shot = async (file: string): Promise<void> => {
    await capture(m, artifacts!, `${file}-${phase}.png`)
  }
  const colours = 'tile-colours.log'
  const note = async (line: string): Promise<void> => {
    await appendFile(join(artifacts!, colours), line + '\n')
  }
  const LEAGUE_PEOPLE = `/groups/league/${f.leagueA}?tab=people`
  const HAWKS = `/teams/${f.teamA}?tab=team`
  const SEASON = `/groups/season/${f.seasonA}?tab=teams`
  const SEASON_PEOPLE = `/groups/season/${f.seasonA}?tab=people`
  const PRACTICE = `/games/${world.practice}?tab=info`

  try {
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true
    })
    // The fixture's Space is on a loopback port no build can name in its
    // Content-Security-Policy, so the page is let load its pictures.
    await page.setBypassCSP(true)
    if (!before) await rm(join(artifacts!, colours), { force: true })

    // D1. Derek Jeter reads his fellow administrator in full.
    await signIn(DEREK)
    await open(LEAGUE_PEOPLE, before ? 'Cal R' : 'Cal Ripken')
    if (before) await absent(page, 'Cal Ripken')
    await scrollTo(page, before ? 'Cal R' : 'Cal Ripken')
    await shot('league-admins')
    console.log(`D1 PASS: Derek Jeter reads ${before ? 'Cal R' : 'Cal Ripken'}`)

    // D2. The new-message picker names him the same way.
    await m.openLink({ link: origin + '/chat/new' })
    // Chat asks once whether its reader is 13 or older.
    await page.waitForFunction(() => {
      const body = document.body.textContent
      return (
        body !== null &&
        (body.includes('13 or Older') || body.includes('Start conversation'))
      )
    })
    if (
      await page.evaluate(() =>
        String(document.body.textContent).includes('13 or Older')
      )
    )
      await tap(m, 'I’m 13 or Older')
    await contains(page, 'Start conversation')
    await fill(m, 'Name', 'Ripken')
    await contains(page, before ? 'Cal R' : 'Cal Ripken')
    if (before) await absent(page, 'Cal Ripken')
    await shot('chat-picker')
    console.log(`D2 PASS: the picker reads ${before ? 'Cal R' : 'Cal Ripken'}`)

    // D4. Demo Hawks' roster: Josh Smith in full, his guardian's line
    // naming no team.
    await open(HAWKS, 'Josh Smith')
    const guardians = await leavesWith(page, 'Guardians:')
    if (before) expect(guardians).deep.equals([])
    else {
      expect(guardians).include('Guardians: Ken Griffey')
      for (const line of guardians) expect(line).not.include('Demo Hawks')
    }
    await scrollTo(page, 'Josh Smith')
    await shot('team-roster')
    console.log('D4 PASS: the roster reads Josh Smith', guardians)

    // D7. Lakeshore's season, which has no picture, on its page.
    await open(SEASON, 'Demo Hawks')
    const seasonTile = await tileBeside(page, 'Demo Regular', 'baseball')
    await shot('season-picture')
    if (before) {
      expect(seasonTile.pictures).deep.equals([])
      expect(seasonTile.letters).deep.equals(['DR'])
    } else {
      expect(seasonTile.pictures.length).greaterThan(0)
      expect(seasonTile.letters).deep.equals([])
    }
    // And its chats, in the chat list.
    await open('/chat', 'Demo Regular')
    const chatRows = '[aria-label*="Demo Regular"]'
    expect(await page.$$(chatRows)).length.greaterThan(0)
    const chatPicture = await picturesOf(page, 'baseball', chatRows)
    await shot('season-chat')
    if (before) expect(chatPicture).deep.equals([])
    else expect(chatPicture.length).greaterThan(0)
    console.log(
      `D7 PASS: the season draws ${before ? 'its initials' : 'the league picture'} on its page and in chat`
    )

    // D6 (Derek). Cal Ripken's, Demo Hawks' and a league's tiles.
    const cal = userIdOfGumbo(CAL)
    const tile = async (
      reader: string,
      what: string,
      letters: string,
      expected: string,
      within?: string
    ): Promise<void> => {
      const read = await tilesOf(page, letters, within)
      await note(
        `$ getComputedStyle(<${letters} tile>).backgroundColor  # ${reader}, ${what}\n` +
          `${JSON.stringify(read)}  expected ${expected} = ${rgb(expected)}`
      )
      expect(read.length, `${reader} ${what}`).greaterThan(0)
      for (const colour of read) expect(colour, what).equals(rgb(expected))
    }
    if (!before) {
      await note(`# ${new Date().toISOString()} display names tile colours`)
      await open(SEASON, 'Demo Owls')
      await tile(
        'Derek Jeter',
        `Demo Hawks on the season's teams, teamTint(${f.teamA})`,
        'DH',
        teamTint(f.teamA),
        '[aria-label="Open Demo Hawks"]'
      )
      await open(LEAGUE_PEOPLE, 'Cal Ripken')
      await tile(
        'Derek Jeter',
        `Cal Ripken, personTint(${cal})`,
        'CR',
        personTint(cal)!
      )
      // Lakeshore draws its picture; Demo League B has none, nor has its
      // team, Demo Eagles, nor Derek Jeter: one screen with all three.
      await open(`/groups/league/${f.leagueB}?tab=teams`, 'Demo Eagles')
      await tile(
        'Derek Jeter',
        `Demo League B, leagueTint(${f.leagueB})`,
        'DL',
        leagueTint(f.leagueB)
      )
      await tile(
        'Derek Jeter',
        `Demo Eagles on Demo League B's teams, teamTint(${f.teamB})`,
        'DE',
        teamTint(f.teamB)
      )
      const derek = userIdOfGumbo(DEREK)
      await tile(
        'Derek Jeter',
        `himself, personTint(${derek})`,
        'DJ',
        personTint(derek)!
      )
      await capture(m, artifacts!, 'tiles-after.png')

      // D8. Demo Hawks' practice: its coach, going, in full.
      await open(PRACTICE, 'Lou Piniella')
      const lou = await leavesWith(page, 'Lou ')
      expect(lou).length.greaterThan(0)
      for (const name of lou) expect(name).equals('Lou Piniella')
      expect(await leavesWith(page, 'Coach')).length.greaterThan(0)
      await scrollTo(page, 'Lou Piniella')
      await shot('event-attendance')
      console.log('D8 PASS: Derek Jeter reads Lou Piniella going, Coach', lou)
    }

    // D3 and D5. Barry Larkin, a member with no role, reads the public
    // labels: Cal R, and two Josh S told apart by their lines.
    await signIn(BARRY)
    await open(LEAGUE_PEOPLE, 'Cal R')
    await absent(page, 'Cal Ripken')
    if (!before) {
      await scrollTo(page, 'Cal R')
      await shot('member-admins')
      await tile(
        'Barry Larkin',
        `Cal Ripken, personTint(${cal})`,
        'CR',
        personTint(cal)!
      )
      console.log('D6 PASS: person, team and league tiles on their tints')
    }
    console.log('D3 PASS: Barry Larkin reads Cal R')
    if (before) {
      await contains(page, 'Josh Sm')
      await contains(page, 'Josh St')
      expect(await leavesWith(page, 'Guardians:')).deep.equals([])
      await scrollTo(page, 'Josh Sm')
    } else {
      const twins = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(
            node => node.children.length === 0 && node.textContent === 'Josh S'
          ).length
      )
      expect(twins).equals(2)
      await absent(page, 'Josh Sm')
      await absent(page, 'Josh St')
      const lines = await leavesWith(page, 'Guardians:')
      expect(lines).include('Guardians: Ken G · Demo Hawks')
      expect(lines).include('Guardians: Tony G · Demo Owls')
      await scrollTo(page, 'Josh S')
    }
    await shot('twin-names')
    console.log(
      `D5 PASS: ${before ? 'Josh Sm and Josh St' : 'two Josh S with their lines'}`,
      userIdOfGumbo(JOSH_SMITH),
      userIdOfGumbo(JOSH_STAUMONT)
    )

    if (!before) {
      // D8 (Barry). The same practice names the coach short.
      await open(PRACTICE, 'Lou P')
      const lou = await leavesWith(page, 'Lou ')
      expect(lou).length.greaterThan(0)
      for (const name of lou) expect(name).equals('Lou P')
      console.log('D8 PASS: Barry Larkin reads Lou P', lou)

      // D9. Kirby Puckett coaches the season and no team of it: he reads
      // the players Demo Hawks and Demo Owls hold in full, but Rickey
      // Henderson, whom Demo Owls holds only by an open add, short, and no
      // guardian of his.
      await signIn(KIRBY)
      await open(SEASON_PEOPLE, 'Rickey H')
      await absent(page, 'Rickey Henderson')
      await contains(page, 'Josh Smith')
      await contains(page, 'Josh Staumont')
      await contains(page, 'Ken Griffey')
      for (const name of ['Dave Winfield', 'Dave W', 'Winfield'])
        expect(await leavesWith(page, name), name).deep.equals([])
      // His row: the name and any affiliation line under it.
      const rickeyLine = await page.evaluate(() => {
        const leaf = Array.from(
          document.querySelectorAll<HTMLElement>('body *')
        ).find(
          node => node.children.length === 0 && node.textContent === 'Rickey H'
        )
        // Up to the first box holding more than the name.
        let box = leaf == null ? null : leaf.parentElement
        while (box !== null && box.textContent === 'Rickey H')
          box = box.parentElement
        return box === null ? '' : String(box.textContent)
      })
      expect(rickeyLine).include('Rickey H')
      expect(rickeyLine).not.include('Guardian')
      expect(rickeyLine).not.include('Dave')
      await scrollTo(page, 'Rickey H')
      await shot('held-player')
      console.log('D9 PASS: Kirby Puckett reads Rickey H, no guardian', [
        rickeyLine
      ])
    }
  } finally {
    await browser.disconnect()
    await m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
    await f.h.close()
    await rm(join(artifacts!, 'support'), { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
