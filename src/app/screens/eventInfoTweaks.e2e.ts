import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { makeId } from '../../common/ids'
import { SESSION_COOKIE } from '../../server/auth/tokens'
import { serverConfig } from '../../server/serverConfig'
import { groupFixture } from '../../test/groupFixtures'

async function main(): Promise<void> {
  const artifacts = resolve(process.env.EVENT_INFO_ARTIFACTS!)
  mkdirSync(artifacts, { recursive: true })
  const load = createRequire(
    join(process.env.MAESTRO_D_CLIENT_ROOT!, 'package.json')
  )
  const { MaestroD } = load('maestro-d')
  const bin = process.env.MAESTRO_D_BIN!
  execFileSync(bin, ['ps'], { stdio: 'inherit' })
  const name = process.env.MAESTRO_D ?? 'event-info-tweaks'
  const device = 'event-info-tweaks-chromium'
  const f = await groupFixture(resolve('dist'))
  const daemon = await MaestroD.connect({ name, bin })
  try {
    for (const id of [103, 104]) {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          team_id: f.teamA,
          user_id: id,
          is_player: true
        })
        .execute()
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: 101,
          related_user_id: id,
          kind: 'guardian',
          can_manage: false
        })
        .execute()
    }
    await f.h.db
      .insertInto('memberships')
      .values({ id: makeId('membership'), team_id: f.teamB, user_id: 101 })
      .execute()
    for (const [id, status, offset] of [
      ['gam_upcoming', 'scheduled', 86400000],
      ['gam_no_venue', 'scheduled', 86400000],
      ['gam_past', 'scheduled', -86400000],
      ['gam_final', 'final', 86400000],
      ['gam_cancelled', 'cancelled', 86400000],
      ['gam_live', 'inProgress', 86400000]
    ] as const) {
      await f.h.db
        .insertInto('games')
        .values({
          id,
          status,
          home_team_id: f.teamA,
          away_team_id: f.teamB,
          start_at: new Date(Date.now() + offset),
          venue: id === 'gam_no_venue' ? null : 'Demo Park',
          address: '1 Demo Way',
          latitude: 34,
          longitude: 12
        })
        .execute()
    }
    const m = await daemon.attach({
      device,
      platform: 'web',
      commandTimeout: 30000,
      url: f.h.origin,
      extra: {
        browser: 'chromium',
        windowSize: process.env.EVENT_INFO_VIEWPORT ?? '390x844'
      }
    })
    await m.openBrowser({ url: f.h.origin })
    await m.setCookies({
      cookies: [
        {
          name: SESSION_COOKIE,
          value: f.h.tokens.get(101)!,
          domain: '127.0.0.1',
          path: '/'
        }
      ]
    })
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await m.evalBrowserScript({
        script: `return JSON.stringify(${expression})`
      })
      assert(typeof result.data === 'string')
      return JSON.parse(result.data) as T
    }
    const wait = async (expression: string): Promise<void> => {
      const end = Date.now() + 30000
      while (!(await evaluate<boolean>(expression))) {
        assert(Date.now() < end, expression)
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
    const tap = async (id: string): Promise<void> => {
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="${id}"]').scrollIntoView({block:'center'})`
      })
      await m.tapOn({ id })
    }
    await m.openBrowser({ url: f.h.origin + `/teams/${f.teamA}?tab=schedule` })
    await wait(
      `document.querySelector('[data-testid="schedule-rsvp-control-gam_upcoming"]')!=null`
    )
    assert(
      await evaluate<boolean>(
        `['gam_past','gam_final','gam_cancelled','gam_live'].every(id=>document.querySelector('[data-testid="schedule-rsvp-control-'+id+'"]')==null)`
      )
    )
    const sizes = await evaluate<{ button: number; count: number }>(
      `(()=>{const footer=document.querySelector('[data-testid="schedule-rsvps-gam_upcoming"]');return{button:footer.querySelector('[data-testid="schedule-rsvp-button"]').getBoundingClientRect().height,count:footer.querySelector('[data-testid="player-rsvp-count-unknown"]').getBoundingClientRect().height}})()`
    )
    assert(Math.abs(sizes.button - sizes.count) < 2)
    assert.equal(sizes.button, 32)
    const layout = await evaluate<{
      aligned: boolean
      calendars: boolean
    }>(`(()=>{
      const footer=document.querySelector('[data-testid="schedule-rsvps-gam_upcoming"]'), card=footer.closest('[data-testid="schedule-row"]');
      const control=footer.querySelector('[role="button"]'), details=card.querySelector('[data-testid="schedule-details"]');
      return {aligned:Math.abs(control.getBoundingClientRect().left-details.getBoundingClientRect().left)<1,
        calendars:Array.from(document.querySelectorAll('[data-testid="schedule-date"]')).every(node=>{
          const weekday=node.querySelector('[data-testid="schedule-weekday"]'),separator=node.querySelector('[data-testid="schedule-date-separator"]');
          const date=node.getBoundingClientRect(), row=node.closest('[data-testid="schedule-row"]'), body=row?.querySelector('[data-testid="schedule-body"]');
          if (body && Math.abs((body.getBoundingClientRect().left-date.right)-parseFloat(getComputedStyle(row.parentElement).paddingLeft))>1) return false;
          return weekday && separator && weekday.getBoundingClientRect().bottom<=separator.getBoundingClientRect().top && separator.getBoundingClientRect().height===3 &&
            getComputedStyle(separator).marginTop==='8px' && getComputedStyle(separator).marginBottom==='8px' &&
            getComputedStyle(weekday).fontSize==='15px' && getComputedStyle(node.querySelectorAll('[dir="auto"]')[1]).fontSize==='20px' &&
            getComputedStyle(node.lastElementChild).fontSize==='32px';
        })};
    })()`)
    assert(layout.aligned && layout.calendars)
    assert(
      await evaluate<boolean>(`['gam_upcoming','gam_no_venue'].every(id=>{
      const footer=document.querySelector('[data-testid="schedule-rsvps-'+id+'"]'),row=footer.closest('[data-testid="schedule-row"]');
      return Math.abs(footer.getBoundingClientRect().bottom-row.getBoundingClientRect().bottom)<1;
    })`)
    )
    assert(
      await evaluate<boolean>(`(()=>{
      const footer=document.querySelector('[data-testid="schedule-rsvps-gam_upcoming"]');
      const row=footer.closest('[data-testid="schedule-row"]'), date=row.querySelector('[data-testid="schedule-date"]');
      const details=row.querySelector('[data-testid="schedule-details"]').getBoundingClientRect(), needed=Math.max(date.getBoundingClientRect().height, footer.getBoundingClientRect().bottom-details.top);
      return Math.abs(row.getBoundingClientRect().height-needed)<2;
    })()`)
    )
    console.log(
      'All calendar columns show weekday above separator; RSVP button aligns with event details'
    )
    await tap('schedule-rsvp-control-gam_upcoming')
    await wait(
      `document.querySelector('[data-testid="event-rsvp-104-2"]')!=null`
    )
    for (const [id, choice] of [
      [101, 0],
      [103, 2],
      [104, 0]
    ] as const) {
      await tap(`event-rsvp-${id}-${choice}`)
      await wait(
        `document.querySelector('[data-testid="event-rsvp-${id}-${choice}"]').getAttribute('aria-disabled')!=='true'`
      )
    }
    await tap('event-rsvp-104-1')
    await wait(
      `document.querySelector('[data-testid="event-rsvp-104-1"]').getAttribute('aria-disabled')!=='true'`
    )
    await m.tapOn({ text: 'Done' })
    await wait(
      `document.querySelectorAll('[data-testid^="schedule-rsvp-avatar-"]').length===3`
    )
    const colors = await evaluate<string[]>(
      `[101,103,104].map(id=>getComputedStyle(document.querySelector('[data-testid="schedule-rsvp-avatar-'+id+'"]')).borderColor)`
    )
    assert(
      await evaluate<boolean>(`(()=>{
      const footer=document.querySelector('[data-testid="schedule-rsvps-gam_upcoming"]');
      const avatars=Array.from(footer.querySelectorAll('[data-testid^="schedule-rsvp-avatar-"]'));
      const pills=Array.from(footer.querySelectorAll('[data-testid^="player-rsvp-count-"]'));
      return [...avatars,...pills].every(node=>node.getBoundingClientRect().height===32);
    })()`)
    )
    assert.deepEqual(colors, [
      'rgb(32, 138, 75)',
      'rgb(203, 57, 65)',
      'rgb(35, 118, 207)'
    ])
    writeFileSync(join(artifacts, 'schedule-avatars.png'), await m.screenshot())
    await tap('schedule-rsvp-control-gam_upcoming')
    await wait(
      `document.querySelector('[data-testid="event-rsvp-103-2"]')?.getAttribute('aria-checked')==='true'`
    )
    await m.tapOn({ text: 'Done' })
    await m.openBrowser({ url: f.h.origin + `/teams/${f.teamA}?tab=schedule` })
    await wait(
      `document.querySelectorAll('[data-testid^="schedule-rsvp-avatar-"]').length===3`
    )
    console.log(
      'Upcoming-only controls, badge sizing, durable family avatars and reopening passed'
    )
    const calendarSelector = '[data-testid="schedule-rsvps-gam_upcoming"]'
    await m.evalBrowserScript({
      script: `document.querySelector('${calendarSelector}').closest('[data-testid="schedule-row"]').querySelector('[data-testid="schedule-date"]').scrollIntoView({block:'center'})`
    })
    await m.tapOn({
      css: '[data-testid="schedule-row"]:has([data-testid="schedule-rsvps-gam_upcoming"]) [data-testid="schedule-date"]'
    })
    await wait(
      `document.querySelector('[data-testid="event-attendance-teams"]')!=null`
    )
    assert(
      await evaluate<boolean>(`(()=>{
      const cards=Array.from(document.querySelectorAll('[data-testid^="attendance-"]')).filter(node=>/^attendance-(staff|players|others)-(yes|maybe|no|noReply)-\\d+$/.test(node.dataset.testid));
      return cards.length>0 && cards.every(card=>parseFloat(getComputedStyle(card).paddingLeft)===0 && parseFloat(getComputedStyle(card.firstElementChild).paddingLeft)===16 && parseFloat(getComputedStyle(card.firstElementChild).paddingTop)===16);
    })()`)
    )
    await m.evalBrowserScript({
      script: `document.querySelector('[data-testid^="attendance-players-"] [data-testid^="attendance-players-"]').scrollIntoView({block:'center'})`
    })
    writeFileSync(
      join(artifacts, 'compact-attendance.png'),
      await m.screenshot()
    )
    const hero = await evaluate<{
      separate: boolean
      color: string
      font: number
    }>(`(()=>{
      const date=document.querySelector('[data-testid="event-hero-date"]'), time=document.querySelector('[data-testid="event-hero-time"]');
      return {separate:date.getBoundingClientRect().bottom<=time.getBoundingClientRect().top,color:getComputedStyle(date).color,font:parseFloat(getComputedStyle(date).fontSize)};
    })()`)
    assert(
      hero.separate && hero.color === 'rgb(0, 0, 0)' && hero.font === 13.75
    )
    writeFileSync(join(artifacts, 'hero-two-lines.png'), await m.screenshot())
    console.log('Hero date and time occupy two larger black lines')
    assert(
      await evaluate<boolean>(
        `!document.querySelector('[data-testid="event-attendance-teams"]').textContent.includes('RSVPs') && !document.body.textContent.includes('No one yet')`
      )
    )
    const spacing = await evaluate<number>(
      `(()=>{const card=document.querySelector('[data-testid="event-replies"]'),header=card.previousElementSibling;return card.getBoundingClientRect().top-header.getBoundingClientRect().bottom})()`
    )
    assert(spacing >= 0 && spacing <= 8)
    await m.evalBrowserScript({
      script: `document.querySelector('[aria-label="RSVP teams"]').scrollIntoView({block:'center'})`
    })
    const points = await evaluate<Array<{ x: number; y: number }>>(
      `Array.from(document.querySelector('[aria-label="RSVP teams"]').querySelectorAll('[role="tab"]')).map(node=>{const r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})`
    )
    const drag = async (from: number, to: number): Promise<void> => {
      await m.dragAndDrop({
        from: {
          point: `${Math.round(points[from].x)},${Math.round(points[from].y)}`
        },
        to: {
          point: `${Math.round(points[to].x)},${Math.round(points[to].y)}`
        },
        holdDuration: 100,
        duration: 800
      })
    }
    await drag(0, 1)
    await wait(
      `document.querySelectorAll('[aria-label="RSVP teams"] [role="tab"]')[1]?.getAttribute('aria-selected')==='true'`
    )
    await drag(1, 0)
    await wait(
      `document.querySelectorAll('[aria-label="RSVP teams"] [role="tab"]')[0]?.getAttribute('aria-selected')==='true'`
    )
    // A finger that strays well below the rail keeps the drag, and the pill
    // goes on from where it was let go: it never jumps back to where it began.
    await m.evalBrowserScript({
      script: `window.__pillTrace=[];(function tick(){const fill=document.querySelector('[aria-label="RSVP teams"] [data-testid="segmented-pill-fill"]');window.__pillTrace.push(new DOMMatrix(getComputedStyle(fill).transform).m41);if(window.__pillTrace.length<3000)requestAnimationFrame(tick)})()`
    })
    await m.dragAndDrop({
      from: {
        point: `${Math.round(points[0].x)},${Math.round(points[0].y)}`
      },
      to: {
        point: `${Math.round(points[1].x)},${Math.round(points[1].y + 120)}`
      },
      holdDuration: 100,
      duration: 800
    })
    await wait(
      `document.querySelectorAll('[aria-label="RSVP teams"] [role="tab"]')[1]?.getAttribute('aria-selected')==='true'`
    )
    await new Promise(resolve => setTimeout(resolve, 600))
    const trace = await evaluate<{ half: number; values: number[] }>(
      `({half:document.querySelector('[aria-label="RSVP teams"]').getBoundingClientRect().width/2,values:window.__pillTrace})`
    )
    const moved = trace.values.findIndex(value => value > trace.half / 4)
    assert(moved >= 0, 'The team pill follows the finger')
    assert(
      trace.values.slice(moved).every(value => value > trace.half / 8),
      'The team pill never jumps back after it is let go'
    )
    assert(Math.abs(trace.values[trace.values.length - 1] - trace.half) < 2)
    await drag(1, 0)
    await wait(
      `document.querySelectorAll('[aria-label="RSVP teams"] [role="tab"]')[0]?.getAttribute('aria-selected')==='true'`
    )
    // The same for an RSVP capsule, from Yes to No with the finger below it.
    const rsvpId = await evaluate<string>(
      `document.querySelector('[data-testid="event-replies"] [role="radiogroup"]').getAttribute('data-testid')`
    )
    await tap(`${rsvpId}-0`)
    await wait(
      `document.querySelector('[data-testid="${rsvpId}-0"]').getAttribute('aria-checked')==='true'`
    )
    const rsvp = await evaluate<{
      yes: { x: number; y: number }
      no: { x: number; y: number }
    }>(
      `(()=>{const radios=document.querySelectorAll('[data-testid="${rsvpId}"] [role="radio"]'),at=n=>{const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}};return{yes:at(radios[0]),no:at(radios[2])}})()`
    )
    await m.dragAndDrop({
      from: { point: `${Math.round(rsvp.yes.x)},${Math.round(rsvp.yes.y)}` },
      to: {
        point: `${Math.round(rsvp.no.x)},${Math.round(rsvp.no.y + 120)}`
      },
      holdDuration: 100,
      duration: 800
    })
    await wait(
      `document.querySelector('[data-testid="${rsvpId}-2"]').getAttribute('aria-checked')==='true'`
    )
    console.log(
      'Pills keep a straying finger and settle from where they are let go'
    )
    writeFileSync(join(artifacts, 'info-after.png'), await m.screenshot())
    console.log(
      'Empty sections omitted, compact family spacing and two-way team pill drag passed'
    )
    await m.openBrowser({ url: f.h.origin + '/schedule?when=all' })
    await wait(
      `document.querySelector('[data-testid="schedule-display-row"]')!=null`
    )
    await wait(`Array.from(document.querySelectorAll('[data-testid="schedule-display-row"]')).every(row=>{
      const date=row.querySelector('[data-testid="schedule-date"]').getBoundingClientRect(), details=row.querySelector('[data-testid="schedule-details"]').getBoundingClientRect();
      return Math.abs(date.bottom-details.bottom)<1;
    })`)
    assert(
      await evaluate<boolean>(`Array.from(document.querySelectorAll('[data-testid="schedule-display-row"]')).every(row=>{
      const date=row.querySelector('[data-testid="schedule-date"]'), weekday=date.querySelector('[data-testid="schedule-weekday"]'), day=date.lastElementChild;
      const ratio=parseFloat(getComputedStyle(day).fontSize)/parseFloat(getComputedStyle(weekday).fontSize);
      return Math.abs(ratio-32/15)<.01 && parseFloat(getComputedStyle(weekday).fontSize)<15 && row.querySelector('[data-testid^="schedule-rsvps-"]')==null;
    })`)
    )
    writeFileSync(join(artifacts, 'display-schedule.png'), await m.screenshot())
    console.log(
      'Non-RSVP date columns shrink proportionally to the unchanged detail column height'
    )
    const keysFile = process.env.GOOGLE_MAPS_KEY_FILE
    if (keysFile != null) {
      const keys = JSON.parse(readFileSync(keysFile, 'utf8'))
      serverConfig.googleMaps = { webApiKey: keys['Maps JavaScript API'] }
      await m.openBrowser({
        url: f.h.origin + '/games/gam_upcoming?section=info'
      })
      await wait(
        `document.querySelector('[data-testid="event-location-map"]')?.contentWindow?.eventMapCenter!=null`
      )
      assert(
        await evaluate<boolean>(
          `document.querySelector('[data-testid="event-location-map"]').contentWindow.eventMap instanceof document.querySelector('[data-testid="event-location-map"]').contentWindow.google.maps.Map`
        )
      )
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="event-location-map"]').scrollIntoView({block:'center'})`
      })
      const mapPoints = await evaluate<Array<{ x: number; y: number }>>(
        `(()=>{const r=document.querySelector('[data-testid="event-location-map"]').getBoundingClientRect();return[{x:r.left+r.width*.6,y:r.top+r.height*.65},{x:r.left+r.width*.3,y:r.top+r.height*.5}]})()`
      )
      await m.dragAndDrop({
        from: {
          point: `${Math.round(mapPoints[0].x)},${Math.round(mapPoints[0].y)}`
        },
        to: {
          point: `${Math.round(mapPoints[1].x)},${Math.round(mapPoints[1].y)}`
        },
        duration: 800
      })
      await wait(
        `Math.abs(document.querySelector('[data-testid="event-location-map"]').contentWindow.eventMapCenter.longitude-12)>.0001`
      )
      writeFileSync(join(artifacts, 'google-map.png'), await m.screenshot())
      console.log(
        'Real Google Maps JavaScript SDK loaded and map dragged successfully'
      )
    }
  } finally {
    await daemon.detach(device).catch(() => undefined)
    await daemon.shutdown()
    daemon.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
