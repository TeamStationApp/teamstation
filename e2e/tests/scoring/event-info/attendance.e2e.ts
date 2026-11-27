import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { asEventInfo } from '../../../../src/common/eventInfo'
import {
  eventArrivalTime,
  eventHeroLines
} from '../../../../src/common/eventTime'
import type { GameRequestTerms } from '../../../../src/common/gameApprovals'
import type { FixtureManifest } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  api,
  at,
  dismissNotificationAsk,
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
 * The Info tab of a game with a whole team around it, in a desktop browser
 * in Los Angeles: the family's capsules and their geometry, nine exact
 * attendance sections, the map, a rolled-back reply, the team chooser and a
 * visitor's privacy, viewer-local times, titled creation and settings with
 * a lost response, game-change proposals and their approval, the tab the
 * page opens on, daylight saving's repeated hour, and the team schedule's
 * player counts. The `event-info-people` world holds the people, staff,
 * family and replies the old fixture seeded.
 *
 * A lost or held response is a page script installed before the app loads
 * (the browser's `beforeLoad`), which holds the one request the scenario
 * arms and lets the rest through.
 */

const WINDOW = { width: 1280, height: 800 }
const ZONE = 'America/Los_Angeles'

/** Holds the event creation POST or the settings PUT the page arms. */
const HOLD = `(()=>{const fetch0=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await fetch0(...args);if(window.holdEventCreation&&String(args[0]).endsWith('/api/v1/events')&&args[1]&&args[1].method==='POST'){window.holdEventCreation=false;await new Promise(resolve=>{window.releaseEventCreation=resolve});throw new Error('Synthetic lost event response')}if(window.holdEventSettings&&String(args[0]).endsWith('/info')&&args[1]&&args[1].method==='PUT'){window.holdEventSettings=false;await new Promise(resolve=>{window.releaseEventSettings=resolve});window.eventSettingsReplyDelivered=true}return response}})()`

/**
 * What the web app says of a create whose answer never came: since the web
 * runs the phone's queued client, the lost response reads as no signal
 * (`OFFLINE_CREATE_MESSAGE` in `src/app/sync/cachingClient.ts`).
 */
const OFFLINE_CREATE = "Available when you're back online."

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

interface Selector {
  id?: string
  text?: string
  css?: string
}

/** The page, signed in as one of the world's people, and its steps. */
interface Info {
  ctx: HarnessContext
  w: FixtureManifest
  web: EventWeb
  m: any
  id: (role: string) => string
  wait: (expression: string) => Promise<void>
  see: (selector: Selector, direction?: string) => Promise<void>
  tap: (selector: Selector, direction?: string) => Promise<void>
  open: (route: string, target?: string) => Promise<void>
  shot: (file: string) => Promise<void>
  fill: (label: string, text: string) => Promise<void>
  chooseDate: (key: 'date' | 'endDate', value: string) => Promise<void>
  chooseTime: (key: 'time' | 'endTime', value: string) => Promise<void>
  chooseZone: (zone: string) => Promise<void>
  settleTimezoneScene: () => Promise<void>
  selected: () => Promise<string>
  signInAs: (role: string) => Promise<void>
  done: () => Promise<void>
}

async function info(
  ctx: HarnessContext,
  options: { zone?: string; as?: string; world?: FixtureManifest } = {}
): Promise<Info> {
  const w = options.world ?? (await ctx.fixture('event-info-people'))
  await hierarchyReady(ctx)
  const web = await openEventWeb(
    ctx,
    w.accounts[options.as ?? 'owner'],
    WINDOW,
    { timeZone: options.zone ?? ZONE, beforeLoad: HOLD }
  )
  const { m } = web
  const id = (role: string): string => w.accounts[role].userId
  // The API traffic the page saw, as evidence.
  const network: string[] = []
  web.page.on('response', (response: any) => {
    if (
      !/\/api\/v1\/(locations(?:\?|$)|events(?:\/|$)|game-requests(?:\/|$)|me\/notifications(?:\/|$)|games\/[^/]+\/(?:scheduling|events))/.test(
        response.url()
      )
    )
      return
    const path = new URL(response.url())
    network.push(
      `$ browser ${response.request().method()} ${path.pathname}${path.search} ${response.status()}`
    )
  })
  const wait = async (expression: string): Promise<void> => {
    await web.wait(expression, 10000)
  }
  const see = async (selector: Selector, direction = 'DOWN'): Promise<void> => {
    await m.scrollUntilVisible({
      element: selector,
      direction,
      centerElement: true,
      maxScrolls: 20
    })
  }
  const tap = async (selector: Selector, direction = 'DOWN'): Promise<void> => {
    const css =
      selector.css ??
      (selector.id == null
        ? undefined
        : `[data-testid=${JSON.stringify(selector.id)}]`)
    if (css != null)
      await m.evalBrowserScript({
        script: `document.querySelector(${JSON.stringify(css)})?.scrollIntoView({block:'center',inline:'nearest'})`
      })
    if (selector.text != null)
      await m.evalBrowserScript({
        script: `Array.from(document.querySelectorAll('[role="button"]')).find(node=>node.getAttribute('aria-label')===${JSON.stringify(selector.text)}||node.textContent===${JSON.stringify(selector.text)})?.scrollIntoView({block:'center',inline:'nearest'})`
      })
    await m.assertVisible({ ...selector, timeout: 5000 })
    const target =
      css != null
        ? `document.querySelector(${JSON.stringify(css)})`
        : `Array.from(document.querySelectorAll('[role="button"],[role="radio"]')).find(node=>node.getAttribute('aria-label')===${JSON.stringify(selector.text)}||node.textContent===${JSON.stringify(selector.text)})`
    await wait(
      `(()=>{const node=${target};return node&&node.getAttribute('aria-disabled')!=='true'&&!node.disabled})()`
    )
    await m.evalBrowserScript({
      script: `const node=${target};if(node){for(let parent=node.parentElement;parent;parent=parent.parentElement){if(parent.scrollHeight>parent.clientHeight&&['auto','scroll'].includes(getComputedStyle(parent).overflowY))parent.scrollTop+=node.getBoundingClientRect().top-window.innerHeight/2}node.scrollIntoView({block:'center',inline:'nearest'})}`
    })
    const point = await web.evaluate<{
      x: number
      y: number
      clear: boolean
    } | null>(
      `(()=>{const node=${target};if(!node)return null;const r=node.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return{x,y,clear:hit===node||node.contains(hit)}})()`
    )
    expect(
      point?.clear,
      `The ${JSON.stringify(selector)} control must be unobstructed`
    ).to.equal(true)
    await m.tapOnPoint({ x: Math.round(point!.x), y: Math.round(point!.y) })
  }
  const open = async (
    route: string,
    target = `event-reply-row-${id('owner')}`
  ): Promise<void> => {
    await web.go(route)
    await m.evalBrowserScript({
      script: `window.scrollTo(0,0);for(const node of document.querySelectorAll('div'))if(node.scrollTop>0)node.scrollTop=0`
    })
    await m.assertVisible({
      css: '[aria-label="Info"][role="tab"]',
      timeout: 20000
    })
    await see({ id: target })
  }
  const shot = async (file: string): Promise<void> => {
    // The settled selected capsule, rather than its transition frame.
    await wait(
      `Array.from(document.querySelectorAll('[role="radiogroup"]')).every(group=>{const fill=group.querySelector('[data-testid$="-fill"]');if(!fill)return true;const choices=[...group.querySelectorAll('[role="radio"]')],index=choices.findIndex(node=>node.getAttribute('aria-checked')==='true');if(index<0)return true;const transform=getComputedStyle(fill).transform;const x=transform==='none'?0:new DOMMatrixReadOnly(transform).m41;return Math.abs(x-index*group.getBoundingClientRect().width/3)<0.5})`
    )
    await web.shot(file)
  }
  const fill = async (label: string, text: string): Promise<void> => {
    await tap({ css: `[aria-label=${JSON.stringify(label)}]` })
    await m.evalBrowserScript({
      script: `const input=document.querySelector('[aria-label=${JSON.stringify(label)}]');input.focus();input.select()`
    })
    await m.eraseText()
    await m.inputText({ text, css: `[aria-label=${JSON.stringify(label)}]` })
    await wait(
      `document.querySelector('[aria-label=${JSON.stringify(label)}]').value===${JSON.stringify(text)}`
    )
  }
  const chooseDate = async (
    key: 'date' | 'endDate',
    value: string
  ): Promise<void> => {
    await tap({ id: `event-schedule-${key}` })
    await fill('Year', value.slice(0, 4))
    await tap({ css: '[aria-label^="Choose month:"]' })
    await tap({ text: MONTHS[Number(value.slice(5, 7)) - 1] })
    await tap({ css: `[aria-label="Choose ${value}"]` })
    await tap({ text: 'Use date' })
  }
  const chooseTime = async (
    key: 'time' | 'endTime',
    value: string
  ): Promise<void> => {
    await tap({ id: `event-schedule-${key}` })
    const [hour, minute] = value.split(':').map(Number)
    for (const [column, option] of [
      ['hour', hour % 12 === 0 ? 12 : hour % 12],
      ['minute', minute],
      ['period', hour < 12 ? 0 : 1]
    ] as const) {
      // The column scrolls through maestro-d's page script; its visible
      // option is then tapped.
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
    await tap({ text: 'Use time' })
  }
  // The time zone picker slides up as a scene of its own: type into it
  // once it has come to rest.
  const settleTimezoneScene = async (): Promise<void> => {
    await m.assertVisible({
      css: '[data-testid="timezone-picker"]',
      timeout: 10000
    })
    await m.waitForAnimationToEnd()
    await wait(
      `(()=>{const node=document.querySelector('[aria-label="Find time zone"]');if(!node)return false;const r=node.getBoundingClientRect();window.__tzTop=window.__tzTop??[];window.__tzTop.push(r.top);const seen=window.__tzTop.slice(-3);return seen.length===3&&seen.every(top=>top===seen[0])})()`
    )
    await m.evalBrowserScript({ script: 'window.__tzTop=undefined' })
  }
  const chooseZone = async (zone: string): Promise<void> => {
    await tap({ id: 'event-schedule-timezone' })
    await settleTimezoneScene()
    await fill('Find time zone', zone.replace(/_/g, ' '))
    await tap({
      css: `[aria-label=${JSON.stringify(`Use time zone ${zone}`)}]`
    })
  }
  return {
    ctx,
    w,
    web,
    m,
    id,
    wait,
    see,
    tap,
    open,
    shot,
    fill,
    chooseDate,
    chooseTime,
    chooseZone,
    settleTimezoneScene,
    selected: async () =>
      await web.evaluate<string>(
        `document.querySelector('[aria-label="Game sections"] [role="tab"][aria-selected="true"]')?.textContent`
      ),
    signInAs: async role => {
      await web.signInAs(w.accounts[role])
    },
    done: async () => {
      writeFileSync(
        ctx.artifact(`browser-api.${ctx.scenarioId.split('#').at(-1)}.log`),
        network.join('\n') + '\n'
      )
      expect(web.errors, 'No app JavaScript errors').to.deep.equal([])
      await web.session.close()
    }
  }
}

/** A setup statement's game row: `games` with the world's two teams. */
async function insertGame(
  ctx: HarnessContext,
  w: FixtureManifest,
  id: string,
  startAt: string,
  endAt: string | null
): Promise<void> {
  await sql(
    ctx,
    `insert into games (id, home_team_id, away_team_id, season_id, start_at, end_at)
     values ($1, $2, $3, null, $4, $5)`,
    [id, w.ids.teamA, w.ids.teamB, startAt, endAt]
  )
}

/** Replies the world has not got, as an earlier step of the old flow left them. */
async function replied(
  ctx: HarnessContext,
  w: FixtureManifest,
  replies: Record<string, string>
): Promise<void> {
  for (const [role, response] of Object.entries(replies))
    await sql(
      ctx,
      `insert into game_rsvps (event_id, user_id, response, updated_by) values ($1, $2, $3, $4)`,
      [w.ids.game, w.accounts[role].userId, response, w.accounts.owner.userId]
    )
}

/** The Info tab's capsule and card geometry, as the old checks measured it. */
async function shape(page: Info, enlarged = false): Promise<void> {
  const owner = page.id('owner')
  const geometry = await page.web.evaluate<{
    width: number
    fillHeight: number
    radius: number
    wordLines: number
    safe: boolean
    rowX: number
    heroX: number
    rowWidth: number
    heroWidth: number
  }>(`(()=>{
    const root=document.querySelector('[data-testid="event-rsvp-${owner}"]'), fill=root.querySelector('[data-testid$="-fill"]');
    const card=document.querySelector('[data-testid="event-replies"]').getBoundingClientRect(), hero=document.querySelector('[data-testid="event-hero"]').getBoundingClientRect();
    let safe=true, wordLines=0;
    for(const choice of root.querySelectorAll('[role="radio"]')){
      const box=choice.getBoundingClientRect(), radius=parseFloat(getComputedStyle(fill).borderRadius), walker=document.createTreeWalker(choice,NodeFilter.SHOW_TEXT);
      let node;while(node=walker.nextNode()){for(let i=0;i<node.textContent.length;i++){if(!node.textContent[i].trim())continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();if(r.left<box.left+radius-0.5||r.right>box.right-radius+0.5)safe=false}if(node.textContent==='Maybe'){const r=document.createRange();r.selectNodeContents(node);wordLines=r.getClientRects().length}}
    }
    return {width:root.getBoundingClientRect().width,fillHeight:fill.getBoundingClientRect().height,radius:parseFloat(getComputedStyle(fill).borderRadius),wordLines,safe,rowX:card.x,heroX:hero.x,rowWidth:card.width,heroWidth:hero.width}
  })()`)
  expect(
    geometry.safe,
    'Every label glyph stays out of the rounded arcs'
  ).to.equal(true)
  expect(
    Math.abs(geometry.rowX - geometry.heroX) < 1 &&
      Math.abs(geometry.rowWidth - geometry.heroWidth) < 1,
    'Reply cards share hero margins'
  ).to.equal(true)
  if (!enlarged) {
    expect(geometry.fillHeight).to.equal(32)
    expect(geometry.wordLines, 'Maybe fits in one straight line').to.equal(1)
  }
}

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
      // A play begins a game once it has a pitch or a ball in play.
      playEvents: [{ isPitch: true, details: { isInPlay: true } }]
    }
  ]
}

