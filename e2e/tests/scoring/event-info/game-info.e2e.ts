import { expect } from 'chai'

import type { FixtureManifest } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  api,
  at,
  type EventWeb,
  hierarchyReady,
  inMapFrame,
  mapTileHost,
  openEventWeb,
  pointInMapFrame,
  sql,
  waitInMapFrame
} from '../../../rigs/eventWeb'

/**
 * A game's Info tab and a team's events in a desktop browser: the map, the
 * family's RSVP pills, a title-only event, a failed reply rolled back, the
 * tab the page opens on before and after play, editing and canceling an
 * event, its times in other zones, a future game's end, and a game whose
 * scheduled end passes while it is open. The `event-info` world's owner
 * (Babe Ruth) runs the Hawks and is guardian of Mike Trout and Ichiro, who
 * play for them.
 *
 * Map tiles come from the stack's tile provider; an outage is maestro-d's
 * `mockNetwork` answering them 503.
 */

const WINDOW = { width: 1280, height: 800 }

const SELECTED_TAB = `document.querySelector('[role="tab"][aria-selected="true"]:not([data-testid="navigation-sidebar"] *)')?.textContent`
const LAST_TAB = `Array.from(document.querySelectorAll('[role="tab"]')).filter(n=>['Info','Box score','Videos','Score Game','DJ Game'].includes(n.textContent)).at(-1)?.textContent`
const BOX_SCORE_SELECTED =
  '[role="tab"][aria-selected="true"][aria-label="Box score"]'

const rsvpId = (userId: string): string => `event-rsvp-${userId}`

async function world(ctx: HarnessContext): Promise<FixtureManifest> {
  return await ctx.fixture('event-info')
}

async function signedIn(
  ctx: HarnessContext,
  w: FixtureManifest,
  emulation = {}
): Promise<EventWeb> {
  await hierarchyReady(ctx)
  return await openEventWeb(ctx, w.accounts.owner, WINDOW, emulation)
}

async function open(
  web: EventWeb,
  route: string,
  id = 'event-info'
): Promise<void> {
  await web.go(route)
  await web.m.assertVisible({ id, timeout: 20000 })
}

/** The family's pills live in the RSVP sheet the "Are you going?" card opens. */
async function openReplies(web: EventWeb, owner: string): Promise<void> {
  await web.m.scrollUntilVisible({
    element: { id: 'event-replies-open' },
    direction: 'UP',
    maxScrolls: 8
  })
  await web.m.tapOn({ id: 'event-replies-open' })
  await web.m.assertVisible({ id: `${rsvpId(owner)}-0`, timeout: 10000 })
}

async function closeReplies(web: EventWeb): Promise<void> {
  await web.m.tapOn({ text: 'Done' })
  await web.page.waitForFunction(
    `document.querySelector('[data-testid="event-rsvp-modal"]')==null`,
    { timeout: 5000 }
  )
}

async function checked(web: EventWeb, id: string): Promise<string> {
  return await web.evaluate<string>(
    `document.querySelector('[data-testid="${id}"]').getAttribute('aria-checked')`
  )
}

async function noPageErrors(web: EventWeb): Promise<void> {
  expect(web.errors, 'No app JavaScript errors').to.deep.equal([])
  await web.session.close()
}

/** A play that begins the game: it has a pitch put in play. */
const FIRST_PLAY = {
  mode: 'live',
  source: { system: 'manual' },
  plays: [
    {
      about: {
        atBatIndex: 0,
        inning: 1,
        halfInning: 'top',
        isScoringPlay: false
      },
      count: { outs: 1 },
      result: {
        eventType: 'field_out',
        awayScore: 0,
        homeScore: 0,
        description: 'Ground out'
      },
      playEvents: [{ isPitch: true, details: { isInPlay: true } }]
    }
  ]
}

/** A team event on the Hawks, made in the database. */
async function teamEvent(
  ctx: HarnessContext,
  w: FixtureManifest,
  title: string,
  address: string | null
): Promise<string> {
  const id = `tev_${w.nonce}_${Math.random().toString(36).slice(2, 10)}`
  await sql(
    ctx,
    `insert into team_events (id, team_id, event_type, title, start_at, end_at, timezone, address)
     values ($1, $2, 'other', $3, $4, $5, 'UTC', $6)`,
    [
      id,
      w.ids.teamA,
      title,
      '2027-04-12T19:00:00Z',
      '2027-04-12T21:00:00Z',
      address
    ]
  )
  return id
}

