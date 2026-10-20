import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

import { sql } from 'kysely'
import puppeteer, { type Browser as CoverageBrowser } from 'puppeteer'

import { asEventInfo } from '../../common/eventInfo'
import { eventArrivalTime, eventHeroLines } from '../../common/eventTime'
import type { GameRequestTerms } from '../../common/gameApprovals'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { createSession } from '../../server/auth/sessions'
import { SESSION_COOKIE } from '../../server/auth/tokens'
import { seedEventInfo2People } from '../../test/eventInfo2Fixture'
import { groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'

interface Browser {
  openBrowser: (body: { url: string }) => Promise<unknown>
  setCookies: (body: {
    cookies: Array<{
      name: string
      value: string
      domain: string
      path: string
    }>
  }) => Promise<unknown>
  tapOn: (body: {
    id?: string
    text?: string
    css?: string
    point?: string
  }) => Promise<unknown>
  tapOnPoint: (body: { x: number; y: number }) => Promise<unknown>
  inputText: (body: { text: string; css?: string }) => Promise<unknown>
  eraseText: () => Promise<unknown>
  assertVisible: (body: {
    text?: string
    id?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  evalBrowserScript: (body: { script: string }) => Promise<{ data?: unknown }>
  eval: (script: string) => Promise<unknown>
  screenshot: () => Promise<Buffer>
  dragAndDrop: (body: {
    from: { id?: string; point?: string }
    to: { id?: string; point?: string }
    holdDuration?: number
    duration: number
  }) => Promise<unknown>
  swipe: (body: {
    start: string
    end: string
    duration: number
  }) => Promise<unknown>
  waitForAnimationToEnd: () => Promise<unknown>
  back: () => Promise<unknown>
  pressKey: (body: { key: string }) => Promise<unknown>
  scrollUntilVisible: (body: {
    element: { text?: string; id?: string; css?: string }
    direction: string
    centerElement?: boolean
    maxScrolls?: number
  }) => Promise<unknown>
  longPressOn: (body: { id: string }) => Promise<unknown>
}

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

async function main(): Promise<void> {
  const artifacts = resolve(required('EVENT_INFO_ARTIFACTS'))
  const networkLog = join(
    artifacts,
    (process.env.EVENT_INFO_PREFIX ?? '') + 'browser-api.log'
  )
  writeFileSync(
    networkLog,
    '$ Actual synthetic browser HTTP request/response pairs\n'
  )
  const load = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )
  const { MaestroD } = load('maestro-d')
  execFileSync(required('MAESTRO_D_BIN'), ['ps'], { stdio: 'inherit' })
  let failTiles = false
  let failGeocode = true
  const external = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/tiles/')) {
      if (failTiles) {
        res.writeHead(503)
        res.end('Synthetic tile outage')
        return
      }
      res.writeHead(200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'no-store'
      })
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7eedf"/><path d="M0 70H256 M0 180H256 M70 0V256 M180 0V256" stroke="#ffffff" stroke-width="18"/><path d="M0 70H256 M0 180H256 M70 0V256 M180 0V256" stroke="#b9c9a8" stroke-width="2"/><rect x="90" y="90" width="70" height="70" rx="12" fill="#b4d5a3"/></svg>'
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        features:
          failGeocode &&
          url.searchParams.get('q')?.startsWith('Unavailable address') === true
            ? []
            : [
                {
                  geometry: { coordinates: [12, 34] },
                  properties: {
                    osm_type: 'N',
                    osm_id: 1,
                    osm_key: 'leisure',
                    name: 'Demo Park',
                    street: 'Demo Way',
                    housenumber: '1',
                    city: 'Demo City'
                  }
                }
              ]
      })
    )
  })
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve))
  const address = external.address()
  assert(address != null && typeof address !== 'string')
  const provider = `http://127.0.0.1:${address.port}`
  const oldProvider = process.env.TS_EVENT_GEOCODER_URL
  const oldTiles = process.env.TS_EVENT_MAP_TILES
  process.env.TS_EVENT_GEOCODER_URL = provider + '/api'
  process.env.TS_EVENT_MAP_TILES = provider + '/tiles/{z}/{x}/{y}.png'
  const f = await groupFixture(resolve('dist'), '127.0.0.1', app => {
    // Install transport fault injection before the app captures its fetch client.
    app.get('/groups/team/:id/create-game', (_req, res) => {
      const script = `(()=>{const fetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await fetch(...args);if(window.holdEventCreation&&String(args[0]).endsWith('/api/v1/events')&&args[1]?.method==='POST'){window.holdEventCreation=false;await new Promise(resolve=>{window.releaseEventCreation=resolve});throw new Error('Synthetic lost event response')}return response}})()`
      res
        .type('html')
        .send(
          readFileSync('dist/index.html', 'utf8').replace(
            '<head>',
            `<head><script>${script}</script>`
          )
        )
    })
    app.get('/games/:id/settings', (_req, res) => {
      const script = `(()=>{const fetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await fetch(...args);if(window.holdEventSettings&&String(args[0]).endsWith('/info')&&args[1]?.method==='PUT'){window.holdEventSettings=false;await new Promise(resolve=>{window.releaseEventSettings=resolve});window.eventSettingsReplyDelivered=true}return response}})()`
      res
        .type('html')
        .send(
          readFileSync('dist/index.html', 'utf8').replace(
            '<head>',
            `<head><script>${script}</script>`
          )
        )
    })
  })
  const daemonName = process.env.MAESTRO_D ?? 'event-info-browser'
  const profile = join(artifacts, 'support', daemonName + '-chromium-profile')
  mkdirSync(profile, { recursive: true })
  let coverageBrowser: CoverageBrowser | undefined
  const daemon = await MaestroD.connect({
    name: daemonName,
    bin: required('MAESTRO_D_BIN')
  })
  try {
    const gameId = 'gam_event_info'
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: null,
        start_at: new Date('2027-04-10T19:00:00Z'),
        end_at: new Date('2027-04-10T21:00:00Z'),
        venue: 'Demo Field',
        address: '1 Demo Way, Demo City',
        latitude: 34,
        longitude: 12
      })
      .execute()
    for (const userId of [103, 104]) {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          team_id: f.teamA,
          user_id: userIdOfGumbo(userId),
          is_player: true
        })
        .execute()
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(101),
          related_user_id: userIdOfGumbo(userId),
          kind: 'guardian',
          can_manage: false
        })
        .execute()
    }
    await seedEventInfo2People(f, gameId)
    const browserDevice =
      process.env.EVENT_INFO_BROWSER_DEVICE ?? 'event-info-chromium'
    const m: Browser = await daemon.attach({
      device: browserDevice,
      platform: 'web',
      commandTimeout: 30000,
      url: f.h.origin,
      extra: {
        browser: 'chromium',
        windowSize: process.env.EVENT_INFO_VIEWPORT ?? '1280x800',
        userDataDir: profile
      }
    })
    await m.openBrowser({ url: f.h.origin })
    const [debugPort, socketPath] = readFileSync(
      join(profile, 'DevToolsActivePort'),
      'utf8'
    )
      .trim()
      .split('\n')
    // This connection collects coverage only; every UI action uses Maestro D.
    coverageBrowser = await puppeteer.connect({
      defaultViewport: null,
      browserWSEndpoint: `ws://127.0.0.1:${debugPort}${socketPath}`
    })
    const coveragePage = (await coverageBrowser.pages()).find(page =>
      page.url().startsWith(f.h.origin)
    )!
    assert(coveragePage != null)
    await coveragePage.emulateTimezone('America/Los_Angeles')
    const appErrors: string[] = []
    const network: Array<Promise<void>> = []
    coveragePage.on('response', response => {
      if (
        !/\/api\/v1\/(locations(?:\?|$)|events(?:\/|$)|game-requests(?:\/|$)|me\/notifications(?:\/|$)|games\/[^/]+\/(?:scheduling|events))/.test(
          response.url()
        )
      )
        return
      const request = response.request()
      network.push(
        (async () => {
          const body = await response.text().catch(() => '<unavailable>')
          const posted = await request.fetchPostData().catch(() => undefined)
          const path = new URL(response.url())
          const log = `$ browser ${request.method()} ${path.pathname}${path.search}\n${posted ?? ''}\n${response.status()} ${body}\n`
          appendFileSync(networkLog, log)
        })()
      )
    })
    coveragePage.on('pageerror', error => {
      appErrors.push(String(error))
    })
    await coveragePage.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: false,
      includeRawScriptCoverage: true
    })
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
    const evaluate = async <T>(script: string): Promise<T> => {
      // Return values live in Maestro's session variable as well as the command envelope.
      const result = await m.evalBrowserScript({
        script: `return JSON.stringify(${script})`
      })
      assert(typeof result.data === 'string')
      return JSON.parse(result.data) as T
    }
    const see = async (
      selector: { id?: string; text?: string; css?: string },
      direction = 'DOWN'
    ): Promise<void> => {
      await m.scrollUntilVisible({
        element: selector,
        direction,
        centerElement: true,
        maxScrolls: 20
      })
    }
    const tap = async (
      selector: { id?: string; text?: string; css?: string },
      direction = 'DOWN'
    ): Promise<void> => {
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
      const point = await evaluate<{
        x: number
        y: number
        clear: boolean
      } | null>(
        `(()=>{const node=${target};if(!node)return null;const r=node.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return{x,y,clear:hit===node||node.contains(hit)}})()`
      )
      assert(
        point?.clear === true,
        `The ${JSON.stringify(selector)} control must be unobstructed`
      )
      await m.tapOnPoint({ x: point.x, y: point.y })
    }
    const open = async (
      route: string,
      target = 'event-reply-row-101'
    ): Promise<void> => {
      await m.openBrowser({ url: f.h.origin + route })
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
      // Capture the settled selected capsule, rather than its transition frame.
      await wait(
        `Array.from(document.querySelectorAll('[role="radiogroup"]')).every(group=>{const fill=group.querySelector('[data-testid$="-fill"]');if(!fill)return true;const choices=[...group.querySelectorAll('[role="radio"]')],index=choices.findIndex(node=>node.getAttribute('aria-checked')==='true');if(index<0)return true;const transform=getComputedStyle(fill).transform;const x=transform==='none'?0:new DOMMatrixReadOnly(transform).m41;return Math.abs(x-index*group.getBoundingClientRect().width/3)<0.5})`
      )
      writeFileSync(
        join(artifacts, (process.env.EVENT_INFO_PREFIX ?? '') + file),
        await m.screenshot()
      )
      console.log(`Captured ${file}`)
    }
    const wait = async (expression: string): Promise<void> => {
      await m.evalBrowserScript({
        script: `for(let i=0;i<150;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,20))}throw new Error('UI condition did not settle')`
      })
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
      value: string,
      capture = false
    ): Promise<void> => {
      await tap({ id: `event-schedule-${key}` })
      await fill('Year', value.slice(0, 4))
      await tap({ css: '[aria-label^="Choose month:"]' })
      await tap({
        text: [
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
        ][Number(value.slice(5, 7)) - 1]
      })
      await tap({ css: `[aria-label="Choose ${value}"]` })
      if (capture) await shot('date-picker.png')
      await tap({ text: 'Use date' })
    }
    const chooseTime = async (
      key: 'time' | 'endTime',
      value: string,
      capture = false
    ): Promise<void> => {
      await tap({ id: `event-schedule-${key}` })
      const [hour, minute] = value.split(':').map(Number)
      for (const [column, option] of [
        [
          'hour',
          hour % 12 === 0 ? 12 : hour % 12,
          hour % 12 > 6 ? 'DOWN' : 'UP'
        ],
        ['minute', minute, minute > 25 ? 'DOWN' : 'UP'],
        ['period', hour < 12 ? 0 : 1, hour < 12 ? 'UP' : 'DOWN']
      ] as const) {
        // Chromium's driver has no nested `from` gesture yet. Scroll the real
        // column through Maestro's browser command, then tap its visible option.
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
      if (capture) await shot('time-picker.png')
      await tap({ text: 'Use time' })
    }
    // The time zone picker slides up as a scene of its own: type into it
    // once it has come to rest, or the tap lands on a row sliding past.
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
    const chooseZone = async (zone: string, capture = false): Promise<void> => {
      await tap({ id: 'event-schedule-timezone' })
      await settleTimezoneScene()
      await fill('Find time zone', zone.replace(/_/g, ' '))
      if (capture) await shot('timezone-picker.png')
      await tap({
        css: `[aria-label=${JSON.stringify(`Use time zone ${zone}`)}]`
      })
    }
    const selected = async (): Promise<string> =>
      await evaluate(
        `document.querySelector('[aria-label="Game sections"] [role="tab"][aria-selected="true"]')?.textContent`
      )
    const shape = async (enlarged = false): Promise<void> => {
      const geometry = await evaluate<{
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
        const root=document.querySelector('[data-testid="event-rsvp-101"]'), fill=root.querySelector('[data-testid$="-fill"]');
        const card=document.querySelector('[data-testid="event-replies"]').getBoundingClientRect(), hero=document.querySelector('[data-testid="event-hero"]').getBoundingClientRect();
        let safe=true, wordLines=0;
        for(const choice of root.querySelectorAll('[role="radio"]')){
          const box=choice.getBoundingClientRect(), radius=parseFloat(getComputedStyle(fill).borderRadius), walker=document.createTreeWalker(choice,NodeFilter.SHOW_TEXT);
          let node;while(node=walker.nextNode()){for(let i=0;i<node.textContent.length;i++){if(!node.textContent[i].trim())continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();if(r.left<box.left+radius-0.5||r.right>box.right-radius+0.5)safe=false}if(node.textContent==='Maybe'){const r=document.createRange();r.selectNodeContents(node);wordLines=r.getClientRects().length}}
        }
        return {width:root.getBoundingClientRect().width,fillHeight:fill.getBoundingClientRect().height,radius:parseFloat(getComputedStyle(fill).borderRadius),wordLines,safe,rowX:card.x,heroX:hero.x,rowWidth:card.width,heroWidth:hero.width}
      })()`)
      console.log(
        `Capsule/card geometry ${enlarged ? 'enlarged' : 'normal'}: ${JSON.stringify(geometry)}`
      )
      assert(geometry.safe, 'Every label glyph stays out of the rounded arcs')
      assert(
        Math.abs(geometry.rowX - geometry.heroX) < 1 &&
          Math.abs(geometry.rowWidth - geometry.heroWidth) < 1,
        'Reply cards share hero margins'
      )
      if (!enlarged) {
        assert.equal(geometry.fillHeight, 32)
        assert.equal(geometry.wordLines, 1, 'Maybe fits in one straight line')
      }
    }
    await open(`/games/${gameId}`)
    assert.equal(await selected(), 'Info')
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-hero"]').textContent`
        )
      ).includes(
        eventHeroLines(
          '2027-04-10T19:00:00Z',
          '2027-04-10T21:00:00Z',
          undefined,
          'America/Los_Angeles'
        ).join('')
      )
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-info"]').textContent.includes('UTC')`
      ),
      false
    )
    // The Info card lists replies; a tap opens the schedule's RSVP modal,
    // whose capsules the replies below are made with.
    await tap({ id: 'event-replies-open' })
    await m.assertVisible({ id: 'event-rsvp-modal', timeout: 20000 })
    await tap({ id: 'event-rsvp-101-0' })
    await tap({ id: 'event-rsvp-101-1' })
    await tap({ id: 'event-rsvp-103-2' })
    await tap({ id: 'event-rsvp-104-0' })
    await wait(
      `document.querySelector('[data-testid="event-rsvp-101-1"]').getAttribute('aria-disabled')!=='true'`
    )
    await shape()
    await see({ id: 'quick-rsvp-row-101' }, 'UP')
    await shot('info-after.png')
    await m.evalBrowserScript({
      script: `window.__tracks=[];for(const track of document.querySelectorAll('[role="radiogroup"]')){window.__tracks.push([track,track.style.width]);track.style.width=(parseFloat(getComputedStyle(track).width)*2)+'px'}window.__fonts=[];for(const label of document.querySelectorAll('[role="radiogroup"] [role="radio"] > div')){window.__fonts.push([label,label.style.fontSize,label.style.lineHeight]);label.style.fontSize=(parseFloat(getComputedStyle(label).fontSize)*2)+'px';label.style.lineHeight=(parseFloat(getComputedStyle(label).lineHeight)*2)+'px'}`
    })
    await shape(true)
    await shot('pill-enlarged.png')
    await m.evalBrowserScript({
      script: `for(const [node,font,line] of window.__fonts){node.style.fontSize=font;node.style.lineHeight=line}delete window.__fonts;for(const [node,width]of window.__tracks)node.style.width=width;delete window.__tracks`
    })
    await see({ id: 'event-rsvp-101' }, 'UP')
    await wait(
      `document.querySelector('[data-testid="event-rsvp-101-1"]').getAttribute('aria-disabled')!=='true'`
    )
    await m.evalBrowserScript({
      script: `document.querySelector('[data-testid="event-rsvp-101"]').scrollIntoView({block:'center'})`
    })
    const dragPoints = await evaluate<Array<{ x: number; y: number }>>(
      `[1,0].map(i=>{const r=document.querySelector('[data-testid="event-rsvp-101-'+i+'"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})`
    )
    await m.evalBrowserScript({
      script: `window.__colors=[];window.__sampling=true;function sample(){window.__colors.push(getComputedStyle(document.querySelector('[data-testid="event-rsvp-101-fill"]')).backgroundColor);if(window.__sampling)requestAnimationFrame(sample)}sample()`
    })
    await m.dragAndDrop({
      from: {
        point: `${Math.round(dragPoints[0].x)},${Math.round(dragPoints[0].y)}`
      },
      to: {
        point: `${Math.round(dragPoints[1].x)},${Math.round(dragPoints[1].y)}`
      },
      holdDuration: 100,
      duration: 1000
    })
    await m.waitForAnimationToEnd()
    await m.evalBrowserScript({ script: 'window.__sampling=false' })
    console.log('Drag colors:', [
      ...new Set(await evaluate<string[]>('window.__colors'))
    ])
    await wait(
      `document.querySelector('[data-testid="event-rsvp-101-0"]').getAttribute('aria-checked')==='true'`
    )
    assert(
      new Set(await evaluate<string[]>('window.__colors')).size > 2,
      'Drag passes through intermediate blue/green colors'
    )
    await tap({ id: 'event-rsvp-101-1' })
    await m.assertVisible({
      css: '[data-testid="event-rsvp-101-1"]:not([aria-disabled="true"])',
      timeout: 5000
    })
    await m.pressKey({ key: 'RIGHT' })
    await wait(
      `document.querySelector('[data-testid="event-rsvp-101-2"]').getAttribute('aria-checked')==='true'`
    )
    await tap({ id: 'event-rsvp-101-1' })
    console.log(
      'Independent self/child replies, continuous gradient, keyboard and Maybe persistence passed'
    )
    await m.tapOn({ text: 'Done' })
    await wait(
      `document.querySelector('[data-testid="event-rsvp-modal"]')==null && document.querySelector('[data-testid="event-reply-status-101"]')?.textContent==='Maybe'`
    )
    const persisted = asEventInfo(
      await (await f.h.request('GET', `/events/${gameId}/info`)).json()
    )
    assert.deepEqual(persisted.replyUserIds, [101, 103, 104, 115])
    assert.equal(
      persisted.attendees.find(row => row.userId === userIdOfGumbo(101))?.name,
      'Babe R'
    )
    assert.equal(
      persisted.attendees.find(row => row.userId === userIdOfGumbo(115))
        ?.isTeamParticipant,
      false
    )
    for (const id of [102, 109, 110])
      assert(!persisted.attendees.some(row => row.userId === userIdOfGumbo(id)))
    const groups = await evaluate<
      Array<{ id: string; text: string; count: string; right: boolean }>
    >(
      `Array.from(document.querySelectorAll('[data-testid^="attendance-"]')).filter(node=>/^attendance-(staff|players|others)-(yes|maybe|no|noReply)$/.test(node.dataset.testid)).map(node=>{const heading=node.querySelector('[role="heading"]'), texts=heading.querySelectorAll('[dir="auto"]'), count=heading.querySelector('[data-testid="settings-pill-count"]')??texts[texts.length-1];return{id:node.dataset.testid,text:node.textContent,count:count.textContent,right:Math.abs(count.getBoundingClientRect().right-heading.getBoundingClientRect().right)<1}})`
    )
    assert.equal(groups.length, 9)
    assert(
      groups.every(group => group.right),
      'Every count pill is right-justified'
    )
    assert.deepEqual(
      groups.map(group => Number(group.count)),
      [2, 2, 1, 1, 1, 1, 2, 1, 1]
    )
    assert(
      groups
        .find(group => group.id === 'attendance-staff-yes')!
        .text.includes('Coach')
    )
    assert(
      groups
        .find(group => group.id === 'attendance-players-yes')!
        .text.includes('B:S • T:R • SS • CF')
    )
    assert(
      groups
        .find(group => group.id === 'attendance-others-maybe')!
        .text.includes('Guardian of Mike T')
    )
    assert(
      groups
        .find(group => group.id === 'attendance-others-no')!
        .text.includes('Spectator')
    )
    assert(
      !groups.some(
        group =>
          /Alex R|Mookie B/.test(group.text) &&
          group.id.startsWith('attendance-others')
      )
    )
    console.log(`Nine exact-team sections: ${JSON.stringify(groups)}`)
    for (const [id, file] of [
      ['attendance-staff-yes', 'groups-after.png'],
      ['attendance-players-noReply', 'groups-middle-after.png'],
      ['attendance-others-noReply', 'groups-bottom-after.png']
    ]) {
      await see({ id })
      await shot(file)
    }
    await see({ id: 'event-location-map' }, 'UP')
    await wait(
      `document.querySelector('iframe')?.contentWindow?.eventMap != null`
    )
    await shot('location-after.png')
    const mapRect = await evaluate<{
      x: number
      y: number
      width: number
      height: number
    }>(
      `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`
    )
    const center = await evaluate<{ lat: number; lng: number }>(
      `document.querySelector('iframe').contentWindow.eventMap.getCenter()`
    )
    await m.dragAndDrop({
      from: {
        point: `${Math.round(mapRect.x + mapRect.width * 0.8)},${Math.round(mapRect.y + 130)}`
      },
      to: {
        point: `${Math.round(mapRect.x + mapRect.width * 0.2)},${Math.round(mapRect.y + 130)}`
      },
      holdDuration: 100,
      duration: 500
    })
    const changedCenter = await evaluate<{ lat: number; lng: number }>(
      `document.querySelector('iframe').contentWindow.eventMap.getCenter()`
    )
    assert(
      Math.abs(center.lng - changedCenter.lng) > 0.001,
      'Leaflet map pans by dragging'
    )
    failTiles = true
    await open(`/games/${gameId}`)
    await see({ id: 'event-location-map' })
    await wait(
      `document.querySelector('iframe').contentDocument.querySelector('#error').style.display==='block'`
    )
    await shot('map-tiles-retry.png')
    failTiles = false
    const retryPoint = await evaluate<{ x: number; y: number }>(
      `(()=>{const f=document.querySelector('iframe'),a=f.getBoundingClientRect(),b=f.contentDocument.querySelector('#retry-map-tiles').getBoundingClientRect();return{x:a.x+b.x+b.width/2,y:a.y+b.y+b.height/2}})()`
    )
    await m.tapOnPoint({
      x: Math.round(retryPoint.x),
      y: Math.round(retryPoint.y)
    })
    await wait(
      `document.querySelector('iframe').contentDocument.querySelector('#error').style.display==='none'`
    )
    await see({ id: 'event-address' })
    // Clear of the floating tab bar, wherever the cards above leave it.
    await m.evalBrowserScript({
      script: `document.querySelector('[data-testid="event-address"]').scrollIntoView({block:'center'})`
    })
    await m.longPressOn({ id: 'event-address' })
    await m.assertVisible({ text: 'Address copied', timeout: 10000 })
    console.log(
      'Visible map below family controls, dragging, copy and tile retry passed'
    )
    await sql
      .raw(
        `create function fail_event_rsvp_fixture() returns trigger language plpgsql as $$begin if new.user_id=103 then raise exception 'Synthetic RSVP write failure'; end if; return new; end$$;create trigger fail_event_rsvp_fixture before insert or update on game_rsvps for each row execute function fail_event_rsvp_fixture();`
      )
      .execute(f.h.db)
    await tap({ id: 'event-replies-open' }, 'UP')
    await m.assertVisible({ id: 'event-rsvp-modal', timeout: 20000 })
    await tap({ id: 'event-rsvp-103-0' })
    await m.assertVisible({ text: 'Something went wrong', timeout: 10000 })
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-rsvp-103-2"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-rsvp-104-0"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    await shot('rsvp-rollback.png')
    await sql
      .raw(
        'drop trigger fail_event_rsvp_fixture on game_rsvps;drop function fail_event_rsvp_fixture();'
      )
      .execute(f.h.db)
    await open(`/games/${gameId}`)
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-reply-status-101"]').textContent`
      ),
      'Maybe'
    )
    console.log(
      'Actual failed write isolates rollback; refreshed replies persist'
    )
    const cookie = async (userId: number): Promise<void> => {
      await m.setCookies({
        cookies: [
          {
            name: SESSION_COOKIE,
            value: f.h.tokens.get(userId)!,
            domain: '127.0.0.1',
            path: '/'
          }
        ]
      })
    }
    await cookie(105)
    await open(`/games/${gameId}`, 'event-reply-row-105')
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-attendance-teams"]')==null`
      ),
      true
    )
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(105),
        team_id: f.teamB,
        is_player: false
      })
      .execute()
    await open(`/games/${gameId}`, 'event-reply-row-105')
    await tap(
      { css: '[aria-label="RSVP teams"] [aria-label="Demo Eagles"]' },
      'UP'
    )
    await shot('dual-team-rsvps.png')
    await wait(
      `document.querySelector('[data-testid="attendance-others-noReply"]').textContent.includes('Lou G')`
    )
    assert.equal(
      await evaluate(
        `(document.querySelector('[data-testid="attendance-players-yes"]')?.textContent ?? '').includes('Mookie B')`
      ),
      false
    )
    assert(
      await evaluate<boolean>(
        `document.querySelector('[data-testid="event-reply-row-103"]')!=null`
      ),
      'An out-of-selected-team child keeps a private control'
    )
    await insertFixtureUsers(f.h.db, {
      id: 116,
      legacyId: 'usr_info2_visitor',
      display_name: 'Nolan Ryan',
      first_name: 'Nolan',
      last_name: 'Ryan',
      login_enabled: true
    })
    f.h.tokens.set(
      116,
      (await createSession(f.h.db, userIdOfGumbo(116), 'event-info-visitor'))
        .token
    )
    await cookie(116)
    await open(`/games/${gameId}`, 'event-location-map')
    assert.equal(
      await evaluate(`document.querySelectorAll('[role="radiogroup"]').length`),
      0
    )
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-testid^="attendance-"]').length`
      ),
      0
    )
    const visitor = asEventInfo(
      await (
        await f.h.request('GET', `/events/${gameId}/info`, undefined, 116)
      ).json()
    )
    assert.equal(visitor.canViewAttendance, false)
    assert.deepEqual(visitor.attendees, [])
    assert.equal(
      (
        await f.h.request(
          'PUT',
          `/events/${gameId}/rsvps/116`,
          { response: 'yes' },
          116
        )
      ).status,
      404
    )
    await cookie(101)
    await open(`/games/${gameId}`)
    console.log(
      'Team chooser, private non-team children and read-only visitor privacy passed'
    )
    const overnightId = 'gam_viewer_midnight'
    await f.h.db
      .insertInto('games')
      .values({
        id: overnightId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: null,
        start_at: new Date('2027-04-11T06:30:00Z'),
        end_at: null
      })
      .execute()
    await open(`/games/${overnightId}`)
    await see({ id: 'event-hero' }, 'UP')
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-hero"]').textContent`
        )
      ).includes(
        eventHeroLines(
          '2027-04-11T06:30:00Z',
          null,
          undefined,
          'America/Los_Angeles'
        ).join('')
      )
    )
    await shot('local-time-after.png')
    await coveragePage.emulateTimezone('Asia/Tokyo')
    await open(`/games/${overnightId}`)
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-hero"]').textContent`
        )
      ).includes(
        eventHeroLines(
          '2027-04-11T06:30:00Z',
          null,
          undefined,
          'Asia/Tokyo'
        ).join('')
      )
    )
    await coveragePage.emulateTimezone('America/Los_Angeles')
    console.log(
      'Viewer-local hero time, overnight rollover and second-timezone conversion passed'
    )
    await m.openBrowser({
      url: f.h.origin + `/groups/team/${f.teamA}/create-game`
    })
    await m.assertVisible({ text: 'Create Game', timeout: 20000 })
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Arrival minutes (optional)"]').value`
      ),
      '45'
    )
    await shot('game-create-after.png')
    const dragType = async (from: number, to: number): Promise<void> => {
      await see({ id: 'event-type' }, 'UP')
      const points = await evaluate<Array<{ x: number; y: number }>>(
        `[${from},${to}].map(i=>{const r=document.querySelector('[data-testid="event-type-'+i+'"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})`
      )
      await m.dragAndDrop({
        from: {
          point: `${Math.round(points[0].x)},${Math.round(points[0].y)}`
        },
        to: { point: `${Math.round(points[1].x)},${Math.round(points[1].y)}` },
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
    console.log('Event Type drag Game→Practice→Other→Game passed')
    await tap({ id: 'event-type-1' }, 'UP')
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Arrival minutes (optional)"]').value`
      ),
      '0'
    )
    // A practice is called Practice; only other events take a title.
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="Title"]')==null`),
      true
    )
    await shot('practice-create.png')
    await see({ css: '[aria-label="Arrival minutes (optional)"]' })
    await shot('practice-arrival-default.png')
    await fill('Arrival minutes (optional)', '10')
    await tap({ id: 'event-type-2' }, 'UP')
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Arrival minutes (optional)"]').value`
      ),
      '10'
    )
    await m.assertVisible({ text: 'Create Event' })
    await shot('event-create-after.png')
    await fill('Title', 'Team dinner')
    await chooseDate('date', '2032-02-29', true)
    await chooseTime('time', '23:30', true)
    await tap({ id: 'event-schedule-timezone' })
    await settleTimezoneScene()
    await fill('Find time zone', 'America/')
    assert.equal(
      await evaluate(
        `document.querySelector('input[aria-label="Title"]').value`
      ),
      'Team dinner'
    )
    await tap({ text: 'Cancel time zone picker' })
    await chooseZone('America/Los_Angeles', true)
    await tap({ text: 'Set end time' })
    await tap({ text: 'Set end date' })
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-schedule-endDate"]').textContent`
        )
      ).includes('2032-03-01')
    )
    await shot('end-rollover.png')
    await fill('Venue name (optional)', 'Demo')
    await m.assertVisible({ text: 'Choose Demo Park', timeout: 10000 })
    await shot('venue-autocomplete.png')
    await tap({ text: 'Choose Demo Park' })
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Venue address (optional)"]').value`
      ),
      '1 Demo Way, Demo City'
    )
    await fill('Venue name (optional)', 'Custom field')
    await fill('Venue address (optional)', '1 Demo')
    await m.assertVisible({ text: 'Choose Demo Park', timeout: 10000 })
    await tap({ text: 'Choose Demo Park' })
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Venue name (optional)"]').value`
      ),
      'Custom field'
    )
    await fill('Venue name (optional)', '')
    await fill('Venue address (optional)', '1 Demo')
    await m.assertVisible({ text: 'Choose Demo Park', timeout: 10000 })
    await tap({ text: 'Choose Demo Park' })
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Venue name (optional)"]').value`
      ),
      'Demo Park'
    )
    await fill('Notes (optional)', 'Field 2\nMeet by the gate')
    await fill('Arrival minutes (optional)', '45')
    await fill('Venue address (optional)', '1 Demo Way, Demo City')
    await m.evalBrowserScript({
      script: 'window.holdEventCreation=true'
    })
    await tap({ text: 'Create event' })
    await wait(`typeof window.releaseEventCreation==='function'`)
    await see({ id: 'event-type' }, 'UP')
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-testid^="event-type-"][aria-disabled="true"]').length`
      ),
      3
    )
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="Title"]').readOnly`),
      true
    )
    const blockedType = await evaluate<{ x: number; y: number }>(
      `(()=>{const rect=document.querySelector('[data-testid="event-type-0"]').getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`
    )
    await m.tapOnPoint({
      x: Math.round(blockedType.x),
      y: Math.round(blockedType.y)
    })
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-type-2"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    await m.evalBrowserScript({ script: 'window.releaseEventCreation()' })
    await wait(`document.body.textContent.includes('Cannot reach TeamStation')`)
    await see({ text: 'Cannot reach TeamStation.*' })
    const firstCreated = await f.h.db
      .selectFrom('team_events')
      .select('id')
      .execute()
    assert.equal(firstCreated.length, 1)
    await tap({ id: 'event-type-0' }, 'UP')
    await tap({ id: 'event-type-2' }, 'UP')
    await tap({ text: 'Create event' })
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    const afterRetry = await f.h.db
      .selectFrom('team_events')
      .select('id')
      .execute()
    assert.deepEqual(
      afterRetry,
      firstCreated,
      'An identical retry after a type remount creates no duplicate'
    )
    console.log(
      'Pending titled save locks Event Type; lost response survives Game remount with one persisted event'
    )
    const event = await f.h.db
      .selectFrom('team_events')
      .selectAll()
      .executeTakeFirstOrThrow()
    assert.equal(event.title, 'Team dinner')
    assert.equal(event.start_at.toISOString(), '2032-03-01T07:30:00.000Z')
    assert.equal(event.end_at!.toISOString(), '2032-03-01T10:30:00.000Z')
    assert.equal(event.notes, 'Field 2\nMeet by the gate')
    assert.equal(event.arrival_time_delta, 45)
    assert.equal(event.event_type, 'other')
    await see({ id: 'event-notes' })
    await shot('venue-notes.png')
    await see({ id: 'event-hero' }, 'UP')
    await shot('arrival-info.png')
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-hero"]').textContent`
        )
      )
        .toUpperCase()
        .includes('ARRIVAL')
    )
    await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
    await m.assertVisible({ text: 'Event Settings' })
    await wait(
      `document.querySelector('[aria-label="Arrival minutes (optional)"]')!=null`
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Arrival minutes (optional)"]').value`
      ),
      '45'
    )
    await see({ id: 'event-type' }, 'UP')
    const typeGeometry = await evaluate<{
      aligned: boolean
      wordsFit: boolean
      labelWordsFit: boolean
    }>(
      `(()=>{const control=document.querySelector('[data-testid="event-type"]'),row=control.parentElement.parentElement,label=document.querySelector('[data-testid="event-type-label"]').firstChild;const box=control.getBoundingClientRect(),parent=row.getBoundingClientRect();return{aligned:Math.abs(box.right-parent.right)<1,wordsFit:[...control.querySelectorAll('[role="radio"]')].every(choice=>{const range=document.createRange();range.selectNodeContents(choice.firstElementChild);return range.getClientRects().length===1}),labelWordsFit:[[0,5],[6,10]].every(([start,end])=>{const range=document.createRange();range.setStart(label,start);range.setEnd(label,end);return range.getClientRects().length===1})}})()`
    )
    assert(
      typeGeometry.aligned &&
        typeGeometry.wordsFit &&
        typeGeometry.labelWordsFit,
      'Event Type stays right-aligned with unbroken choice and row-label words'
    )
    await shot('arrival-settings.png')
    await shot('event-settings-after.png')
    await fill('Title', 'Team picnic')
    await tap({ text: 'Remove end time' })
    await chooseTime('time', '00:15')
    await tap({ text: 'Set end time' })
    await tap({ text: 'Cancel event' })
    await tap({ text: 'Save event details' })
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    await m.assertVisible({ text: 'Canceled', timeout: 20000 })
    const edited = await f.h.db
      .selectFrom('team_events')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow()
    assert.equal(edited.title, 'Team picnic')
    assert.equal(edited.status, 'cancelled')
    assert.equal(edited.arrival_time_delta, 45)
    await see({ id: 'event-hero' }, 'UP')
    await shot('arrival-info.png')
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-hero"]').textContent`
        )
      ).includes(
        `Arrival ${eventArrivalTime(edited.start_at.toISOString(), 45, 'America/Los_Angeles')!}`
      )
    )
    assert.equal(edited.end_at!.getTime() - edited.start_at.getTime(), 10800000)
    assert.equal(await selected(), 'Info')
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[role="tab"][aria-label="Box score"]').length`
      ),
      0
    )
    await f.h.request('PUT', `/events/${event.id}/info`, {
      address: null,
      venue: 'Demo Park'
    })
    await open(`/games/${event.id}`)
    await see({ id: 'event-location-map' })
    await shot('legacy-location-after.png')
    await wait(`document.querySelector('iframe').contentWindow.eventMap!=null`)
    const venueCenter = await evaluate<{ lat: number; lng: number }>(
      `document.querySelector('iframe').contentWindow.eventMap.getCenter()`
    )
    await m.evalBrowserScript({
      script: `window.open=(url,target,features)=>{window.lastEventDirections=url;window.lastEventDirectionsFeatures=features;return null}`
    })
    await tap({ id: 'event-address' })
    const venueDirections = await evaluate<string>(`window.lastEventDirections`)
    assert.equal(
      await evaluate<string>('window.lastEventDirectionsFeatures'),
      'noopener,noreferrer'
    )
    const [directionsLatitude, directionsLongitude] = new URL(
      venueDirections
    ).searchParams
      .get('destination')!
      .split(',')
      .map(Number)
    assert(Math.abs(directionsLatitude - venueCenter.lat) < 0.000001)
    assert(Math.abs(directionsLongitude - venueCenter.lng) < 0.000001)
    console.log('Venue-only directions agree with the displayed map center')
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-address"]').textContent`
        )
      ).includes('Demo Park')
    )
    await f.h.request('PUT', `/events/${event.id}/info`, {
      address: 'Unavailable address'
    })
    await open(`/games/${event.id}`)
    await see({ text: 'Retry map' })
    await m.assertVisible({
      text: 'The address could not be located.*',
      timeout: 10000
    })
    failGeocode = false
    await m.evalBrowserScript({
      script: 'await new Promise(resolve=>setTimeout(resolve,10100))'
    })
    await tap({ text: 'Retry map' })
    await m.assertVisible({ id: 'event-location-map', timeout: 15000 })
    await f.h.request('PUT', `/events/${event.id}/info`, {
      address: null,
      venue: null
    })
    await open(`/games/${event.id}`)
    await see({ text: 'Location not set' })
    assert.equal(
      await evaluate(`document.querySelectorAll('iframe').length`),
      0
    )
    console.log(
      'Shared titled creation/settings, leap date, optional end, cancellation, venue map and lookup/absent-location recovery passed'
    )
    await open(`/games/${gameId}`)
    await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
    await m.assertVisible({ text: 'Game Settings', timeout: 20000 })
    await wait(
      `document.querySelector('[aria-label="Arrival minutes (optional)"]')!=null`
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Arrival minutes (optional)"]').value`
      ),
      ''
    )
    await fill('Arrival minutes (optional)', '45')
    await fill('Notes (optional)', 'Field 3\nMeet by the dugout')
    await chooseTime('time', '16:00')
    await m.assertVisible({ text: 'End time must be after start time' })
    assert(
      (
        await evaluate<string>(
          `document.querySelector('[data-testid="event-schedule-endTime"]').textContent`
        )
      ).includes('2:00 PM')
    )
    await tap({ text: 'Save' })
    assert.equal(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('id')
          .where('game_id', '=', gameId)
          .execute()
      ).length,
      0
    )
    console.log(
      'Start-only edit preserves explicit end and refuses invalid scheduling without a proposal'
    )
    await tap({ text: 'Remove end time' })
    await chooseZone('UTC')
    await chooseDate('date', '2032-03-04')
    await chooseTime('time', '23:30')
    await tap({ text: 'Set end time' })
    await tap({ text: 'Set end date' })
    await fill('Venue address (optional)', '2 Demo Way, Demo City')
    await fill('Venue name (optional)', 'Demo New Park')
    await see({ id: 'event-schedule-date' }, 'UP')
    await shot('game-settings-after.png')
    await tap({ text: 'Save' })
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    const request = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('game_id', '=', gameId)
      .where('kind', 'in', ['game', 'gameChange'])
      .executeTakeFirstOrThrow()
    const terms = request.terms as GameRequestTerms
    assert.equal(terms.game.startAt, '2032-03-04T23:30:00.000Z')
    assert.equal(terms.game.endAt, '2032-03-05T02:30:00.000Z')
    assert.equal(terms.game.arrivalTimeDelta, 45)
    assert.equal(terms.game.notes, 'Field 3\nMeet by the dugout')
    assert.equal(terms.game.address, '2 Demo Way, Demo City')
    assert.equal(terms.game.venue, 'Demo New Park')
    assert.equal(terms.game.timezone, 'UTC')
    await cookie(102)
    await m.openBrowser({ url: f.h.origin + `/notifications/${request.id}` })
    await wait(`document.body.textContent.includes('Proposed notes: Field 3')`)
    assert(
      await evaluate<boolean>(
        `document.body.textContent.includes('Previous notes: Not set.')&&document.body.textContent.includes('Proposed arrival: 45 minutes before start.')&&document.body.textContent.includes('Previous arrival: Not set.')`
      )
    )
    assert(
      await evaluate<boolean>(
        `document.body.textContent.includes('Proposed address: 2 Demo Way, Demo City.')&&document.body.textContent.includes('Previous address:')&&document.body.textContent.includes('Proposed end: Mar 5, 2032, 2:30 AM (UTC).')&&document.body.textContent.includes('Previous end:')`
      )
    )
    await m.evalBrowserScript({
      script: `const node=[...document.querySelectorAll('[dir="auto"]')].find(node=>node.firstChild?.nodeType===Node.TEXT_NODE&&node.textContent.includes('Proposed notes:'));const range=document.createRange();range.setStart(node.firstChild,node.textContent.indexOf('Proposed notes:'));range.setEnd(node.firstChild,node.textContent.length);for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight&&['auto','scroll'].includes(getComputedStyle(parent).overflowY))parent.scrollTop+=range.getBoundingClientRect().top-window.innerHeight/3`
    })
    await shot('approval-event-details.png')
    await tap({ text: 'Accept invitation' })
    await wait(`document.body.textContent.includes('Accepted')`)
    console.log(
      'Approving administrator sees proposed/previous notes, arrival, address and end before accepting'
    )
    await cookie(101)
    const published = await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    assert.equal(published.start_at.toISOString(), terms.game.startAt)
    assert.equal(published.end_at!.toISOString(), terms.game.endAt)
    assert.equal(published.latitude, null)
    await open(`/games/${gameId}`)
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-reply-status-101"]').textContent`
      ),
      'Maybe'
    )
    await m.openBrowser({
      url: f.h.origin + `/groups/team/${f.teamA}/create-game`
    })
    await m.assertVisible({ text: 'Create Game', timeout: 20000 })
    // The opponent is chosen in the team selector that slides up.
    await tap({ text: 'Choose Away Team, Away' })
    // The selector slides up; tap its row once it has come to rest.
    await m.assertVisible({
      css: `[data-testid="team-result-${f.teamB}"]`,
      timeout: 20000
    })
    await m.waitForAnimationToEnd()
    await tap({ css: `[data-testid="team-result-${f.teamB}"]` })
    await wait(`document.querySelector('[data-testid="team-selector"]')==null`)
    await chooseZone('UTC')
    await chooseDate('date', '2032-03-06')
    await chooseTime('time', '18:05')
    await tap({ text: 'Save' })
    await wait(`window.location.pathname.startsWith('/notifications/')`)
    const newRequest = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('kind', '=', 'game')
      .where('game_id', 'is', null)
      .executeTakeFirstOrThrow()
    const newTerms = newRequest.terms as GameRequestTerms
    assert.equal(newTerms.game.startAt, '2032-03-06T18:05:00.000Z')
    assert.equal(newTerms.game.endAt, null)
    assert.equal(newTerms.game.awayTeamId, f.teamB)
    assert.equal(
      (
        await f.h.request(
          'POST',
          `/game-requests/${newRequest.id}/accept`,
          undefined,
          102
        )
      ).status,
      200
    )
    console.log(
      `Real game settings/creation proposals retained authority and persisted metadata: ${JSON.stringify({ changed: terms.game, created: newTerms.game })}`
    )
    await open(`/games/${gameId}`)
    const scoring = await f.h.request('POST', `/games/${gameId}/events`, {
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
          }
        }
      ]
    })
    assert.equal(scoring.status, 200, await scoring.text())
    await m.evalBrowserScript({
      script: `window.dispatchEvent(new Event('focus'))`
    })
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 15000
    })
    await open(`/games/${gameId}?tab=info`)
    assert.equal(await selected(), 'Info')
    await m.openBrowser({ url: f.h.origin + `/games/${gameId}?tab=watch` })
    await m.assertVisible({ text: 'No videos.', timeout: 15000 })
    await m.openBrowser({ url: f.h.origin + `/games/${gameId}?tab=boxScore` })
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 15000
    })
    await m.openBrowser({ url: f.h.origin + `/games/${gameId}` })
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 15000
    })
    await tap({ css: '[role="tab"][aria-label="Videos"]' }, 'UP')
    await m.assertVisible({ text: 'No videos.' })
    await m.back()
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 15000
    })
    console.log(
      'First scoring activity, explicit Info/Videos/Box Score and browser Back passed'
    )
    const endingId = 'gam_default_three_hour_end'
    await f.h.db
      .insertInto('games')
      .values({
        id: endingId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: null,
        start_at: new Date(Date.now() - 10800000 + 7000),
        end_at: null
      })
      .execute()
    await open(`/games/${endingId}`)
    assert.equal(await selected(), 'Info')
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 15000
    })
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('[aria-label="Game sections"] [role="tab"]')).at(-1)?.textContent`
      ),
      'Info'
    )
    console.log(
      'Mounted three-hour default end switches focus and moves Info last'
    )
    await m.openBrowser({
      url: f.h.origin + `/groups/team/${f.teamA}/create-game`
    })
    await m.assertVisible({ text: 'Create Game', timeout: 20000 })
    await tap({ id: 'event-type-2' }, 'UP')
    await fill('Title', 'Demo DST event')
    await chooseZone('America/Los_Angeles')
    await chooseDate('date', '2027-11-06')
    await chooseTime('time', '23:30')
    await tap({ text: 'Set end time' })
    await tap({ id: 'event-schedule-endTime' })
    await m.assertVisible({ text: 'Choose time' })
    await tap({ text: 'Use time' })
    await shot('dst-end-reconfirmation.png')
    await tap({ text: 'Create event' })
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    const dstEvent = await f.h.db
      .selectFrom('team_events')
      .selectAll()
      .where('title', '=', 'Demo DST event')
      .executeTakeFirstOrThrow()
    assert.equal(dstEvent.start_at.toISOString(), '2027-11-07T06:30:00.000Z')
    assert.equal(dstEvent.end_at!.toISOString(), '2027-11-07T09:30:00.000Z')
    assert.equal(
      dstEvent.end_at!.getTime() - dstEvent.start_at.getTime(),
      10800000
    )
    console.log(
      'Reconfirming an inferred repeated-hour end persists three elapsed hours at DST'
    )
    await f.h.db
      .updateTable('team_events')
      .set({
        start_at: new Date('2027-11-07T08:45:00Z'),
        end_at: new Date('2027-11-07T09:32:00Z')
      })
      .where('id', '=', dstEvent.id)
      .execute()
    await open(`/games/${dstEvent.id}`)
    await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
    await m.assertVisible({ text: 'Event Settings', timeout: 20000 })
    await tap({ id: 'event-schedule-endTime' })
    await tap({ text: 'Use time' })
    await tap({ text: 'Save event details' })
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    const savedFold = await f.h.db
      .selectFrom('team_events')
      .selectAll()
      .where('id', '=', dstEvent.id)
      .executeTakeFirstOrThrow()
    assert.equal(savedFold.end_at!.toISOString(), '2027-11-07T09:30:00.000Z')
    assert.equal(
      savedFold.end_at!.getTime() - savedFold.start_at.getTime(),
      45 * 60000
    )
    await f.h.db
      .updateTable('team_events')
      .set({
        start_at: new Date('2027-11-07T09:32:00Z'),
        end_at: new Date('2027-11-07T12:32:00Z')
      })
      .where('id', '=', dstEvent.id)
      .execute()
    await open(`/games/${dstEvent.id}`)
    await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
    await m.assertVisible({ text: 'Event Settings', timeout: 20000 })
    await tap({ id: 'event-schedule-time' })
    await tap({ text: 'Use time' })
    await tap({ text: 'Save event details' })
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    const roundedStart = await f.h.db
      .selectFrom('team_events')
      .select('start_at')
      .where('id', '=', dstEvent.id)
      .executeTakeFirstOrThrow()
    assert.equal(
      roundedStart.start_at.toISOString(),
      '2027-11-07T09:30:00.000Z'
    )
    await m.openBrowser({ url: f.h.origin + `/games/${dstEvent.id}/settings` })
    await m.assertVisible({ text: 'Event Settings', timeout: 20000 })
    await m.evalBrowserScript({ script: 'window.holdEventSettings=true' })
    await tap({ text: 'Save event details' })
    await wait(`typeof window.releaseEventSettings==='function'`)
    await tap({ css: '[aria-label="Back"][role="button"]' }, 'UP')
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    const afterBack = await evaluate<string>(
      'location.pathname+location.search'
    )
    await m.evalBrowserScript({ script: 'window.releaseEventSettings()' })
    await wait('window.eventSettingsReplyDelivered===true')
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    assert.equal(
      await evaluate<string>('location.pathname+location.search'),
      afterBack
    )
    console.log(
      'Off-grid second-fold start/end round within the saved occurrence; pending settings completion after header Back preserves the returned page'
    )
    await f.h.db
      .updateTable('team_events')
      .set({ start_at: new Date('2027-11-08T07:58:00Z'), end_at: null })
      .where('id', '=', dstEvent.id)
      .execute()
    await open(`/games/${dstEvent.id}`)
    await tap({ css: '[aria-label="Event settings"][role="button"]' }, 'UP')
    await m.assertVisible({ text: 'Event Settings', timeout: 20000 })
    await tap({ id: 'event-schedule-time' })
    await m.assertVisible({ text: '.*Next day.*' })
    await tap({ text: 'Use time' })
    await tap({ text: 'Save event details' })
    await m.assertVisible({ id: 'event-reply-row-101', timeout: 20000 })
    const midnight = await f.h.db
      .selectFrom('team_events')
      .selectAll()
      .where('id', '=', dstEvent.id)
      .executeTakeFirstOrThrow()
    assert.equal(midnight.start_at.toISOString(), '2027-11-08T08:00:00.000Z')
    console.log(
      'Loaded repeated-hour end remains45 minutes; near-midnight start rounds two minutes forward'
    )
    await f.h.db
      .updateTable('memberships')
      .set({ is_player: false })
      .where('team_id', '=', f.teamA)
      .where('user_id', '=', userIdOfGumbo(103))
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamB,
        user_id: userIdOfGumbo(109),
        is_player: false
      })
      .execute()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(109),
        related_user_id: userIdOfGumbo(103),
        kind: 'guardian',
        can_manage: false
      })
      .execute()
    await cookie(109)
    await open(`/games/${gameId}?tab=info`, 'event-reply-row-109')
    const direct = asEventInfo(
      await (
        await f.h.request('GET', `/events/${gameId}/info`, undefined, 109)
      ).json()
    )
    assert.equal(direct.teamId, f.teamB)
    assert.equal(
      await evaluate(
        `(document.querySelector('[data-testid="attendance-players-yes"]')?.textContent ?? '').includes('Mookie B')`
      ),
      false
    )
    assert(
      await evaluate<boolean>(
        `document.querySelector('[data-testid="event-reply-row-103"]')!=null`
      )
    )
    console.log(
      'Direct away affiliation wins over private guardian control for a home-team non-player'
    )
    // Earlier scoring checks started the original game; quick replies need a new upcoming fixture.
    const quickGameId = 'gam_event_info_quick'
    await f.h.db
      .insertInto('games')
      .values({
        id: quickGameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        start_at: new Date(Date.now() + 86400000)
      })
      .execute()
    await cookie(101)
    await m.openBrowser({ url: f.h.origin + `/teams/${f.teamA}?tab=schedule` })
    await see({ id: `schedule-rsvps-${quickGameId}` }, 'UP')
    await shot('team-schedule-player-counts.png')
    await tap({
      css: `[data-testid="schedule-rsvps-${quickGameId}"] [role="button"]`
    })
    await m.assertVisible({ id: 'event-rsvp-modal', timeout: 20000 })
    await wait(
      `document.querySelector('[data-testid="quick-rsvp-row-104"]')!=null`
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="quick-rsvp-row-115"]')==null&&document.querySelector('[data-testid="quick-rsvp-row-103"]')==null`
      ),
      true
    )
    await m.waitForAnimationToEnd()
    await shot('team-schedule-rsvp-modal.png')
    await tap({ id: 'event-rsvp-104-2' })
    await wait(
      `document.querySelector('[data-testid="event-rsvp-104-2"]').getAttribute('aria-disabled')!=='true'`
    )
    const counted = (
      await (await f.h.request('GET', `/teams/${f.teamA}/games`)).json()
    ).find((row: { id: string }) => row.id === quickGameId).playerRsvps
    await tap({ text: 'Done' })
    await see({ id: `schedule-rsvps-${quickGameId}` }, 'UP')
    assert.equal(
      Number(
        await evaluate<string>(
          `document.querySelector('[data-testid="schedule-rsvps-${quickGameId}"] [data-testid="player-rsvp-count-no"]').textContent`
        )
      ),
      counted.no
    )
    await m.openBrowser({ url: f.h.origin + '/schedule' })
    await m.assertVisible({ text: 'Upcoming', timeout: 20000 })
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="player-rsvp-counts"]')==null&&document.querySelector('[data-testid^="schedule-rsvps-"]')==null`
      ),
      true
    )
    console.log(
      'Team schedule player-only counts and compact guardian RSVP modal persist; general schedule excludes the controls'
    )
    await Promise.all(network)
    const requireCoverage = createRequire(join(process.cwd(), 'package.json'))
    const convert = requireCoverage('v8-to-istanbul')
    const map = requireCoverage('istanbul-lib-coverage').createCoverageMap({})
    for (const script of await coveragePage.coverage.stopJSCoverage()) {
      if (
        !script.url.startsWith(f.h.origin + '/app-') ||
        script.rawScriptCoverage == null
      )
        continue
      const generated = resolve('dist', basename(new URL(script.url).pathname))
      const converter = convert(generated, 0, {
        source: script.text,
        sourceMap: {
          sourcemap: JSON.parse(readFileSync(generated + '.map', 'utf8'))
        }
      })
      await converter.load()
      converter.applyCoverage(script.rawScriptCoverage.functions)
      map.merge(converter.toIstanbul())
    }
    const coverageOutput = resolve(
      process.env.EVENT_INFO_BROWSER_COVERAGE ??
        'coverage/eventInfo/browser.json'
    )
    mkdirSync(dirname(coverageOutput), { recursive: true })
    writeFileSync(coverageOutput, JSON.stringify(map.toJSON()))
    assert.deepEqual(appErrors, [], 'No app JavaScript errors')
    console.log(
      'Chromium Maestro D version-2 event slice passed; V8 browser coverage captured'
    )
  } finally {
    await coverageBrowser?.disconnect()
    await daemon
      .detach(process.env.EVENT_INFO_BROWSER_DEVICE ?? 'event-info-chromium')
      .catch((error: unknown) => {
        console.error('Browser detach:', error)
      })
    await daemon.shutdown().catch(() => undefined)
    daemon.close()
    await f.h.close()
    await new Promise<void>(resolve =>
      external.close(() => {
        resolve()
      })
    )
    if (oldProvider === undefined) delete process.env.TS_EVENT_GEOCODER_URL
    else process.env.TS_EVENT_GEOCODER_URL = oldProvider
    if (oldTiles === undefined) delete process.env.TS_EVENT_MAP_TILES
    else process.env.TS_EVENT_MAP_TILES = oldTiles
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