const BOX_SCORE_SELECTED =
  '[role="tab"][aria-selected="true"][aria-label="Box score"]'

export default defineHarness({
  id: 'scoring/event-info/attendance',
  title: "A team's game Info: replies, attendance, proposals and times",
  kind: 'e2e',
  covers: [
    'src/app/screens/EventInfoTab.tsx',
    'src/app/screens/EventRsvpModal.tsx',
    'src/app/screens/EventSettingsScreen.tsx',
    'src/app/screens/EventDetailsForm.tsx',
    'src/app/screens/GameFormScreen.tsx',
    'src/app/screens/ScheduleRsvpControl.tsx',
    'src/app/screens/eventTabPolicy.ts',
    'src/app/components/EventMap.tsx',
    'src/common/eventTime.ts',
    'src/server/routes/eventInfo.ts',
    'src/server/events/eventInfo.ts'
  ],
  stack: 'isolated',
  fixtures: ['event-info-people'],
  exclusive: false,
  surfaces: {
    // No 3D: headless Chromium on a browser droplet.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 25,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    // The owner's own and children's replies in the capsules, their
    // geometry normal and enlarged, a drag through the colours, the
    // keyboard, Maybe kept; then the nine exact-team sections.
    'replies-and-sections': async ctx => {
      const page = await info(ctx)
      const { w, m, web, id, tap, see, wait, open, shot } = page
      const owner = id('owner')
      await open(`/games/${w.ids.game}`)
      expect(await page.selected()).to.equal('Info')
      expect(
        await web.evaluate<string>(
          `document.querySelector('[data-testid="event-hero"]').textContent`
        )
      ).to.include(
        eventHeroLines(
          '2027-04-10T19:00:00Z',
          '2027-04-10T21:00:00Z',
          undefined,
          ZONE
        ).join('')
      )
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="event-info"]').textContent.includes('UTC')`
        )
      ).to.equal(false)
      // The Info card lists replies; a tap opens the RSVP modal.
      await tap({ id: 'event-replies-open' })
      await m.assertVisible({ id: 'event-rsvp-modal', timeout: 20000 })
      await tap({ id: `event-rsvp-${owner}-0` })
      await tap({ id: `event-rsvp-${owner}-1` })
      await tap({ id: `event-rsvp-${id('trout')}-2` })
      await tap({ id: `event-rsvp-${id('ichiro')}-0` })
      await wait(
        `document.querySelector('[data-testid="event-rsvp-${owner}-1"]').getAttribute('aria-disabled')!=='true'`
      )
      await shape(page)
      await see({ id: `quick-rsvp-row-${owner}` }, 'UP')
      await shot('info-after.png')
      await m.evalBrowserScript({
        script: `window.__tracks=[];for(const track of document.querySelectorAll('[role="radiogroup"]')){window.__tracks.push([track,track.style.width]);track.style.width=(parseFloat(getComputedStyle(track).width)*2)+'px'}window.__fonts=[];for(const label of document.querySelectorAll('[role="radiogroup"] [role="radio"] > div')){window.__fonts.push([label,label.style.fontSize,label.style.lineHeight]);label.style.fontSize=(parseFloat(getComputedStyle(label).fontSize)*2)+'px';label.style.lineHeight=(parseFloat(getComputedStyle(label).lineHeight)*2)+'px'}`
      })
      await shape(page, true)
      await shot('pill-enlarged.png')
      await m.evalBrowserScript({
        script: `for(const [node,font,line] of window.__fonts){node.style.fontSize=font;node.style.lineHeight=line}delete window.__fonts;for(const [node,width]of window.__tracks)node.style.width=width;delete window.__tracks`
      })
      await see({ id: `event-rsvp-${owner}` }, 'UP')
      await wait(
        `document.querySelector('[data-testid="event-rsvp-${owner}-1"]').getAttribute('aria-disabled')!=='true'`
      )
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="event-rsvp-${owner}"]').scrollIntoView({block:'center'})`
      })
      const dragPoints = await web.evaluate<Array<{ x: number; y: number }>>(
        `[1,0].map(i=>{const r=document.querySelector('[data-testid="event-rsvp-${owner}-'+i+'"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})`
      )
      await m.evalBrowserScript({
        script: `window.__colors=[];window.__sampling=true;function sample(){window.__colors.push(getComputedStyle(document.querySelector('[data-testid="event-rsvp-${owner}-fill"]')).backgroundColor);if(window.__sampling)requestAnimationFrame(sample)}sample()`
      })
      await m.dragAndDrop({
        from: { point: at(dragPoints[0].x, dragPoints[0].y) },
        to: { point: at(dragPoints[1].x, dragPoints[1].y) },
        holdDuration: 100,
        duration: 1000
      })
      await m.waitForAnimationToEnd()
      await m.evalBrowserScript({ script: 'window.__sampling=false' })
      await wait(
        `document.querySelector('[data-testid="event-rsvp-${owner}-0"]').getAttribute('aria-checked')==='true'`
      )
      expect(
        new Set(await web.evaluate<string[]>('window.__colors')).size,
        'Drag passes through intermediate blue/green colors'
      ).to.be.greaterThan(2)
      await tap({ id: `event-rsvp-${owner}-1` })
      await m.assertVisible({
        css: `[data-testid="event-rsvp-${owner}-1"]:not([aria-disabled="true"])`,
        timeout: 5000
      })
      await m.pressKey({ key: 'RIGHT' })
      await wait(
        `document.querySelector('[data-testid="event-rsvp-${owner}-2"]').getAttribute('aria-checked')==='true'`
      )
      await tap({ id: `event-rsvp-${owner}-1` })
      await m.tapOn({ text: 'Done' })
      // An RSVP asks about notifications once per person per device.
      await dismissNotificationAsk(m)
      await wait(
        `document.querySelector('[data-testid="event-rsvp-modal"]')==null && document.querySelector('[data-testid="event-reply-status-${owner}"]')?.textContent==='Maybe'`
      )
      const persisted = asEventInfo(
        (await api(ctx, w.accounts.owner, 'GET', `/events/${w.ids.game}/info`))
          .body
      )
      // RSVP is for the team's own: the owner's child outside it is neither
      // answered for nor listed. The owner comes first, then the children.
      expect(persisted.replyUserIds[0]).to.equal(owner)
      expect([...persisted.replyUserIds.slice(1)].sort()).to.deep.equal(
        [id('trout'), id('ichiro')].sort()
      )
      expect(persisted.replyUserIds.length).to.equal(3)
      expect(
        persisted.attendees.find(row => row.userId === owner)?.name,
        'The reader reads their own name in full'
      ).to.equal('Babe Ruth')
      expect(
        persisted.attendees.find(row => row.userId === id('rodriguez'))
      ).to.equal(undefined)
      for (const role of ['rival', 'griffey', 'jackson'])
        expect(
          persisted.attendees.some(row => row.userId === id(role))
        ).to.equal(false)
      const groups = await web.evaluate<
        Array<{ id: string; text: string; count: string; right: boolean }>
      >(
        `Array.from(document.querySelectorAll('[data-testid^="attendance-"]')).filter(node=>/^attendance-(staff|players|others)-(yes|maybe|no|noReply)$/.test(node.dataset.testid)).map(node=>{const heading=node.querySelector('[role="heading"]'), texts=heading.querySelectorAll('[dir="auto"]'), count=heading.querySelector('[data-testid="settings-pill-count"]')??texts[texts.length-1];return{id:node.dataset.testid,text:node.textContent,count:count.textContent,right:Math.abs(count.getBoundingClientRect().right-heading.getBoundingClientRect().right)<1}})`
      )
      expect(groups.length).to.equal(9)
      expect(
        groups.every(group => group.right),
        'Every count pill is right-justified'
      ).to.equal(true)
      expect(groups.map(group => Number(group.count))).to.deep.equal([
        2, 2, 1, 1, 1, 1, 2, 1, 1
      ])
      const section = (name: string): string =>
        groups.find(group => group.id === name)?.text ?? ''
      expect(section('attendance-staff-yes')).to.include('Coach')
      expect(section('attendance-players-yes')).to.include(
        'B:S • T:R • SS • CF'
      )
      expect(section('attendance-others-maybe')).to.include(
        'Guardian of Mike T'
      )
      expect(section('attendance-others-no')).to.include('Spectator')
      expect(
        groups.some(
          group =>
            /Alex R|Mookie B/.test(group.text) &&
            group.id.startsWith('attendance-others')
        )
      ).to.equal(false)
      for (const [section, file] of [
        ['attendance-staff-yes', 'groups-after.png'],
        ['attendance-players-noReply', 'groups-middle-after.png'],
        ['attendance-others-noReply', 'groups-bottom-after.png']
      ]) {
        await see({ id: section })
        await shot(file)
      }
      await page.done()
    },

    // The map below the family's controls pans by dragging, failed tiles
    // recover through the frame's retry, and the address copies.
    'map-tiles-copy': async ctx => {
      const page = await info(ctx)
      const { w, m, web, see, open, shot } = page
      await open(`/games/${w.ids.game}`)
      await see({ id: 'event-location-map' }, 'UP')
      await waitInMapFrame(web.page, 'window.eventMap!=null')
      await shot('location-after.png')
      const map = await web.evaluate<{
        x: number
        y: number
        width: number
        height: number
      }>(
        `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`
      )
      const center = await inMapFrame<{ lat: number; lng: number }>(
        web.page,
        'window.eventMap.getCenter()'
      )
      await m.dragAndDrop({
        from: { point: at(map.x + map.width * 0.8, map.y + 130) },
        to: { point: at(map.x + map.width * 0.2, map.y + 130) },
        holdDuration: 100,
        duration: 500
      })
      const changed = await inMapFrame<{ lat: number; lng: number }>(
        web.page,
        'window.eventMap.getCenter()'
      )
      expect(
        Math.abs(center.lng - changed.lng),
        'Leaflet map pans by dragging'
      ).to.be.greaterThan(0.001)
      await m.mockNetwork({
        url: `*${await mapTileHost(web.page)}*`,
        response: { status: 503, body: 'Synthetic tile outage' }
      })
      await open(`/games/${w.ids.game}`)
      await see({ id: 'event-location-map' })
      await waitInMapFrame(
        web.page,
        `document.querySelector('#error').style.display==='block'`
      )
      await shot('map-tiles-retry.png')
      await m.clearNetworkMocks()
      const retry = await pointInMapFrame(web.page, '#retry-map-tiles')
      await m.tapOnPoint({ x: Math.round(retry.x), y: Math.round(retry.y) })
      await waitInMapFrame(
        web.page,
        `document.querySelector('#error').style.display==='none'`
      )
      await see({ id: 'event-address' })
      // Clear of the floating tab bar, wherever the cards above leave it.
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="event-address"]').scrollIntoView({block:'center'})`
      })
      await m.longPressOn({ id: 'event-address' })
      await m.assertVisible({ text: 'Address copied', timeout: 10000 })
      await page.done()
    },

    // A failed write isolates its rollback, and refreshed replies persist.
    'rsvp-rollback': async ctx => {
      const w = await ctx.fixture('event-info-people')
      await replied(ctx, w, { owner: 'maybe', trout: 'no', ichiro: 'yes' })
      const page = await info(ctx, { world: w })
      const { m, web, id, tap, open, shot } = page
      await open(`/games/${w.ids.game}`)
      const fail = `fail_event_rsvp_${w.nonce}`
      await sql(
        ctx,
        `create function ${fail}() returns trigger language plpgsql as $$begin if new.user_id='${id('trout')}' then raise exception 'Synthetic RSVP write failure'; end if; return new; end$$`
      )
      await sql(
        ctx,
        `create trigger ${fail} before insert or update on game_rsvps for each row execute function ${fail}()`
      )
      try {
        await tap({ id: 'event-replies-open' }, 'UP')
        await m.assertVisible({ id: 'event-rsvp-modal', timeout: 20000 })
        await tap({ id: `event-rsvp-${id('trout')}-0` })
        await m.assertVisible({ text: 'Something went wrong', timeout: 10000 })
        expect(
          await web.evaluate(
            `document.querySelector('[data-testid="event-rsvp-${id('trout')}-2"]').getAttribute('aria-checked')`
          )
        ).to.equal('true')
        expect(
          await web.evaluate(
            `document.querySelector('[data-testid="event-rsvp-${id('ichiro')}-0"]').getAttribute('aria-checked')`
          )
        ).to.equal('true')
        await shot('rsvp-rollback.png')
      } finally {
        await sql(ctx, `drop trigger ${fail} on game_rsvps`)
        await sql(ctx, `drop function ${fail}()`)
      }
      await open(`/games/${w.ids.game}`)
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="event-reply-status-${id('owner')}"]').textContent`
        )
      ).to.equal('Maybe')
      await page.done()
    },

    // A guardian on neither team answers for the child alone; once on the
    // Eagles too, the team chooser shows each team's people and the child
    // keeps a private control. A visitor on no team sees no replies at all.
    'team-chooser-privacy': async ctx => {
      const w = await ctx.fixture('event-info-people')
      const page = await info(ctx, { world: w, as: 'alvarez' })
      const { web, id, tap, open, wait, shot } = page
      await open(`/games/${w.ids.game}`, `event-reply-row-${id('trout')}`)
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="event-attendance-teams"]')==null`
        )
      ).to.equal(true)
      await sql(
        ctx,
        `insert into memberships (id, user_id, team_id, is_player) values ($1, $2, $3, false)`,
        [`mem_alvarez_${w.nonce}`, id('alvarez'), w.ids.teamB]
      )
      await open(`/games/${w.ids.game}`, `event-reply-row-${id('alvarez')}`)
      await tap(
        {
          css: `[aria-label="RSVP teams"] [aria-label=${JSON.stringify(w.ids.teamBName)}]`
        },
        'UP'
      )
      await shot('dual-team-rsvps.png')
      await wait(
        `document.querySelector('[data-testid="attendance-others-noReply"]').textContent.includes('Lou G')`
      )
      expect(
        await web.evaluate(
          `(document.querySelector('[data-testid="attendance-players-yes"]')?.textContent ?? '').includes('Mookie B')`
        )
      ).to.equal(false)
      expect(
        await web.evaluate<boolean>(
          `document.querySelector('[data-testid="event-reply-row-${id('trout')}"]')!=null`
        ),
        'An out-of-selected-team child keeps a private control'
      ).to.equal(true)
      await page.signInAs('ryan')
      await open(`/games/${w.ids.game}`, 'event-location-map')
      expect(
        await web.evaluate(
          `document.querySelectorAll('[role="radiogroup"]').length`
        )
      ).to.equal(0)
      expect(
        await web.evaluate(
          `document.querySelectorAll('[data-testid^="attendance-"]').length`
        )
      ).to.equal(0)
      const visitor = asEventInfo(
        (await api(ctx, w.accounts.ryan, 'GET', `/events/${w.ids.game}/info`))
          .body
      )
      expect(visitor.canViewAttendance).to.equal(false)
      expect(visitor.attendees).to.deep.equal([])
      expect(
        (
          await api(
            ctx,
            w.accounts.ryan,
            'PUT',
            `/events/${w.ids.game}/rsvps/${id('ryan')}`,
            { response: 'yes' }
          )
        ).status
      ).to.equal(404)
      await page.done()
    },

    // The hero reads in the viewer's own zone, across midnight, and again in
    // a second zone.
    'viewer-local-time': async ctx => {
      const w = await ctx.fixture('event-info-people')
      const overnight = `gam_viewer_midnight_${w.nonce}`
      await insertGame(ctx, w, overnight, '2027-04-11T06:30:00Z', null)
      for (const zone of [ZONE, 'Asia/Tokyo']) {
        const page = await info(ctx, { world: w, zone })
        await page.open(`/games/${overnight}`)
        await page.see({ id: 'event-hero' }, 'UP')
        expect(
          await page.web.evaluate<string>(
            `document.querySelector('[data-testid="event-hero"]').textContent`
          )
        ).to.include(
          eventHeroLines('2027-04-11T06:30:00Z', null, undefined, zone).join('')
        )
        if (zone === ZONE) await page.shot('local-time-after.png')
        await page.done()
      }
    },

    // Create Game's Event Type, arrival defaults, a titled event with a leap
    // date, a time zone, an inferred end and notes; a lost response locks
    // the type and its retry makes no duplicate; then its settings, edit
    // and cancel, its arrival, a venue-only map whose directions match it,
    // and no location at all.
    'titled-event-lifecycle': async ctx => {
      const page = await info(ctx)
      const {
        w,
        m,
        web,
        id,
        tap,
        see,
        wait,
        open,
        shot,
        fill,
        chooseDate,
        chooseTime,
        chooseZone,
        settleTimezoneScene
      } = page
      await web.go(`/groups/team/${w.ids.teamA}/create-game`)
      await m.assertVisible({ text: 'Create Game', timeout: 20000 })
      const arrival = async (): Promise<string> =>
        await web.evaluate<string>(
          `document.querySelector('[aria-label="Arrival minutes (optional)"]').value`
        )
      expect(await arrival()).to.equal('45')
      await shot('game-create-after.png')
      const dragType = async (from: number, to: number): Promise<void> => {
        await see({ id: 'event-type' }, 'UP')
        const points = await web.evaluate<Array<{ x: number; y: number }>>(
          `[${from},${to}].map(i=>{const r=document.querySelector('[data-testid="event-type-'+i+'"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})`
        )
        await m.dragAndDrop({
          from: { point: at(points[0].x, points[0].y) },
          to: { point: at(points[1].x, points[1].y) },
          holdDuration: 100,
          duration: 600
        })
        await wait(
          `document.querySelector('[data-testid="event-type-${to}"]').getAttribute('aria-checked')==='true'`
        )
      }
      await dragType(0, 1)
      await dragType(1, 2)
      await dragType(2, 0)
      await tap({ id: 'event-type-1' }, 'UP')
      expect(await arrival()).to.equal('0')
      // A practice is called Practice; only other events take a title.
      expect(
        await web.evaluate(
          `document.querySelector('[aria-label="Title"]')==null`
        )
      ).to.equal(true)
      await shot('practice-create.png')
      await see({ css: '[aria-label="Arrival minutes (optional)"]' })
      await shot('practice-arrival-default.png')
      await fill('Arrival minutes (optional)', '10')
      await tap({ id: 'event-type-2' }, 'UP')
      expect(await arrival()).to.equal('10')
      await m.assertVisible({ text: 'Create Event' })
      await shot('event-create-after.png')
      await fill('Title', 'Team dinner')
      await chooseDate('date', '2032-02-29')
      await chooseTime('time', '23:30')
      await tap({ id: 'event-schedule-timezone' })
      await settleTimezoneScene()
      await fill('Find time zone', 'America/')
      expect(
        await web.evaluate(
          `document.querySelector('input[aria-label="Title"]').value`
        )
      ).to.equal('Team dinner')
      await tap({ text: 'Cancel time zone picker' })
      await chooseZone(ZONE)
      await tap({ text: 'Set end time' })
      await tap({ text: 'Set end date' })
      expect(
        await web.evaluate<string>(
          `document.querySelector('[data-testid="event-schedule-endDate"]').textContent`
        )
      ).to.include('2032-03-01')
      await shot('end-rollover.png')
      // The venue suggestions are 'venue-suggestions' (blocked); here the
      // place is typed.
      await fill('Venue name (optional)', 'Demo Park')
      await fill('Notes (optional)', 'Field 2\nMeet by the gate')
      await fill('Arrival minutes (optional)', '45')
      await fill('Venue address (optional)', '1 Demo Way, Demo City')
      await m.evalBrowserScript({ script: 'window.holdEventCreation=true' })
      await tap({ text: 'Create event' })
      await wait(`typeof window.releaseEventCreation==='function'`)
      await see({ id: 'event-type' }, 'UP')
      expect(
        await web.evaluate(
          `document.querySelectorAll('[data-testid^="event-type-"][aria-disabled="true"]').length`
        )
      ).to.equal(3)
      expect(
        await web.evaluate(
          `document.querySelector('[aria-label="Title"]').readOnly`
        )
      ).to.equal(true)
      const blocked = await web.evaluate<{ x: number; y: number }>(
        `(()=>{const rect=document.querySelector('[data-testid="event-type-0"]').getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`
      )
      await m.tapOnPoint({ x: Math.round(blocked.x), y: Math.round(blocked.y) })
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="event-type-2"]').getAttribute('aria-checked')`
        )
      ).to.equal('true')
      await m.evalBrowserScript({ script: 'window.releaseEventCreation()' })
      await wait(
        `document.body.textContent.includes(${JSON.stringify(OFFLINE_CREATE)})`
      )
      await see({ text: `${OFFLINE_CREATE.replace(/[.']/g, '.')}.*` })
      const teamEvents = async (): Promise<Array<Record<string, any>>> =>
        await sql(
          ctx,
          'select * from team_events where team_id = $1 order by id',
          [w.ids.teamA]
        )
      const firstCreated = (await teamEvents()).map(row => row.id)
      expect(firstCreated.length).to.equal(1)
      await tap({ id: 'event-type-0' }, 'UP')
      await tap({ id: 'event-type-2' }, 'UP')
      await tap({ text: 'Create event' })
      await m.assertVisible({
        id: `event-reply-row-${id('owner')}`,
        timeout: 20000
      })
      expect(
        (await teamEvents()).map(row => row.id),
        'An identical retry after a type remount creates no duplicate'
      ).to.deep.equal(firstCreated)
      const [event] = await teamEvents()
      expect(event.title).to.equal('Team dinner')
      expect(new Date(event.start_at).toISOString()).to.equal(
        '2032-03-01T07:30:00.000Z'
      )
      expect(new Date(event.end_at).toISOString()).to.equal(
        '2032-03-01T10:30:00.000Z'
      )
      expect(event.notes).to.equal('Field 2\nMeet by the gate')
      expect(event.arrival_time_delta).to.equal(45)
      expect(event.event_type).to.equal('other')
      await see({ id: 'event-notes' })
      await shot('venue-notes.png')
      await see({ id: 'event-hero' }, 'UP')
      await shot('arrival-info.png')
      expect(
        (
          await web.evaluate<string>(
            `document.querySelector('[data-testid="event-hero"]').textContent`
          )
        ).toUpperCase()
      ).to.include('ARRIVAL')
      await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
      await m.assertVisible({ text: 'Event Settings' })
      await wait(
        `document.querySelector('[aria-label="Arrival minutes (optional)"]')!=null`
      )
      expect(await arrival()).to.equal('45')
      await see({ id: 'event-type' }, 'UP')
      const typeGeometry = await web.evaluate<{
        aligned: boolean
        wordsFit: boolean
        labelWordsFit: boolean
      }>(
        `(()=>{const control=document.querySelector('[data-testid="event-type"]'),row=control.parentElement.parentElement,label=document.querySelector('[data-testid="event-type-label"]').firstChild;const box=control.getBoundingClientRect(),parent=row.getBoundingClientRect();return{aligned:Math.abs(box.right-parent.right)<1,wordsFit:[...control.querySelectorAll('[role="radio"]')].every(choice=>{const range=document.createRange();range.selectNodeContents(choice.firstElementChild);return range.getClientRects().length===1}),labelWordsFit:[[0,5],[6,10]].every(([start,end])=>{const range=document.createRange();range.setStart(label,start);range.setEnd(label,end);return range.getClientRects().length===1})}})()`
      )
      expect(
        typeGeometry.aligned &&
          typeGeometry.wordsFit &&
          typeGeometry.labelWordsFit,
        'Event Type stays right-aligned with unbroken choice and row-label words'
      ).to.equal(true)
      await shot('event-settings-after.png')
      await fill('Title', 'Team picnic')
      await tap({ text: 'Remove end time' })
      await chooseTime('time', '00:15')
      await tap({ text: 'Set end time' })
      await tap({ text: 'Cancel event' })
      await tap({ text: 'Save event details' })
      await m.assertVisible({
        id: `event-reply-row-${id('owner')}`,
        timeout: 20000
      })
      await m.assertVisible({ text: 'Canceled', timeout: 20000 })
      const [edited] = (await teamEvents()).filter(row => row.id === event.id)
      expect(edited.title).to.equal('Team picnic')
      expect(edited.status).to.equal('cancelled')
      expect(edited.arrival_time_delta).to.equal(45)
      await see({ id: 'event-hero' }, 'UP')
      await shot('arrival-edited.png')
      const startAt = new Date(edited.start_at).toISOString()
      expect(
        await web.evaluate<string>(
          `document.querySelector('[data-testid="event-hero"]').textContent`
        )
      ).to.include(`Arrival ${eventArrivalTime(startAt, 45, ZONE)!}`)
      expect(
        new Date(edited.end_at).getTime() - new Date(edited.start_at).getTime()
      ).to.equal(10800000)
      expect(await page.selected()).to.equal('Info')
      expect(
        await web.evaluate(
          `document.querySelectorAll('[role="tab"][aria-label="Box score"]').length`
        )
      ).to.equal(0)
      await api(ctx, w.accounts.owner, 'PUT', `/events/${event.id}/info`, {
        address: null,
        venue: 'Demo Park'
      })
      await open(`/games/${event.id}`)
      await see({ id: 'event-location-map' })
      await shot('legacy-location-after.png')
      await waitInMapFrame(web.page, 'window.eventMap!=null')
      const venueCenter = await inMapFrame<{ lat: number; lng: number }>(
        web.page,
        'window.eventMap.getCenter()'
      )
      await m.evalBrowserScript({
        script: `window.open=(url,target,features)=>{window.lastEventDirections=url;window.lastEventDirectionsFeatures=features;return null}`
      })
      await tap({ id: 'event-address' })
      const directions = await web.evaluate<string>(
        `window.lastEventDirections`
      )
      expect(
        await web.evaluate<string>('window.lastEventDirectionsFeatures')
      ).to.equal('noopener,noreferrer')
      const [latitude, longitude] = new URL(directions).searchParams
        .get('destination')!
        .split(',')
        .map(Number)
      // Leaflet keeps its center on whole pixels once the frame is laid out:
      // the directions agree with it to within one of the map's pixels.
      const pixel = await inMapFrame<{ lat: number; lng: number }>(
        web.page,
        `(()=>{const a=window.eventMap.containerPointToLatLng([0,0]),b=window.eventMap.containerPointToLatLng([1,1]);return{lat:Math.abs(a.lat-b.lat),lng:Math.abs(a.lng-b.lng)}})()`
      )
      const agree = `directions ${latitude},${longitude}; map center ${venueCenter.lat},${venueCenter.lng}; a pixel ${pixel.lat},${pixel.lng}`
      expect(Math.abs(latitude - venueCenter.lat), agree).to.be.at.most(
        pixel.lat
      )
      expect(Math.abs(longitude - venueCenter.lng), agree).to.be.at.most(
        pixel.lng
      )
      expect(
        await web.evaluate<string>(
          `document.querySelector('[data-testid="event-address"]').textContent`
        )
      ).to.include('Demo Park')
      await api(ctx, w.accounts.owner, 'PUT', `/events/${event.id}/info`, {
        address: null,
        venue: null
      })
      await open(`/games/${event.id}`)
      await see({ text: 'Location not set' })
      expect(
        await web.evaluate(`document.querySelectorAll('iframe').length`)
      ).to.equal(0)
      await page.done()
    },

    // Typing a venue's name or address offers places; choosing one fills
    // the address, keeps a name typed by hand, and names an unnamed venue.
    // The stack's Places stand-in answers one fixed place whatever is
    // typed, which the old checks' Demo Park suggestions cannot come from.
    'venue-suggestions': async () => {
      throw new BlockedError(
        "needs a stack whose place lookups can be scripted: the Places stand-in (e2e/fixtures/placesAnswers.json) answers one fixed place, not the 'Demo Park' venue and address these choices are checked against"
      )
    },

    // An address that cannot be located shows Retry map, which recovers
    // once the lookup works again.
    'geocode-failure-retry': async () => {
      throw new BlockedError(
        "needs a stack whose geocoder can be told to find no place for one address: the Places stand-in answers every lookup with the same place, so 'The address could not be located' never shows"
      )
    },

    // A start-only edit keeps the explicit end and refuses an invalid one
    // with no proposal; a real change is proposed, shown to the approving
    // administrator with its previous values, and published on acceptance.
    // A new game is proposed the same way.
    'game-change-proposals': async ctx => {
      const w = await ctx.fixture('event-info-people')
      await replied(ctx, w, { owner: 'maybe' })
      const page = await info(ctx, { world: w })
      const {
        m,
        web,
        id,
        tap,
        wait,
        open,
        shot,
        fill,
        chooseDate,
        chooseTime,
        chooseZone
      } = page
      const game = w.ids.game
      await open(`/games/${game}`)
      await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
      await m.assertVisible({ text: 'Game Settings', timeout: 20000 })
      await wait(
        `document.querySelector('[aria-label="Arrival minutes (optional)"]')!=null`
      )
      expect(
        await web.evaluate(
          `document.querySelector('[aria-label="Arrival minutes (optional)"]').value`
        )
      ).to.equal('')
      await fill('Arrival minutes (optional)', '45')
      await fill('Notes (optional)', 'Field 3\nMeet by the dugout')
      await chooseTime('time', '16:00')
      await m.assertVisible({ text: 'End time must be after start time' })
      expect(
        await web.evaluate<string>(
          `document.querySelector('[data-testid="event-schedule-endTime"]').textContent`
        )
      ).to.include('2:00 PM')
      await tap({ text: 'Save' })
      const requests = async (): Promise<Array<Record<string, any>>> =>
        await sql(
          ctx,
          `select * from group_requests where game_id = $1 and kind in ('game', 'gameChange')`,
          [game]
        )
      expect((await requests()).length).to.equal(0)
      await tap({ text: 'Remove end time' })
      await chooseZone('UTC')
      await chooseDate('date', '2032-03-04')
      await chooseTime('time', '23:30')
      await tap({ text: 'Set end time' })
      await tap({ text: 'Set end date' })
      await fill('Venue address (optional)', '2 Demo Way, Demo City')
      await fill('Venue name (optional)', 'Demo New Park')
      await page.see({ id: 'event-schedule-date' }, 'UP')
      await shot('game-settings-after.png')
      await tap({ text: 'Save' })
      await m.assertVisible({
        id: `event-reply-row-${id('owner')}`,
        timeout: 20000
      })
      const [request] = await requests()
      const terms = request.terms as GameRequestTerms
      expect(terms.game.startAt).to.equal('2032-03-04T23:30:00.000Z')
      expect(terms.game.endAt).to.equal('2032-03-05T02:30:00.000Z')
      expect(terms.game.arrivalTimeDelta).to.equal(45)
      expect(terms.game.notes).to.equal('Field 3\nMeet by the dugout')
      expect(terms.game.address).to.equal('2 Demo Way, Demo City')
      expect(terms.game.venue).to.equal('Demo New Park')
      expect(terms.game.timezone).to.equal('UTC')
      await page.signInAs('rival')
      await web.go(`/notifications/${request.id}`)
      await wait(
        `document.body.textContent.includes('Proposed notes: Field 3')`
      )
      expect(
        await web.evaluate<boolean>(
          `document.body.textContent.includes('Previous notes: Not set.')&&document.body.textContent.includes('Proposed arrival: 45 minutes before start.')&&document.body.textContent.includes('Previous arrival: Not set.')`
        )
      ).to.equal(true)
      expect(
        await web.evaluate<boolean>(
          `document.body.textContent.includes('Proposed address: 2 Demo Way, Demo City.')&&document.body.textContent.includes('Previous address:')&&document.body.textContent.includes('Proposed end: Mar 5, 2032, 2:30 AM (UTC).')&&document.body.textContent.includes('Previous end:')`
        )
      ).to.equal(true)
      await m.evalBrowserScript({
        script: `const node=[...document.querySelectorAll('[dir="auto"]')].find(node=>node.firstChild?.nodeType===Node.TEXT_NODE&&node.textContent.includes('Proposed notes:'));const range=document.createRange();range.setStart(node.firstChild,node.textContent.indexOf('Proposed notes:'));range.setEnd(node.firstChild,node.textContent.length);for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight&&['auto','scroll'].includes(getComputedStyle(parent).overflowY))parent.scrollTop+=range.getBoundingClientRect().top-window.innerHeight/3`
      })
      await shot('approval-event-details.png')
      await tap({ text: 'Accept invitation' })
      await wait(`document.body.textContent.includes('Accepted')`)
      await page.signInAs('owner')
      const [published] = await sql(ctx, 'select * from games where id = $1', [
        game
      ])
      expect(new Date(published.start_at).toISOString()).to.equal(
        terms.game.startAt
      )
      expect(new Date(published.end_at).toISOString()).to.equal(
        terms.game.endAt
      )
      expect(published.latitude).to.equal(null)
      await open(`/games/${game}`)
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="event-reply-status-${id('owner')}"]').textContent`
        )
      ).to.equal('Maybe')
      await web.go(`/groups/team/${w.ids.teamA}/create-game`)
      await m.assertVisible({ text: 'Create Game', timeout: 20000 })
      // The opponent is chosen in the team selector that slides up.
      await tap({ text: 'Choose Away Team, Away' })
      await m.assertVisible({
        css: `[data-testid="team-result-${w.ids.teamB}"]`,
        timeout: 20000
      })
      await m.waitForAnimationToEnd()
      await tap({ css: `[data-testid="team-result-${w.ids.teamB}"]` })
      await wait(
        `document.querySelector('[data-testid="team-selector"]')==null`
      )
      await chooseZone('UTC')
      await chooseDate('date', '2032-03-06')
      await chooseTime('time', '18:05')
      await tap({ text: 'Save' })
      await wait(`window.location.pathname.startsWith('/notifications/')`)
      const [newRequest] = await sql(
        ctx,
        `select * from group_requests where kind = 'game' and game_id is null and initiating_team_id = $1`,
        [w.ids.teamA]
      )
      const newTerms = newRequest.terms as GameRequestTerms
      expect(newTerms.game.startAt).to.equal('2032-03-06T18:05:00.000Z')
      expect(newTerms.game.endAt).to.equal(null)
      expect(newTerms.game.awayTeamId).to.equal(w.ids.teamB)
      expect(
        (
          await api(
            ctx,
            w.accounts.rival,
            'POST',
            `/game-requests/${newRequest.id}/accept`
          )
        ).status
      ).to.equal(200)
      await page.done()
    },

    // The first play moves the page to Box score; explicit Info, Videos and
    // Box score addresses and browser Back; a three-hour default end passing
    // while the page is open moves it too and lists Info last.
    'tab-defaults': async ctx => {
      const page = await info(ctx)
      const { w, m, web, tap, open } = page
      const game = w.ids.game
      await open(`/games/${game}`)
      const scoring = await api(
        ctx,
        w.accounts.owner,
        'POST',
        `/games/${game}/events`,
        FIRST_PLAY
      )
      expect(scoring.status, JSON.stringify(scoring.body)).to.equal(200)
      await web.go(`/games/${game}`)
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 15000 })
      await open(`/games/${game}?tab=info`)
      expect(await page.selected()).to.equal('Info')
      await web.go(`/games/${game}?tab=watch`)
      // A visible copy: a hidden page can hold one too.
      const noVideos = `[...document.querySelectorAll('*')].filter(n => n.childElementCount === 0 && n.textContent.trim() === 'No videos').map(n => { const r = n.getBoundingClientRect(); let hidden = ''; for (let e = n; e != null; e = e.parentElement) { const c = getComputedStyle(e); if (c.visibility === 'hidden' || c.display === 'none' || c.opacity === '0') hidden = hidden || e.tagName + ' ' + c.visibility + '/' + c.display + '/' + c.opacity } return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), hidden, shown: r.width > 0 && r.x >= 0 && r.x < innerWidth && hidden === '' } })`
      const until = Date.now() + 15000
      let copies: Array<{ shown: boolean }> = []
      while (Date.now() < until) {
        copies = await web.evaluate<Array<{ shown: boolean }>>(noVideos)
        if (copies.some(copy => copy.shown)) break
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      expect(
        copies.some(copy => copy.shown),
        `No videos shown: ${JSON.stringify(copies)}`
      ).to.equal(true)
      await web.go(`/games/${game}?tab=boxScore`)
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 15000 })
      await web.go(`/games/${game}`)
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 15000 })
      await tap(
        {
          css: '[role="tab"][aria-label="Videos"]:not([data-testid="navigation-sidebar"] *)'
        },
        'UP'
      )
      await m.assertVisible({ text: 'No videos' })
      await m.back()
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 15000 })
      // The default end falls 25 s out: the page must mount on Info first.
      const ending = `gam_default_three_hour_end_${w.nonce}`
      await insertGame(
        ctx,
        w,
        ending,
        new Date(Date.now() - 10800000 + 25000).toISOString(),
        null
      )
      await open(`/games/${ending}`)
      expect(await page.selected()).to.equal('Info')
      await m.assertVisible({ css: BOX_SCORE_SELECTED, timeout: 40000 })
      expect(
        await web.evaluate(
          `Array.from(document.querySelectorAll('[aria-label="Game sections"] [role="tab"]')).at(-1)?.textContent`
        )
      ).to.equal('Info')
      await page.done()
    },

    // Reconfirming an inferred end on daylight saving's repeated hour keeps
    // three elapsed hours; off-grid times round within the occurrence; a
    // save finishing after header Back leaves the returned page; a start
    // near midnight rounds forward.
    'repeated-hour': async ctx => {
      const page = await info(ctx)
      const {
        w,
        m,
        web,
        id,
        tap,
        wait,
        open,
        shot,
        fill,
        chooseDate,
        chooseTime,
        chooseZone
      } = page
      const replyRow = `event-reply-row-${id('owner')}`
      await web.go(`/groups/team/${w.ids.teamA}/create-game`)
      await m.assertVisible({ text: 'Create Game', timeout: 20000 })
      await tap({ id: 'event-type-2' }, 'UP')
      await fill('Title', 'Demo DST event')
      await chooseZone(ZONE)
      await chooseDate('date', '2027-11-06')
      await chooseTime('time', '23:30')
      await tap({ text: 'Set end time' })
      await tap({ id: 'event-schedule-endTime' })
      await m.assertVisible({ text: 'Choose time' })
      await tap({ text: 'Use time' })
      await shot('dst-end-reconfirmation.png')
      await tap({ text: 'Create event' })
      await m.assertVisible({ id: replyRow, timeout: 20000 })
      interface EventRow {
        id: string
        start_at: string
        end_at: string | null
      }
      const [created] = (await sql(
        ctx,
        `select id, start_at, end_at from team_events where team_id = $1 and title = 'Demo DST event'`,
        [w.ids.teamA]
      )) as EventRow[]
      const iso = (value: string | null): string =>
        value == null ? '' : new Date(value).toISOString()
      expect(iso(created.start_at)).to.equal('2027-11-07T06:30:00.000Z')
      expect(iso(created.end_at)).to.equal('2027-11-07T09:30:00.000Z')
      expect(
        new Date(created.end_at!).getTime() -
          new Date(created.start_at).getTime()
      ).to.equal(10800000)
      // The toast says saved as the request leaves; the row follows it.
      const savedRow = async (
        stale: (row: EventRow) => boolean
      ): Promise<EventRow> => {
        const read = async (): Promise<EventRow> =>
          (
            (await sql(
              ctx,
              'select id, start_at, end_at from team_events where id = $1',
              [created.id]
            )) as EventRow[]
          )[0]
        let row = await read()
        for (
          const until = Date.now() + 10000;
          stale(row) && Date.now() < until;
          row = await read()
        )
          await new Promise(resolve => setTimeout(resolve, 250))
        return row
      }
      const setTimes = async (
        startAt: string,
        endAt: string | null
      ): Promise<void> => {
        await sql(
          ctx,
          'update team_events set start_at = $1, end_at = $2 where id = $3',
          [startAt, endAt, created.id]
        )
      }
      const editAndSave = async (field: string): Promise<void> => {
        await open(`/games/${created.id}`)
        await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
        await m.assertVisible({ text: 'Event Settings', timeout: 20000 })
        await tap({ id: field })
        await tap({ text: 'Use time' })
        await tap({ text: 'Save event details' })
        await m.assertVisible({ id: replyRow, timeout: 20000 })
      }
      await setTimes('2027-11-07T08:45:00Z', '2027-11-07T09:32:00Z')
      await editAndSave('event-schedule-endTime')
      const fold = await savedRow(
        row => iso(row.end_at) === '2027-11-07T09:32:00.000Z'
      )
      expect(iso(fold.end_at)).to.equal('2027-11-07T09:30:00.000Z')
      expect(
        new Date(fold.end_at!).getTime() - new Date(fold.start_at).getTime()
      ).to.equal(45 * 60000)
      await setTimes('2027-11-07T09:32:00Z', '2027-11-07T12:32:00Z')
      await editAndSave('event-schedule-time')
      const rounded = await savedRow(
        row => iso(row.start_at) === '2027-11-07T09:32:00.000Z'
      )
      expect(iso(rounded.start_at)).to.equal('2027-11-07T09:30:00.000Z')
      await web.go(`/games/${created.id}/settings`)
      await m.assertVisible({ text: 'Event Settings', timeout: 20000 })
      await m.evalBrowserScript({ script: 'window.holdEventSettings=true' })
      await tap({ text: 'Save event details' })
      await wait(`typeof window.releaseEventSettings==='function'`)
      await tap({ css: '[aria-label="Back"][role="button"]' }, 'UP')
      await m.assertVisible({ id: replyRow, timeout: 20000 })
      const afterBack = await web.evaluate<string>(
        'location.pathname+location.search'
      )
      await m.evalBrowserScript({ script: 'window.releaseEventSettings()' })
      await wait('window.eventSettingsReplyDelivered===true')
      await m.assertVisible({ id: replyRow, timeout: 20000 })
      expect(
        await web.evaluate<string>('location.pathname+location.search')
      ).to.equal(afterBack)
      await setTimes('2027-11-08T07:58:00Z', null)
      await open(`/games/${created.id}`)
      await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
      await m.assertVisible({ text: 'Event Settings', timeout: 20000 })
      await tap({ id: 'event-schedule-time' })
      await m.assertVisible({ text: '.*Next day.*' })
      await tap({ text: 'Use time' })
      await tap({ text: 'Save event details' })
      await m.assertVisible({ id: replyRow, timeout: 20000 })
      const midnight = await savedRow(
        row => iso(row.start_at) === '2027-11-08T07:58:00.000Z'
      )
      expect(iso(midnight.start_at)).to.equal('2027-11-08T08:00:00.000Z')
      await page.done()
    },

    // A guardian directly on the away team, of a home-team child who no
    // longer plays, replies for himself alone and reads the away team.
    'direct-affiliation': async ctx => {
      const w = await ctx.fixture('event-info-people')
      const id = (role: string): string => w.accounts[role].userId
      await sql(
        ctx,
        'update memberships set is_player = false where team_id = $1 and user_id = $2',
        [w.ids.teamA, id('trout')]
      )
      await sql(
        ctx,
        'insert into memberships (id, team_id, user_id, is_player) values ($1, $2, $3, false)',
        [`mem_griffey_${w.nonce}`, w.ids.teamB, id('griffey')]
      )
      await sql(
        ctx,
        `insert into user_links (id, user_id, related_user_id, kind, can_manage) values ($1, $2, $3, 'guardian', false)`,
        [`lnk_griffey_${w.nonce}`, id('griffey'), id('trout')]
      )
      const page = await info(ctx, { world: w, as: 'griffey' })
      const { web, open } = page
      await open(
        `/games/${w.ids.game}?tab=info`,
        `event-reply-row-${id('griffey')}`
      )
      const direct = asEventInfo(
        (
          await api(
            ctx,
            w.accounts.griffey,
            'GET',
            `/events/${w.ids.game}/info`
          )
        ).body
      )
      expect(direct.teamId).to.equal(w.ids.teamB)
      expect(
        await web.evaluate(
          `(document.querySelector('[data-testid="attendance-players-yes"]')?.textContent ?? '').includes('Mookie B')`
        )
      ).to.equal(false)
      // A guardian replies only for children who play on a participating
      // roster.
      expect(direct.replyUserIds).to.deep.equal([id('griffey')])
      expect(
        await web.evaluate<string>(
          `[...document.querySelectorAll('[data-testid^="event-reply-row-"]')].map(n=>n.getAttribute('data-testid')).join(',')`
        )
      ).to.equal(`event-reply-row-${id('griffey')}`)
      await page.done()
    },

    // The team schedule counts players' replies only, its compact RSVP
    // modal lists the guardian's playing children, and the general schedule
    // has no RSVP controls.
    'team-schedule-counts': async ctx => {
      const w = await ctx.fixture('event-info-people')
      const id = (role: string): string => w.accounts[role].userId
      // Trout no longer plays for the Hawks.
      await sql(
        ctx,
        'update memberships set is_player = false where team_id = $1 and user_id = $2',
        [w.ids.teamA, id('trout')]
      )
      const quick = `gam_event_info_quick_${w.nonce}`
      await insertGame(
        ctx,
        w,
        quick,
        new Date(Date.now() + 86400000).toISOString(),
        null
      )
      const page = await info(ctx, { world: w })
      const { m, web, tap, see, wait, shot } = page
      await web.go(`/teams/${w.ids.teamA}?tab=schedule`)
      await see({ id: `schedule-rsvps-${quick}` }, 'UP')
      await shot('team-schedule-player-counts.png')
      await tap({
        css: `[data-testid="schedule-rsvps-${quick}"] [role="button"]`
      })
      await m.assertVisible({ id: 'event-rsvp-modal', timeout: 20000 })
      await wait(
        `document.querySelector('[data-testid="quick-rsvp-row-${id('ichiro')}"]')!=null`
      )
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="quick-rsvp-row-${id('rodriguez')}"]')==null&&document.querySelector('[data-testid="quick-rsvp-row-${id('trout')}"]')==null`
        )
      ).to.equal(true)
      await m.waitForAnimationToEnd()
      await shot('team-schedule-rsvp-modal.png')
      await tap({ id: `event-rsvp-${id('ichiro')}-2` })
      await wait(
        `document.querySelector('[data-testid="event-rsvp-${id('ichiro')}-2"]').getAttribute('aria-disabled')!=='true'`
      )
      const games = (
        await api(ctx, w.accounts.owner, 'GET', `/teams/${w.ids.teamA}/games`)
      ).body as Array<{ id: string; playerRsvps: { no: number } }>
      const counted = games.find(row => row.id === quick)!.playerRsvps
      await tap({ text: 'Done' })
      await dismissNotificationAsk(m)
      await see({ id: `schedule-rsvps-${quick}` }, 'UP')
      expect(
        Number(
          await web.evaluate<string>(
            `document.querySelector('[data-testid="schedule-rsvps-${quick}"] [data-testid="player-rsvp-count-no"]').textContent`
          )
        )
      ).to.equal(counted.no)
      await web.go('/schedule')
      await m.assertVisible({ text: 'Upcoming', timeout: 20000 })
      expect(
        await web.evaluate(
          `document.querySelector('[data-testid="player-rsvp-counts"]')==null&&document.querySelector('[data-testid^="schedule-rsvps-"]')==null`
        )
      ).to.equal(true)
      await page.done()
    }
  }
})