export default defineHarness({
  id: 'scoring/event-info/game-info',
  title: "A game's Info tab: map, family replies, tabs and event editing",
  kind: 'e2e',
  covers: [
    'src/app/screens/EventInfoTab.tsx',
    'src/app/screens/EventRsvpModal.tsx',
    'src/app/screens/EventSettingsScreen.tsx',
    'src/app/screens/EventDetailsForm.tsx',
    'src/app/screens/eventTabPolicy.ts',
    'src/app/components/EventMap.tsx',
    'src/server/routes/eventInfo.ts',
    'src/server/events/eventInfo.ts'
  ],
  stack: 'isolated',
  fixtures: ['event-info'],
  exclusive: false,
  surfaces: {
    // No 3D: headless Chromium on a browser droplet.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 12,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    // An upcoming game opens on Info, its map pans under a real drag, and
    // failed tiles recover through the frame's own retry button.
    'map-and-tiles': async ctx => {
      const w = await world(ctx)
      const web = await signedIn(ctx, w)
      const { m, page } = web
      await open(web, `/games/${w.ids.game}`)
      await m.assertVisible({ text: 'Are you going?', timeout: 10000 })
      expect(await web.evaluate(SELECTED_TAB)).to.equal('Info')
      await m.assertVisible({ id: 'event-location-map', timeout: 10000 })
      await waitInMapFrame(page, 'window.eventMap!=null')
      const before = await inMapFrame<{ lat: number; lng: number }>(
        page,
        'window.eventMap.getCenter()'
      )
      const map = await web.evaluate<{
        x: number
        y: number
        width: number
        height: number
      }>(
        `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`
      )
      await m.dragAndDrop({
        from: {
          point: at(map.x + map.width * 0.35, map.y + map.height / 2 + 30)
        },
        to: {
          point: at(map.x + map.width * 0.65, map.y + map.height / 2 + 30)
        },
        holdDuration: 100,
        duration: 500
      })
      const after = await inMapFrame<{ lat: number; lng: number }>(
        page,
        'window.eventMap.getCenter()'
      )
      expect(after.lng, 'The SDK map pans under a real drag').to.not.equal(
        before.lng
      )
      await web.shot('game-after.png')
      await m.mockNetwork({
        url: `*${await mapTileHost(page)}*`,
        response: { status: 503, body: 'Synthetic tile outage' }
      })
      await m.dragAndDrop({
        from: { point: at(map.x + map.width * 0.2, map.y + map.height / 2) },
        to: { point: at(map.x + map.width * 0.8, map.y + map.height / 2) },
        holdDuration: 100,
        duration: 500
      })
      await waitInMapFrame(
        page,
        `document.querySelector('#error').style.display==='block'`
      )
      await web.shot('map-tiles-retry.png')
      await m.clearNetworkMocks()
      const retry = await pointInMapFrame(page, '#retry-map-tiles')
      await m.tapOnPoint({ x: Math.round(retry.x), y: Math.round(retry.y) })
      await waitInMapFrame(
        page,
        `document.querySelector('#error').style.display==='none'`
      )
      await noPageErrors(web)
    },

    // The owner answers for self and both children: the capsule blends as it
    // is dragged and snaps to Yes, arrow keys move one reply, enlarged labels
    // stay inside their choices, the replies are saved, Maybe persists, and
    // the address copies.
    'family-replies': async ctx => {
      const w = await world(ctx)
      const { owner, trout, ichiro } = w.accounts
      const web = await signedIn(ctx, w)
      const { m } = web
      const me = owner.userId
      await open(web, `/games/${w.ids.game}`)
      await openReplies(web, me)
      await m.scrollUntilVisible({
        element: { id: `${rsvpId(me)}-1` },
        direction: 'DOWN',
        centerElement: true,
        maxScrolls: 8
      })
      await m.tapOn({ id: `${rsvpId(me)}-1` })
      const rect = await web.evaluate<{ width: number }>(
        `(()=>{const r=document.querySelector('[data-testid="${rsvpId(me)}"]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`
      )
      await m.evalBrowserScript({
        script: `window.__rsvpColors=[];const stop=performance.now()+1800;function sample(){window.__rsvpColors.push(getComputedStyle(document.querySelector('[data-testid="${rsvpId(me)}-fill"]')).backgroundColor);if(performance.now()<stop)requestAnimationFrame(sample)}sample();`
      })
      expect(rect.width).to.be.greaterThan(0)
      await m.dragAndDrop({
        from: { id: `${rsvpId(me)}-1` },
        to: { id: `${rsvpId(me)}-0` },
        holdDuration: 100,
        duration: 600
      })
      await m.waitForAnimationToEnd()
      const colors = await web.evaluate<string[]>('window.__rsvpColors')
      expect(
        new Set(colors).size,
        'Dragging blends through intermediate colors'
      ).to.be.greaterThan(2)
      expect(await checked(web, `${rsvpId(me)}-0`)).to.equal('true')
      await m.tapOn({ id: `${rsvpId(me)}-1` })
      const ready = async (choice: number): Promise<void> => {
        await m.assertVisible({
          css: `[data-testid="${rsvpId(me)}-${choice}"]:not([aria-disabled="true"])`,
          timeout: 5000
        })
      }
      await ready(1)
      await m.pressKey({ key: 'LEFT' })
      expect(await checked(web, `${rsvpId(me)}-0`)).to.equal('true')
      await ready(0)
      await m.pressKey({ key: 'RIGHT' })
      expect(await checked(web, `${rsvpId(me)}-1`)).to.equal('true')
      await ready(1)
      await m.pressKey({ key: 'LEFT' })
      expect(
        await web.evaluate(
          `(()=>{const p=document.querySelector('[data-testid="${rsvpId(me)}"]');const row=p.parentElement.parentElement;return p.getBoundingClientRect().top-row.getBoundingClientRect().top<20})()`
        ),
        'The pill remains on the avatar/name row'
      ).to.equal(true)
      await m.scrollUntilVisible({
        element: { id: `${rsvpId(me)}-1` },
        direction: 'DOWN',
        centerElement: true,
        maxScrolls: 8
      })
      await m.tapOn({ id: `${rsvpId(trout.userId)}-2` })
      await m.tapOn({ id: `${rsvpId(ichiro.userId)}-0` })
      for (const id of [me, trout.userId, ichiro.userId])
        await m.assertVisible({
          css: `[data-testid="${rsvpId(id)}-0"]:not([aria-disabled="true"])`,
          timeout: 10000
        })
      const saved = await api(ctx, owner, 'GET', `/events/${w.ids.game}/info`)
      expect(
        (saved.body.attendees as Array<{ userId: string; response: string }>)
          .filter(row => [me, trout.userId, ichiro.userId].includes(row.userId))
          .map(row => row.response)
          .sort()
      ).to.deep.equal(['no', 'yes', 'yes'])
      await open(web, `/games/${w.ids.game}`)
      await openReplies(web, me)
      await m.scrollUntilVisible({
        element: { id: `${rsvpId(me)}-1` },
        direction: 'DOWN',
        centerElement: true,
        maxScrolls: 8
      })
      await m.tapOn({ id: `${rsvpId(me)}-1` })
      await m.waitForAnimationToEnd()
      await m.scrollUntilVisible({
        element: { id: `${rsvpId(me)}-1` },
        direction: 'DOWN',
        centerElement: true,
        maxScrolls: 8
      })
      await web.shot('family-rsvps.png')
      await closeReplies(web)
      await m.scrollUntilVisible({
        element: { id: 'attendance-players-yes' },
        direction: 'DOWN',
        centerElement: true,
        maxScrolls: 8
      })
      await web.shot('attendance-after.png')
      // Text-only enlargement, where native accessibility scales glyphs
      // without widening the fixed capsule. The styles are put back after.
      await openReplies(web, me)
      await m.evalBrowserScript({
        script: `window.__rsvpFonts=[];for(const label of document.querySelectorAll('[role="radiogroup"] [role="radio"] > div')){window.__rsvpFonts.push([label,label.style.fontSize]);label.style.fontSize=(parseFloat(getComputedStyle(label).fontSize)*2)+'px'}`
      })
      expect(
        await web.evaluate(
          `Array.from(document.querySelectorAll('[role="radiogroup"] [role="radio"]')).every(choice=>{const range=document.createRange();range.selectNodeContents(choice.querySelector('div'));const text=range.getBoundingClientRect(), target=choice.getBoundingClientRect();return text.left>=target.left-1&&text.right<=target.right+1})`
        ),
        'Enlarged labels stay within their colored choices'
      ).to.equal(true)
      await web.shot('rsvp-large-text.png')
      await m.evalBrowserScript({
        script: `for(const [label,font] of window.__rsvpFonts)label.style.fontSize=font;delete window.__rsvpFonts`
      })
      await closeReplies(web)
      await m.scrollUntilVisible({
        element: { id: 'event-address' },
        direction: 'UP',
        maxScrolls: 8
      })
      await m.longPressOn({ id: 'event-address' })
      await m.assertVisible({ text: 'Address copied', timeout: 10000 })
      await noPageErrors(web)
    },

    // An Other event made with a title alone, which the team schedule lists.
    'title-only-event': async ctx => {
      const w = await world(ctx)
      const web = await signedIn(ctx, w)
      const { m } = web
      await web.go(`/groups/team/${w.ids.teamA}/create-game`)
      await m.assertVisible({ text: 'Other', timeout: 20000 })
      await m.tapOn({ text: 'Other' })
      await m.assertVisible({ text: 'Create Event' })
      await web.shot('creation-after.png')
      const fill = async (label: string, text: string): Promise<void> => {
        await m.tapOn({ css: `input[aria-label=${JSON.stringify(label)}]` })
        await m.eraseText()
        await m.inputText({ text })
      }
      await fill('Title', 'Team dinner')
      await fill('Venue address (optional)', '1 Demo Way, Demo City')
      await m.scrollUntilVisible({
        element: { text: 'Create event' },
        direction: 'DOWN',
        maxScrolls: 8
      })
      await m.tapOn({ text: 'Create event' })
      await m.assertVisible({ text: 'Are you going?', timeout: 20000 })
      await web.shot('event-title.png')
      const events = await sql(
        ctx,
        'select id, title from team_events where team_id = $1',
        [w.ids.teamA]
      )
      expect(events.length).to.equal(1)
      expect(events[0].title).to.equal('Team dinner')
      await open(web, `/games/${events[0].id}`)
      await m.assertVisible({ text: 'Team dinner' })
      await web.go(`/teams/${w.ids.teamA}?tab=schedule`)
      await m.assertVisible({ text: 'Team dinner', timeout: 20000 })
      await web.shot('schedule-after.png')
      await noPageErrors(web)
    },

    // An address that cannot be located shows a retry, which recovers once
    // the place is known. The stack's Places stand-in answers every address
    // with one fixed place, so no lookup can fail there.
    'geocode-failure-retry': async () => {
      throw new BlockedError(
        "needs a stack whose geocoder can be told to find no place for one address: the Places stand-in (e2e/fixtures/placesAnswers.json) answers every lookup with the same place, so 'The address could not be located' never shows"
      )
    },

    // A failed HTTP write rolls back only its own pill.
    'rsvp-rollback': async ctx => {
      const w = await world(ctx)
      const { owner, trout, ichiro } = w.accounts
      for (const [userId, response] of [
        [trout.userId, 'no'],
        [ichiro.userId, 'yes']
      ])
        await sql(
          ctx,
          `insert into game_rsvps (event_id, user_id, response, updated_by) values ($1, $2, $3, $4)`,
          [w.ids.game, userId, response, owner.userId]
        )
      const web = await signedIn(ctx, w)
      const { m } = web
      await open(web, `/games/${w.ids.game}`)
      const fail = `fail_event_rsvp_${w.nonce}`
      await sql(
        ctx,
        `create function ${fail}() returns trigger language plpgsql as $$begin if new.user_id='${trout.userId}' then raise exception 'Synthetic RSVP write failure'; end if; return new; end$$`
      )
      await sql(
        ctx,
        `create trigger ${fail} before insert or update on game_rsvps for each row execute function ${fail}()`
      )
      try {
        await openReplies(web, owner.userId)
        await m.tapOn({ id: `${rsvpId(trout.userId)}-0` })
        await m.scrollUntilVisible({
          element: { text: 'Something went wrong' },
          direction: 'DOWN',
          centerElement: true,
          maxScrolls: 5
        })
        await m.assertVisible({ text: 'Something went wrong', timeout: 10000 })
        expect(await checked(web, `${rsvpId(trout.userId)}-2`)).to.equal('true')
        expect(await checked(web, `${rsvpId(ichiro.userId)}-0`)).to.equal(
          'true'
        )
        await web.shot('rsvp-rollback.png')
      } finally {
        await sql(ctx, `drop trigger ${fail} on game_rsvps`)
        await sql(ctx, `drop function ${fail}()`)
      }
      await closeReplies(web)
      await noPageErrors(web)
    },

    // The first play moves the page to Box score; explicit tab addresses,
    // Videos and browser Back; a final game lists Info last.
    'tab-defaults': async ctx => {
      const w = await world(ctx)
      const game = w.ids.game
      const web = await signedIn(ctx, w)
      const { m } = web
      await open(web, `/games/${game}`)
      const scoring = await api(
        ctx,
        w.accounts.owner,
        'POST',
        `/games/${game}/events`,
        FIRST_PLAY
      )
      expect(scoring.status, JSON.stringify(scoring.body)).to.equal(200)
      // Opened again, it reads the play.
      await web.go(`/games/${game}`)
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 10000 })
      expect(await web.evaluate(SELECTED_TAB)).to.equal('Box score')
      await open(web, `/games/${game}?tab=info`)
      expect(await web.evaluate(SELECTED_TAB)).to.equal('Info')
      await web.go(`/games/${game}?tab=watch`)
      await m.assertVisible({ text: 'No videos', timeout: 10000 })
      await web.go(`/games/${game}?tab=boxScore`)
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 10000 })
      await web.go(`/games/${game}`)
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 10000 })
      await m.tapOn({
        css: '[role="tab"][aria-label="Videos"]:not([data-testid="navigation-sidebar"] *)'
      })
      await m.assertVisible({ text: 'No videos', timeout: 10000 })
      await m.back()
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 10000 })
      await sql(
        ctx,
        `update games set status = 'final', home_score = 0, away_score = 0 where id = $1`,
        [game]
      )
      await web.go(`/games/${game}`)
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 10000 })
      expect(await web.evaluate(LAST_TAB)).to.equal('Info')
      await web.shot('game-ended-after.png')
      await noPageErrors(web)
    },

    // An event edited and canceled from its settings; with no address it
    // draws no map and has only Info.
    'event-edit-cancel': async ctx => {
      const w = await world(ctx)
      const event = await teamEvent(
        ctx,
        w,
        'Team dinner',
        '1 Demo Way, Demo City'
      )
      const web = await signedIn(ctx, w)
      const { m } = web
      await web.go(`/games/${event}/settings`)
      await m.assertVisible({ text: 'Save event details', timeout: 10000 })
      await m.tapOn({ css: 'input[aria-label="Title"]' })
      await m.eraseText()
      await m.inputText({ text: 'Team picnic' })
      await m.scrollUntilVisible({
        element: { text: 'Cancel event' },
        direction: 'DOWN',
        maxScrolls: 8
      })
      await m.tapOn({ text: 'Cancel event' })
      await m.scrollUntilVisible({
        element: { text: 'Back' },
        direction: 'DOWN',
        maxScrolls: 8
      })
      await m.tapOn({ text: 'Save event details' })
      await m.assertVisible({ text: 'Canceled', timeout: 10000 })
      await m.scrollUntilVisible({
        element: { text: 'Canceled' },
        direction: 'UP',
        centerElement: true,
        maxScrolls: 8
      })
      await web.shot('event-edit-cancel.png')
      const [row] = await sql(
        ctx,
        'select title from team_events where id = $1',
        [event]
      )
      expect(row.title).to.equal('Team picnic')
      await api(ctx, w.accounts.owner, 'PUT', `/events/${event}/info`, {
        address: null
      })
      await open(web, `/games/${event}`)
      expect(
        await web.evaluate(`document.querySelector('iframe')==null`)
      ).to.equal(true)
      expect(await web.evaluate(SELECTED_TAB)).to.equal('Info')
      await noPageErrors(web)
    },

    // An overnight event, one ending at local midnight and one ending the
    // same local day, each read in its own zone.
    'event-time-zones': async ctx => {
      const w = await world(ctx)
      const event = await teamEvent(ctx, w, 'Team dinner', null)
      for (const [timezone, startAt, endAt, name] of [
        ['UTC', '2037-04-10T18:00:00Z', '2037-04-11T17:00:00Z', 'overnight'],
        [
          'America/Los_Angeles',
          '2037-04-11T06:00:00Z',
          '2037-04-11T08:00:00Z',
          'local-midnight'
        ],
        [
          'America/Los_Angeles',
          '2037-04-10T23:00:00Z',
          '2037-04-11T01:00:00Z',
          'same-local-day'
        ]
      ] as const) {
        const response = await api(
          ctx,
          w.accounts.owner,
          'PUT',
          `/events/${event}/info`,
          { startAt, endAt, timezone }
        )
        expect(response.status).to.equal(200)
        const web = await signedIn(ctx, w, { timeZone: timezone })
        await open(web, `/games/${event}`)
        const includesDate = name !== 'same-local-day'
        const endTime = new Intl.DateTimeFormat('en', {
          timeZone: timezone,
          hour: 'numeric',
          minute: '2-digit'
        }).format(new Date(endAt))
        const endDay = includesDate
          ? new Intl.DateTimeFormat('en', {
              timeZone: timezone,
              weekday: 'long',
              month: 'long',
              day: 'numeric'
            }).format(new Date(endAt)) + ', '
          : ''
        await web.m.assertVisible({ id: 'event-hero-time', timeout: 10000 })
        expect(
          await web.evaluate<string>(
            `document.querySelector('[data-testid="event-hero-time"]').textContent`
          )
        ).to.include(`– ${endDay}${endTime}`)
        await web.shot(`event-${name}.png`)
        await noPageErrors(web)
      }
    },

    // A future game given an end: the end's date starts on its local day,
    // and Save stores it.
    'future-game-end': async ctx => {
      const w = await world(ctx)
      const futureId = `gam_future_end_${w.nonce}`
      await sql(
        ctx,
        `insert into games (id, home_team_id, away_team_id, season_id, start_at, timezone)
         values ($1, $2, $3, null, $4, 'America/Los_Angeles')`,
        [futureId, w.ids.teamA, w.ids.teamB, '2037-07-02T02:00:00Z']
      )
      await sql(
        ctx,
        `insert into scope_roles (id, scope_type, scope_id, user_id, role) values ($1, 'team', $2, $3, 'admin')`,
        [`rol_future_${w.nonce}`, w.ids.teamB, w.accounts.owner.userId]
      )
      const web = await signedIn(ctx, w)
      const { m } = web
      await web.go(`/games/${futureId}/settings`)
      await m.assertVisible({ text: 'Game Settings', timeout: 10000 })
      await m.scrollUntilVisible({
        element: { text: 'Set end time' },
        direction: 'DOWN',
        maxScrolls: 8
      })
      await m.tapOn({ text: 'Set end time' })
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="event-schedule-date"]').getAttribute('aria-label')`
        )
      ).to.equal('Date: 2037-07-01')
      await web.shot('future-game-end-date.png')
      await m.scrollUntilVisible({
        element: { text: 'Save' },
        direction: 'DOWN',
        maxScrolls: 8
      })
      await m.tapOn({ text: 'Save' })
      await web.page.waitForFunction(
        () => !location.pathname.endsWith('/settings')
      )
      const [saved] = await sql(ctx, 'select end_at from games where id = $1', [
        futureId
      ])
      expect(new Date(saved.end_at as string).toISOString()).to.equal(
        '2037-07-02T05:00:00.000Z'
      )
      await noPageErrors(web)
    },

    // A game whose scheduled end passes while it is open moves to Box score
    // and lists Info last, with no reload.
    'end-boundary': async ctx => {
      const w = await world(ctx)
      const endingId = `gam_event_boundary_${w.nonce}`
      const web = await signedIn(ctx, w)
      await sql(
        ctx,
        `insert into games (id, home_team_id, away_team_id, season_id, start_at, end_at)
         values ($1, $2, $3, null, $4, $5)`,
        [
          endingId,
          w.ids.teamA,
          w.ids.teamB,
          new Date(Date.now() - 60000).toISOString(),
          // Long enough for the page to load on Info first.
          new Date(Date.now() + 15000).toISOString()
        ]
      )
      await open(web, `/games/${endingId}`)
      expect(await web.evaluate(SELECTED_TAB)).to.equal('Info')
      await web.m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 25000 })
      expect(await web.evaluate(LAST_TAB)).to.equal('Info')
      await noPageErrors(web)
    }
  }
})
