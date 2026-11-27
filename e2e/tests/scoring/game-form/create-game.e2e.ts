import { appendFileSync, writeFileSync } from 'node:fs'

import { expect } from 'chai'

import type { FixtureManifest } from '../../../core/fixtures'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  type EventWeb,
  hierarchyReady,
  openEventWeb,
  sql
} from '../../../rigs/eventWeb'

/**
 * Create Game and Game Settings, end to end: the team suggestions API, then
 * the shared game scene in a phone-sized browser in Los Angeles: created
 * from a team and from a season, its team selector with suggestions,
 * search, swaps and staged placeholders, Game Settings, withdrawal on a
 * narrow phone, Practice and Other, and the time zone and month pickers.
 * The `game-form` world's owner runs the Hawks (and keeps the Eagles); its
 * team names carry the world's tag, so a search finds this world's team.
 */

const PHONE = { width: 402, height: 874 }
const ZONE = 'America/Los_Angeles'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function monthName(date: string): string {
  return MONTHS[Number(date.slice(5, 7)) - 1]
}

interface Scene {
  ctx: HarnessContext
  w: FixtureManifest
  web: EventWeb
  m: any
  savedLog: string
  evaluate: <T>(script: string) => Promise<T>
  wait: (expression: string) => Promise<void>
  shot: (file: string) => Promise<void>
  button: (label: string) => string
  exists: (label: string) => Promise<boolean>
  tap: (label: string) => Promise<void>
  fill: (label: string, text: string) => Promise<void>
  toTop: () => Promise<void>
  see: (text: string) => Promise<void>
  open: (route: string, title: string) => Promise<void>
  chooseDate: (value: string) => Promise<void>
  chooseTime: (hour: number, minute: number) => Promise<void>
  placeholders: () => Promise<
    Array<{ id: string; locality: unknown; custodian_id: string | null }>
  >
  createRoute: string
  done: () => Promise<void>
}

async function scene(ctx: HarnessContext): Promise<Scene> {
  const w = await ctx.fixture('game-form')
  await hierarchyReady(ctx)
  const web = await openEventWeb(ctx, w.accounts.owner, PHONE, {
    timeZone: ZONE
  })
  const { m } = web
  const savedLog = ctx.artifact('placeholder-save.log')
  writeFileSync(savedLog, '')
  const evaluate = web.evaluate
  const wait = async (expression: string): Promise<void> => {
    await web.wait(expression, 10000)
  }
  const shot = async (file: string): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 500))
    await web.shot(file)
  }
  /** The button whose label is this, or this title and then its subtitle. */
  const button = (label: string): string =>
    `Array.from(document.querySelectorAll('[role="button"],[role="radio"]')).find(node=>{const name=node.getAttribute('aria-label')??node.textContent;return name===${JSON.stringify(label)}||name.startsWith(${JSON.stringify(label + ', ')})})`
  const exists = async (label: string): Promise<boolean> =>
    await evaluate<boolean>(`${button(label)}!=null`)
  const tap = async (label: string): Promise<void> => {
    await wait(
      `(()=>{const node=${button(label)};return node!=null&&node.getAttribute('aria-disabled')!=='true'})()`
    )
    // A sheet sliding in or out moves its rows: tap only once the target is
    // uncovered and has stopped moving.
    let point = { x: 0, y: 0, clear: false }
    let settled = false
    for (
      let attempt = 0;
      attempt < 40 && !(point.clear && settled);
      attempt++
    ) {
      const next = await evaluate<{ x: number; y: number; clear: boolean }>(
        `(()=>{const node=${button(label)};node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return{x,y,clear:hit===node||node.contains(hit)}})()`
      )
      settled = next.x === point.x && next.y === point.y
      point = next
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    expect(point.clear, `${label} must be unobstructed`).to.equal(true)
    await m.tapOnPoint({ x: Math.round(point.x), y: Math.round(point.y) })
  }
  const fill = async (label: string, text: string): Promise<void> => {
    const css = `[aria-label=${JSON.stringify(label)}]`
    await wait(`document.querySelector(${JSON.stringify(css)})!=null`)
    await m.evalBrowserScript({
      script: `const input=document.querySelector(${JSON.stringify(css)});input.scrollIntoView({block:'center'});input.focus();input.select()`
    })
    await m.eraseText()
    await m.inputText({ text, css })
    await wait(
      `document.querySelector(${JSON.stringify(css)}).value===${JSON.stringify(text)}`
    )
  }
  /** The scene's own scroller to its top, not only the window. */
  const toTop = async (): Promise<void> => {
    await m.evalBrowserScript({
      script: `window.scrollTo(0,0);for(const node of document.querySelectorAll('div'))if(node.scrollTop>0)node.scrollTop=0`
    })
    await wait(
      `Array.from(document.querySelectorAll('div')).every(node=>node.scrollTop===0)`
    )
  }
  const see = async (text: string): Promise<void> => {
    await wait(`document.body.textContent.includes(${JSON.stringify(text)})`)
  }
  const open = async (route: string, title: string): Promise<void> => {
    await web.go(route)
    await wait(
      `Array.from(document.querySelectorAll('[role="heading"],[aria-level]')).some(node=>node.textContent===${JSON.stringify(title)})`
    )
  }
  const chooseDate = async (value: string): Promise<void> => {
    await m.tapOn({ id: 'event-schedule-date' })
    await fill('Year', value.slice(0, 4))
    await tap(`Choose month: ${monthName(value)}`).catch(async () => {
      await m.evalBrowserScript({
        script: `document.querySelector('[aria-label^="Choose month:"]').click()`
      })
    })
    await tap(monthName(value))
    await tap(`Choose ${value}`)
    await tap('Use date')
  }
  const chooseTime = async (hour: number, minute: number): Promise<void> => {
    await m.tapOn({ id: 'event-schedule-time' })
    for (const [column, option] of [
      ['hour', hour % 12 === 0 ? 12 : hour % 12],
      ['minute', minute],
      ['period', hour < 12 ? 0 : 1]
    ] as const) {
      const index =
        column === 'hour'
          ? option - 1
          : column === 'minute'
            ? option / 5
            : option
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="event-time-${column}-wheel"]').scrollTo({top:${index * 44},behavior:'instant'})`
      })
      await m.assertVisible({
        id: `event-time-${column}-${option}`,
        timeout: 5000
      })
      await m.tapOn({ id: `event-time-${column}-${option}` })
    }
    await tap('Use time')
  }
  const placeholderName = `Riverside Owls ${w.ids.tag}`
  const placeholders = async (): Promise<
    Array<{ id: string; locality: unknown; custodian_id: string | null }>
  > => {
    const query = `select id, locality, custodian_id from teams where name = $1 and kind = 'external'`
    const rows = (await sql(ctx, query, [placeholderName])) as Array<{
      id: string
      locality: unknown
      custodian_id: string | null
    }>
    appendFileSync(
      savedLog,
      `$ ${query} [${placeholderName}]\n${JSON.stringify(rows, null, 2)}\n\n`
    )
    return rows
  }
  web.page.on('response', (response: any) => {
    if (!String(response.url()).includes('/api/v1/game-requests')) return
    const request = response.request()
    if (String(request.method()) !== 'POST') return
    ;(async () => {
      const body = await response.text().catch(() => '<unavailable>')
      const posted = await request.fetchPostData().catch(() => undefined)
      appendFileSync(
        savedLog,
        `$ browser POST ${new URL(response.url()).pathname}\n${posted ?? ''}\n${response.status()} ${body}\n\n`
      )
    })().catch(() => undefined)
  })
  return {
    ctx,
    w,
    web,
    m,
    savedLog,
    evaluate,
    wait,
    shot,
    button,
    exists,
    tap,
    fill,
    toTop,
    see,
    open,
    chooseDate,
    chooseTime,
    placeholders,
    createRoute: `/groups/team/${encodeURIComponent(w.ids.teamA)}/create-game`,
    done: async () => {
      expect(web.errors, 'No app JavaScript errors').to.deep.equal([])
      await web.session.close()
    }
  }
}

/** The Hawks schedule, with its practice, Other event and game. */
async function scheduleShot(s: Scene, file: string): Promise<void> {
  await s.web.go(`/teams/${encodeURIComponent(s.w.ids.teamA)}?tab=schedule`)
  await s.m.assertVisible({ text: 'Team dinner', timeout: 20000 })
  await s.m.evalBrowserScript({
    script: `const node=Array.from(document.querySelectorAll('div')).find(node=>node.childElementCount===0&&node.textContent==='Team dinner');node.scrollIntoView({block:'center'})`
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  await s.web.shot(file)
}

export default defineHarness({
  id: 'scoring/game-form/create-game',
  title:
    'Create Game and Game Settings, with team suggestions and placeholders',
  kind: 'e2e',
  covers: [
    'src/app/screens/GameFormScreen.tsx',
    'src/app/screens/TeamSelectorScene.tsx',
    'src/app/screens/EventDetailsForm.tsx',
    'src/app/screens/GroupGameSchedule.tsx',
    'src/server/routes/teams.ts'
  ],
  stack: 'isolated',
  fixtures: ['game-form'],
  exclusive: false,
  surfaces: {
    // No 3D: headless Chromium on a browser droplet.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    // E1: suggestions tiered season, recent opponents, then region, each
    // naming its seasons and staff; a search names seasons too; a search
    // narrowed to a team's suggestions is refused.
    'suggestions-api': async ctx => {
      const w = await ctx.fixture('game-form')
      const log = ctx.artifact('team-suggestions-api.log')
      writeFileSync(log, '')
      const get = async (
        path: string
      ): Promise<{ status: number; body: any }> => {
        const response = await fetch(`${ctx.stack.origin}/api/v1${path}`)
        const text = await response.text()
        const body = text === '' ? null : JSON.parse(text)
        appendFileSync(
          log,
          `$ GET /api/v1${path}\n${response.status} ${JSON.stringify(body, null, 2)}\n\n`
        )
        return { status: response.status, body }
      }
      const suggested = await get(
        `/teams?view=public&relatedTeam=${encodeURIComponent(w.ids.teamA)}`
      )
      expect(suggested.status).to.equal(200)
      const rows = suggested.body as Array<{
        id: string
        seasonNames?: string[]
        staffNames?: string[]
      }>
      const ids = rows.map(row => row.id)
      expect(ids, 'The anchor team is not its own suggestion').to.not.include(
        w.ids.teamA
      )
      expect(ids, 'Same-season team suggested').to.include(w.ids.sameSeason)
      expect(ids, 'Five-month opponent suggested').to.include(
        w.ids.recentOpponent
      )
      expect(ids, 'Seven-month opponent absent').to.not.include(
        w.ids.staleOpponent
      )
      expect(ids, 'Same-region team suggested').to.include(w.ids.sameRegion)
      expect(
        ids.indexOf(w.ids.sameSeason) < ids.indexOf(w.ids.recentOpponent) &&
          ids.indexOf(w.ids.recentOpponent) < ids.indexOf(w.ids.sameRegion),
        'Tiers: season, then opponents, then region'
      ).to.equal(true)
      const owls = rows.find(row => row.id === w.ids.sameSeason)!
      expect(owls.seasonNames).to.deep.equal(['Demo Regular'])
      expect(owls.staffNames, 'The coach is named').to.include('Ichiro')
      const searched = await get(
        `/teams?view=public&query=${encodeURIComponent(`Owls ${w.ids.tag}`)}`
      )
      expect(searched.status).to.equal(200)
      expect(
        (searched.body as Array<{ seasonNames?: string[] }>)[0].seasonNames
      ).to.deep.equal(['Demo Regular'])
      const refused = await get(
        `/teams?view=public&relatedTeam=${encodeURIComponent(w.ids.teamA)}&query=ea`
      )
      expect(refused.status).to.equal(400)
    },

    // E2–E10: the scene from a team, its scrolling title, the selector's
    // suggestions, a closed selector keeping the draft, search, a swap that
    // moves the source team, a placeholder staged and not made, Cancel
    // making nothing, and Save making one placeholder and the game.
    'team-game': async ctx => {
      const s = await scene(ctx)
      const {
        w,
        m,
        evaluate,
        wait,
        shot,
        button,
        exists,
        tap,
        fill,
        toTop,
        see
      } = s
      const names = w.ids
      // E2: created from a team.
      await s.open(s.createRoute, 'Create Game')
      expect(
        await exists(`${names.teamAName}, Home`),
        'Hawks is not choosable'
      ).to.equal(false)
      await see(names.teamAName)
      expect(
        await exists('Choose Away Team'),
        'The opponent is to choose'
      ).to.equal(true)
      // A team page's game is a scrimmage or exhibition: a note, no switch.
      expect(
        await evaluate<boolean>(
          `document.querySelector('input[aria-label="Exhibition"]')==null`
        )
      ).to.equal(true)
      await see('always creates a scrimmage/exhibition game')
      expect(
        await evaluate<string>(
          `${button('Save')}.getAttribute('aria-disabled')`
        )
      ).to.equal('true')
      await m.evalBrowserScript({
        script: `${button('Save')}.scrollIntoView({block:'center'})`
      })
      await shot('team-game-note.png')
      await toTop()
      await shot('create-game-after.png')
      const now = new Date()
      const next = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 14)
      )
      const day = next.toISOString().slice(0, 10)
      await s.chooseDate(day)
      await fill('Venue name (optional)', 'North Field')
      // E3: the title moves into the header as the scene scrolls.
      await m.evalBrowserScript({
        script: `window.scrollTo(0,600);for(const node of document.querySelectorAll('div'))if(node.scrollHeight>node.clientHeight+20&&['auto','scroll'].includes(getComputedStyle(node).overflowY))node.scrollTop=600`
      })
      await wait(
        `Array.from(document.querySelectorAll('div')).some(node=>{if(node.textContent!=='Create Game'||node.getAttribute('aria-level')!=null)return false;const r=node.getBoundingClientRect();if(r.top>70||r.bottom<0)return false;let opacity=1;for(let n=node;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity>0.9})`
      )
      await shot('create-game-scrolled.png')
      // E4: the selector slides up with suggestions.
      await tap('Choose Away Team')
      await wait(
        `document.querySelector('[data-testid="team-selector"]')!=null`
      )
      await see('Suggested')
      await wait(
        `document.querySelector('[data-testid="team-result-${names.sameSeason}"]')!=null`
      )
      const order = await evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-testid^="team-result-"]')).map(node=>node.getAttribute('data-testid').slice(12))`
      )
      expect(order[0], 'Same-season team first').to.equal(names.sameSeason)
      expect(order, 'Hawks is not offered against itself').to.not.include(
        names.teamA
      )
      expect(
        await evaluate<string>(
          `document.querySelector('[data-testid="team-staff-${names.sameSeason}"]').textContent`
        )
      ).to.include('Ichiro')
      const labels = await evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-testid="team-selector"] [role="button"]')).map(node=>node.getAttribute('aria-label')??node.textContent)`
      )
      expect(labels.at(-1)?.startsWith('Create Placeholder Team')).to.equal(
        true
      )
      await shot('team-picker-after.png')
      // E5: closing keeps the draft.
      await tap('Cancel team selector')
      await wait(
        `document.querySelector('[data-testid="team-selector"]')==null`
      )
      expect(await exists('Choose Away Team')).to.equal(true)
      expect(
        await evaluate<string>(
          `document.querySelector('[aria-label="Venue name (optional)"]').value`
        )
      ).to.equal('North Field')
      expect(
        await evaluate<string>(
          `document.querySelector('[data-testid="event-schedule-date"]').textContent`
        )
      ).to.include(day)
      // E6: search every team.
      await tap('Choose Away Team')
      await fill('Search all teams', `Eagles ${names.tag}`)
      await tap(`Choose ${names.teamBName}`)
      await wait(
        `document.querySelector('[data-testid="team-selector"]')==null`
      )
      expect(await exists(`${names.teamBName}, Away`)).to.equal(true)
      // E7: a swap moves the source team; it is never replaceable.
      await tap('Swap home and away')
      expect(await exists(`${names.teamBName}, Home`)).to.equal(true)
      expect(await exists(`${names.teamAName}, Away`)).to.equal(false)
      await toTop()
      await shot('source-team-swapped.png')
      await tap(`${names.teamBName}, Home`)
      await see('Suggested')
      expect(await exists(`Choose ${names.teamAName}`)).to.equal(false)
      // E8: a placeholder is staged, not created.
      const placeholder = `Riverside Owls ${names.tag}`
      await tap('Create Placeholder Team')
      await see(`Kept by ${names.teamAName}`)
      await fill('Team name', placeholder)
      await tap('Continue')
      // The shared creation step starts with the custodian's location.
      await see(names.city)
      await shot('placeholder-form.png')
      await tap('Continue')
      await tap('Skip')
      await wait(
        `document.querySelector('[data-testid="team-selector"]')==null`
      )
      expect(await exists(`${placeholder}, Home · Placeholder`)).to.equal(true)
      expect((await s.placeholders()).length).to.equal(0)
      await toTop()
      await shot('placeholder-staged.png')
      // E9: Cancel creates nothing.
      await tap('Cancel')
      await wait(`!location.pathname.endsWith('/create-game')`)
      expect((await s.placeholders()).length).to.equal(0)
      // E10: Save creates one placeholder, with no location, then the game.
      await s.open(s.createRoute, 'Create Game')
      await tap('Choose Away Team')
      await tap('Create Placeholder Team')
      await fill('Team name', placeholder)
      await tap('Continue')
      await tap('Skip')
      await tap('Skip')
      await wait(
        `document.querySelector('[data-testid="team-selector"]')==null`
      )
      await tap('Save')
      await wait(`!location.pathname.endsWith('/create-game')`)
      const [request] = await sql(
        ctx,
        `select id, initiating_team_id, status from group_requests where initiating_team_id = $1 order by sent_at desc limit 1`,
        [names.teamA]
      )
      const made = await s.placeholders()
      expect(made.length).to.equal(1)
      expect(made[0].locality).to.equal(null)
      expect(made[0].custodian_id).to.equal(names.teamA)
      appendFileSync(
        s.savedLog,
        `$ select initiating_team_id, status from group_requests where id = '${request.id}'\n${JSON.stringify(request)}\n\n`
      )
      expect(request.initiating_team_id).to.equal(names.teamA)
      await see(
        request.status === 'accepted' ? 'Game scheduled' : 'Game proposal sent'
      )
      await s.done()
    },

    // E11: a season's game, either side choosable and swappable, counting
    // for its standings unless marked exhibition.
    'season-game': async ctx => {
      const s = await scene(ctx)
      const { w, evaluate, wait, shot, button, exists, tap, fill, toTop, see } =
        s
      const names = w.ids
      await s.open(
        `/groups/season/${encodeURIComponent(names.seasonA)}/create-game`,
        'Create Game'
      )
      expect(await exists('Choose Home Team')).to.equal(true)
      expect(await exists('Choose Away Team')).to.equal(true)
      expect(
        await evaluate<boolean>(
          `document.querySelector('input[aria-label="Exhibition"]').checked`
        )
      ).to.equal(false)
      expect(
        await evaluate<boolean>(
          `document.body.textContent.includes('always creates a scrimmage/exhibition game')`
        )
      ).to.equal(false)
      await tap('Choose Home Team')
      await see('Suggested')
      await tap(`Choose ${names.teamAName}`)
      await tap('Choose Away Team')
      await tap(`Choose ${names.sameSeasonName}`)
      await tap('Swap home and away')
      await tap(`${names.teamAName}, Away`)
      await fill('Search all teams', `Eagles ${names.tag}`)
      await tap(`Choose ${names.teamBName}`)
      await wait(
        `document.querySelector('[data-testid="team-selector"]')==null`
      )
      await wait(`${button(`${names.teamBName}, Away`)}!=null`)
      expect(await exists(`${names.sameSeasonName}, Home`)).to.equal(true)
      await toTop()
      await shot('season-create-game.png')
      await s.done()
    },

    // E12–E13: Game Settings with the saved values, a change saved; a
    // season's game keeps its Exhibition switch; withdrawal labels fit a
    // narrow phone, Keep game keeps it, and confirming withdraws.
    'game-settings': async ctx => {
      const s = await scene(ctx)
      const {
        w,
        m,
        web,
        evaluate,
        wait,
        shot,
        button,
        exists,
        tap,
        toTop,
        see
      } = s
      const names = w.ids
      await s.open(`/games/${names.seasonGame}/settings`, 'Game Settings')
      expect(
        await evaluate<boolean>(
          `document.querySelector('input[aria-label="Exhibition"]').checked`
        )
      ).to.equal(true)
      await m.evalBrowserScript({
        script: `document.querySelector('input[aria-label="Exhibition"]').scrollIntoView({block:'center'})`
      })
      await shot('game-settings-season.png')
      const settings = `/games/${encodeURIComponent(names.settingsGame)}/settings`
      await s.open(settings, 'Game Settings')
      expect(
        await evaluate<boolean>(
          `document.querySelector('input[aria-label="Exhibition"]')==null&&!document.body.textContent.includes('always creates a scrimmage/exhibition game')`
        )
      ).to.equal(true)
      expect(
        await evaluate<string>(
          `document.querySelector('[aria-label="Venue name (optional)"]').value`
        )
      ).to.equal('Riverside Park')
      expect(await exists(`${names.teamAName}, Home`)).to.equal(true)
      expect(await exists(`${names.teamBName}, Away`)).to.equal(true)
      await toTop()
      await shot('game-settings-after.png')
      // From 11 AM to noon; the saved 1 PM end stays after it.
      await s.chooseTime(12, 0)
      await tap('Save')
      await see('Game changes saved')
      const [changed] = await sql(
        ctx,
        'select start_at from games where id = $1',
        [names.settingsGame]
      )
      expect(new Date(changed.start_at).toISOString()).to.equal(
        '2026-11-14T20:00:00.000Z'
      )
      // E13: withdrawal labels fit a narrow phone, at full height.
      await web.session.resize({ width: 320, height: 874 })
      await s.open(settings, 'Game Settings')
      for (const name of [names.teamAName, names.teamBName]) {
        const fit = await evaluate<{
          height: number
          lines: number
          clipped: boolean
        }>(
          `(()=>{const node=${button(`Withdraw ${name}`)};const label=Array.from(node.querySelectorAll('div')).find(n=>n.textContent===${JSON.stringify(`Withdraw ${name}`)});const style=getComputedStyle(label);return{height:node.getBoundingClientRect().height,lines:Math.round(label.getBoundingClientRect().height/parseFloat(style.lineHeight||style.fontSize)),clipped:label.scrollWidth>label.clientWidth+1}})()`
        )
        expect(
          fit.height,
          `Withdraw ${name} is at least 48 high`
        ).to.be.at.least(48)
        expect(
          !fit.clipped && fit.lines <= 1,
          `Withdraw ${name} fits one line`
        ).to.equal(true)
      }
      await tap(`Withdraw ${names.teamAName}`)
      await m.evalBrowserScript({
        script: `${button('Keep game')}.scrollIntoView({block:'center'})`
      })
      await shot('withdraw-narrow.png')
      await tap('Keep game')
      const status = async (): Promise<Record<string, any>> =>
        (
          await sql(
            ctx,
            'select status, cancellation_reason from games where id = $1',
            [names.settingsGame]
          )
        )[0]
      expect((await status()).status).to.equal('scheduled')
      await tap(`Withdraw ${names.teamAName}`)
      await tap('Confirm withdrawal')
      await wait(`!location.pathname.endsWith('/settings')`)
      expect(await status()).to.deep.equal({
        status: 'cancelled',
        cancellation_reason: 'withdrawal'
      })
      await web.session.resize(PHONE)
      await s.done()
    },

    // E14–E15: Practice keeps the event form under the scene's title and
    // needs no title; Other needs one; the schedule names each by its type.
    'practice-and-other': async ctx => {
      const s = await scene(ctx)
      const { w, m, evaluate, wait, button, tap, fill, see } = s
      const names = w.ids
      // E15's first half: the seeded schedule, before any scene changes it.
      await scheduleShot(s, 'schedule-events-after.png')
      // E14
      await s.open(s.createRoute, 'Create Game')
      await tap('Practice')
      await wait(
        `Array.from(document.querySelectorAll('[role="heading"],[aria-level]')).some(node=>node.textContent==='Create Practice')`
      )
      expect(
        await evaluate<boolean>(
          `document.body.textContent.includes('Create Event')`
        )
      ).to.equal(false)
      expect(
        await evaluate<boolean>(
          `document.querySelector('[aria-label="Title"]')==null`
        )
      ).to.equal(true)
      await tap('Create event')
      await wait(`location.pathname.startsWith('/games/')`)
      const practices = await sql(
        ctx,
        `select event_type, title from team_events where team_id = $1 and event_type = 'practice' and title = 'Practice'`,
        [names.teamA]
      )
      expect(practices.length).to.equal(1)
      // E15
      await s.open(s.createRoute, 'Create Game')
      await tap('Other')
      await wait(`document.querySelector('[aria-label="Title"]')!=null`)
      expect(
        await evaluate<string>(
          `${button('Create event')}.getAttribute('aria-disabled')`
        )
      ).to.equal('true')
      await fill('Title', 'Season party')
      await tap('Create event')
      await wait(`location.pathname.startsWith('/games/')`)
      await s.web.go(`/teams/${encodeURIComponent(names.teamA)}?tab=schedule`)
      await see('Season party')
      // Rows mount near the screen, so they are gathered on the way down it.
      const rowLines = new Map<string, string>()
      for (let step = 0; step < 12; step++) {
        const seen = await evaluate<Array<[string, string]>>(
          `Array.from(document.querySelectorAll('[data-testid="scheduleGame"]')).map(row=>[row.textContent,Array.from(row.querySelectorAll('div')).filter(node=>node.childElementCount===0).map(node=>node.textContent).find(line=>line!=='' && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\\d+)$/.test(line))])`
        )
        for (const [row, line] of seen) rowLines.set(row, line)
        await m.evalBrowserScript({
          script: `const page=Array.from(document.querySelectorAll('*')).filter(node=>/auto|scroll/.test(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight).sort((a,b)=>b.clientHeight-a.clientHeight)[0];if(page!=null)page.scrollTop+=page.clientHeight*0.8`
        })
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      const firstLines = [...rowLines.values()]
      expect(
        firstLines.filter(line => line === 'Practice').length,
        `Two practices read Practice: ${JSON.stringify(firstLines)}`
      ).to.equal(2)
      expect(firstLines).to.include('Team dinner')
      expect(firstLines).to.include('Season party')
      expect(firstLines).to.not.include('Morning drills')
      expect(firstLines.some(line => line.includes(names.teamBName))).to.equal(
        true
      )
      await s.done()
    },

    // E16: the time zone and month pickers are rows and plain cells, with a
    // red Cancel, never walls of pills.
    pickers: async ctx => {
      const s = await scene(ctx)
      const { m, evaluate, tap, see, shot } = s
      await s.open(s.createRoute, 'Create Game')
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="event-schedule-timezone"]').scrollIntoView({block:'center'})`
      })
      await m.tapOn({ id: 'event-schedule-timezone' })
      await m.assertVisible({ text: 'Choose time zone', timeout: 10000 })
      await shot('timezone-picker-after.png')
      await tap('Cancel time zone picker')
      await m.tapOn({ id: 'event-schedule-date' })
      await m.assertVisible({ text: 'Choose date', timeout: 10000 })
      await m.tapOn({ css: '[aria-label^="Choose month:"]' })
      await m.assertVisible({ text: 'June', timeout: 10000 })
      await shot('month-picker-after.png')
      await tap('Cancel date picker')
      await s.open(s.createRoute, 'Create Game')
      await m.tapOn({ id: 'event-schedule-timezone' })
      await see('Choose time zone')
      const zone = await evaluate<{
        rows: number
        pills: number
        cancel: string
      }>(
        `(()=>{const rows=Array.from(document.querySelectorAll('[aria-label^="Use time zone "]'));return{rows:rows.length,pills:rows.filter(row=>parseFloat(getComputedStyle(row).borderRadius)>=20).length,cancel:getComputedStyle(Array.from(document.querySelector('[aria-label="Cancel time zone picker"]').querySelectorAll('div')).find(node=>node.textContent==='Cancel')).color}})()`
      )
      expect(zone.rows, 'Time zones are listed').to.be.above(10)
      expect(zone.pills, 'No time zone is a pill').to.equal(0)
      expect(zone.cancel, 'Cancel is red text').to.equal('rgb(186, 26, 26)')
      await tap('Cancel time zone picker')
      await s.done()
    }
  }
})
