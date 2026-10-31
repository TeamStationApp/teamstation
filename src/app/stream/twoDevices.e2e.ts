// E15: two phones and a Director on one game, three angles, each listed on
// the phones with the device filming it. Through maestro-d's JavaScript
// client. The shared environment is in phoneStreamRig.e2e.ts; besides it:
//
//   TS_STREAM_IOS_UDID=<the iPhone 13 Pro, or its simulator>
//   [TS_STREAM_ANDROID_SERIAL=<the Pixel 10>]
//   [DIRECTOR_DEVICE_UDID=<the iPad Pro M4 running Director>]
//   [TS_STREAM_DIRECTOR_WAIT=<seconds to wait for Director, 300>]
//   [TS_STREAM_RECORD_SECONDS=<with no Pixel, how long the iPhone's take runs>]
//   TS_STREAM_WEB_URL=<the web app, on the API's host, for the game page>
//   [TS_STREAM_CHROME=<a Chrome that decodes HEVC, for puppeteer>]
//     node -r sucrase/register src/app/stream/twoDevices.e2e.ts
//
//   1. The iPhone: Record Video "Home Plate", on the air.
//   2. The Pixel: its list reads "Home Plate" · "Streaming with iPhone 13
//      Pro" · "Live";
//      then Record Video "First Base", on the air. With no Pixel, a stand-in
//      device B (`curl` as the same account, `deviceModel` "Pixel 10",
//      `recordsLocally`) makes "First Base" and ffmpeg publishes to it.
//   3. Director streams as "Center Field": started by hand on the iPad,
//      which this waits for. With no iPad, a stand-in device C ("iPad Pro",
//      not recording locally) does.
//      With both the Pixel and the iPad, Director goes on the air before the
//      Pixel records, so the Pixel's list (its camera covers it once it
//      films) reads Home Plate and Center Field with their models.
//   4. Every phone lists all three angles with their models; the game has a
//      live video for each, which is what its angle pills are drawn from.
//   5. The web game page (puppeteer) shows a pill per angle, and All angles
//      → Watch plays the three in the multi-camera view: every picture's
//      time moves. The browser is closed at the end.
//      With the Pixel, both phones stay on the air for E16, and the server's
//      list names every device.
//      With no Pixel, the iPhone stops and closes its camera to read its
//      list (the camera covers it while live), and the stand-in device B
//      reports its recording as not uploaded, which the iPhone shows.
//
// Screenshots: two-devices-angle-list.png (the list on the device that is
// not filming), videos-tab-native-after.png (the Videos tab framed as
// videos-tab-native-before.png), two-devices-web-angles.png (the web
// multi-camera view).
import assert from 'node:assert/strict'
import path from 'node:path'

import puppeteer, { type Browser, type Page } from 'puppeteer'

import { lstrings } from '../locales/strings'
import {
  api,
  apiToken,
  cameras,
  clearAngles,
  game,
  optional,
  Phone,
  request,
  required,
  say,
  sleep,
  type StandIn,
  standIn,
  type StreamRow,
  waitPublishing
} from './phoneStreamRig.e2e'

const HOME = 'Home Plate'
const FIRST = 'First Base'
const CENTER = 'Center Field'
const DEVICE_B = '00000000-0000-4000-8000-00000000000b'
const DEVICE_C = '00000000-0000-4000-8000-00000000000c'

/** The angle row's words on a phone, waiting for them to read as `want` says. */
async function rowReads(
  phone: Phone,
  row: StreamRow,
  want: string[],
  wait = 20000
): Promise<string> {
  let words = ''
  for (const until = Date.now() + wait; Date.now() < until;) {
    words = await phone.textsOf(`angle-row-${row.id}`)
    if (want.every(word => words.includes(word))) return words
    await sleep(1000)
  }
  throw new Error(`${row.label}'s row reads “${words}”, not ${want.join(', ')}`)
}

/** Waits for Director, started by hand on the iPad, to stream as Center Field. */
async function waitForDirector(token: string): Promise<StreamRow> {
  say(`waiting for Director on the iPad to stream as “${CENTER}”`)
  const wait = Number(optional('TS_STREAM_DIRECTOR_WAIT') ?? '300') * 1000
  for (const until = Date.now() + wait; Date.now() < until;) {
    const center = (await cameras(token)).mine.find(
      row => row.label === CENTER && row.state === 'publishing'
    )
    if (center != null) return center
    await sleep(2000)
  }
  throw new Error('Director never streamed as Center Field')
}

/** Clicks the first element with `role` whose words are `text`. */
async function clickRole(
  page: Page,
  role: string,
  text: string
): Promise<void> {
  // Functions run in the page are sent as source text: sucrase turns `?.`
  // and `??` into helpers the page does not have, so they use plain JS.
  const handle = await page.waitForFunction(
    (wantRole: string, wantText: string) => {
      const found = [
        ...document.querySelectorAll(`[role="${wantRole}"], button`)
      ].find(
        element =>
          (element.textContent == null ? '' : element.textContent.trim()) ===
          wantText
      )
      if (found === undefined) return false
      return found
    },
    { timeout: 20000 },
    role,
    text
  )
  await (handle as unknown as { click: () => Promise<void> }).click()
}

/**
 * Step 5: the web game page, as a member watching it in a browser. Its angle
 * pills name the three angles, and the multi-camera view plays them.
 */
async function webMultiCam(token: string, angles: string[]): Promise<string> {
  const web = required('TS_STREAM_WEB_URL').replace(/\/$/, '')
  let browser: Browser | undefined
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: optional('TS_STREAM_CHROME'),
      args: ['--autoplay-policy=no-user-gesture-required']
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(30000)
    await page.setViewport({ width: 1440, height: 900 })
    await browser.setCookie({
      name: 'ts_session',
      value: encodeURIComponent(token),
      domain: new URL(api()).hostname,
      path: '/'
    })
    say(`$ puppeteer goto ${web}/games/${game()}?tab=watch`)
    await page.goto(`${web}/games/${game()}?tab=watch`, {
      waitUntil: 'networkidle2'
    })
    const pills = async (): Promise<string[]> =>
      await page.$$eval('[role="tab"]', tabs =>
        tabs.map(tab => (tab.textContent == null ? '' : tab.textContent.trim()))
      )
    let shown: string[] = []
    for (const until = Date.now() + 30000; Date.now() < until;) {
      shown = await pills()
      if (angles.every(angle => shown.includes(angle))) break
      await sleep(1000)
    }
    assert(
      angles.every(angle => shown.includes(angle)),
      `the web page has a pill per angle: ${shown.join(', ')}`
    )
    say('$ click All angles, then Watch')
    await clickRole(page, 'tab', 'All angles')
    await clickRole(page, 'button', 'Watch')
    const times = async (): Promise<number[]> =>
      await page.$$eval('video', videos =>
        videos.map(video => video.currentTime)
      )
    let first: number[] = []
    for (const until = Date.now() + 30000; Date.now() < until;) {
      first = await times()
      // The single player stays mounted behind the view, paused.
      if (first.filter(time => time > 0).length >= angles.length) break
      await sleep(1000)
    }
    assert(
      first.length >= angles.length,
      `the multi-camera view shows ${angles.length} pictures (${first.length})`
    )
    await sleep(4000)
    const later = await times()
    const moving = later.filter((time, index) => time > (first[index] ?? 0))
    assert(
      moving.length >= angles.length,
      `every picture plays: ${first.map(time => time.toFixed(1)).join(', ')} → ${later.map(time => time.toFixed(1)).join(', ')}`
    )
    // A tile with no address reads "not available": its angle is not
    // playing, whatever the other pictures do (the single player behind the
    // view is a <video> too, and counted with them).
    const unavailable = await page.$$eval(
      '*',
      (elements, text) =>
        elements.filter(
          element =>
            element.children.length === 0 &&
            String(element.textContent).includes(text)
        ).length,
      lstrings.game_video_unavailable
    )
    assert.equal(
      unavailable,
      0,
      'no tile reads that its video is not available'
    )
    const dir = optional('TS_STREAM_ARTIFACT_DIR')
    if (dir != null) {
      await page.screenshot({
        path: path.join(dir, 'two-devices-web-angles.png')
      })
    }
    return `5 the web page's pills read ${shown.join(', ')}; the multi-camera view plays ${moving.length} pictures (${first.map(time => time.toFixed(1)).join(', ')} → ${later.map(time => time.toFixed(1)).join(', ')} s)`
  } finally {
    await browser?.close()
  }
}

async function main(): Promise<void> {
  const email = required('TS_STREAM_EMAIL')
  const token = await apiToken(email)
  const pixelSerial = optional('TS_STREAM_ANDROID_SERIAL')
  const director = optional('DIRECTOR_DEVICE_UDID')
  const results: string[] = []
  const standIns: StandIn[] = []
  await clearAngles(token, [HOME, FIRST, ...(director == null ? [CENTER] : [])])

  const iphone = await Phone.attach(required('TS_STREAM_IOS_UDID'), 'ios')
  let pixel: Phone | undefined
  try {
    // 1. Home Plate on the iPhone.
    await iphone.launch()
    await iphone.signInIfAsked(email)
    await iphone.openGame()
    await iphone.recordAngle(HOME)
    const recordedAt = Date.now()
    const home = (await cameras(token)).mine.find(row => row.label === HOME)
    assert(home != null, 'Home Plate is on the game')
    await waitPublishing(token, home.id)
    results.push(`1 ${HOME} live from ${home.deviceModel ?? '?'}`)

    // 2. First Base on the Pixel, or a stand-in. With the Pixel, Director
    // goes on the air first: the Pixel's own camera covers its list once it
    // films, so it reads Home Plate and Center Field before it records.
    let center: StreamRow | undefined
    const pixelLines: string[] = []
    if (director != null && pixelSerial != null) {
      center = await waitForDirector(token)
      results.push(
        `3 Director streams ${CENTER} (${center.deviceModel ?? '?'})`
      )
    }
    let first: StreamRow
    if (pixelSerial != null) {
      pixel = await Phone.attach(pixelSerial, 'android')
      await pixel.launch()
      await pixel.signInIfAsked(email)
      await pixel.openGame()
      await pixel.scrollTo({ id: `angle-row-${home.id}` })
      pixelLines.push(
        await rowReads(pixel, home, [
          HOME,
          'Streaming with iPhone 13 Pro',
          'Live'
        ])
      )
      if (center != null) {
        await pixel.scrollTo({ id: `angle-row-${center.id}` })
        pixelLines.push(
          await rowReads(pixel, center, [
            CENTER,
            'Streaming with iPad Pro',
            'Live'
          ])
        )
      }
      for (const line of pixelLines) say(`$ assertVisible ${line}`)
      await pixel.shot('two-devices-angle-list.png')
      await pixel.recordAngle(FIRST)
      const found = (await cameras(token)).mine.find(row => row.label === FIRST)
      assert(found != null, 'First Base is on the game')
      first = found
      results.push(
        `2 the Pixel lists “${pixelLines.join(' | ')}”, then records ${FIRST}`
      )
    } else {
      const b = await standIn(token, {
        label: FIRST,
        deviceId: DEVICE_B,
        deviceModel: 'Pixel 10',
        recordsLocally: true,
        publish: true
      })
      standIns.push(b)
      first = b.stream
      results.push(
        `2 no Pixel: stand-in device B made ${FIRST} (Pixel 10) and ffmpeg publishes to it`
      )
    }
    await waitPublishing(token, first.id)

    // 3. Center Field from Director, or a stand-in.
    if (center != null) {
      // Already on the air, before the Pixel recorded.
    } else if (director != null) {
      center = await waitForDirector(token)
      results.push(
        `3 Director streams ${CENTER} (${center.deviceModel ?? '?'})`
      )
    } else {
      const c = await standIn(token, {
        label: CENTER,
        deviceId: DEVICE_C,
        deviceModel: 'iPad Pro',
        recordsLocally: false,
        publish: true
      })
      standIns.push(c)
      center = c.stream
      await waitPublishing(token, center.id)
      results.push(
        `3 no iPad: stand-in device C made ${CENTER} (iPad Pro) and ffmpeg publishes to it`
      )
    }

    // 4. The lists, and the game's live videos.
    // A real Pixel names itself with its maker (Build.MANUFACTURER before
    // Build.MODEL); the stand-in device B says only "Pixel 10".
    const models = new Map([
      [HOME, 'iPhone 13 Pro'],
      [FIRST, pixel == null ? 'Pixel 10' : 'Google Pixel 10'],
      [CENTER, 'iPad Pro']
    ])
    const all = await cameras(token)
    const rows = [home, first, center].map(
      one => all.mine.find(row => row.id === one.id) ?? one
    )
    for (const row of rows)
      say(`server: ${row.label} · ${row.deviceModel ?? '-'} · ${row.state}`)
    const listing = pixel ?? iphone
    if (pixel == null) {
      // The camera covers the list while it is live: stop and close it, and
      // the stand-in Pixel says its own recording is not uploaded. The take
      // runs for TS_STREAM_RECORD_SECONDS first, so E16 has an upload long
      // enough to cut off part way.
      const hold =
        Number(optional('TS_STREAM_RECORD_SECONDS') ?? '0') * 1000 -
        (Date.now() - recordedAt)
      if (hold > 0) {
        say(`recording ${Math.round(hold / 1000)} s more`)
        await sleep(hold)
      }
      await iphone.stopAndClose()
      say(
        `$ curl -X PATCH …/live-streams/${first.id} -d '{"localRecording":"recorded"}'`
      )
      const patched = await request(
        'PATCH',
        `/games/${game()}/live-streams/${first.id}`,
        { localRecording: 'recorded' },
        token
      )
      assert(patched.ok, `device B reports its recording: ${patched.status}`)
    }
    if (pixel == null) {
      const lines: string[] = []
      for (const row of rows) {
        await listing.scrollTo({ id: `angle-row-${row.id}` })
        const live = row.id !== home.id
        lines.push(
          await rowReads(listing, row, [
            row.label,
            `${live ? 'Streaming with' : 'Waiting for stream from'} ${models.get(row.label) ?? ''}`,
            live ? 'Live' : 'Idle'
          ])
        )
      }
      lines.push(
        await rowReads(listing, first, ['Recording on Pixel 10 not uploaded'])
      )
      for (const line of lines) say(`$ assertVisible ${line}`)
      await listing.scrollTo({ id: `angle-row-${first.id}` })
      await listing.shot('two-devices-angle-list.png')
      results.push(`4 the iPhone lists: ${lines.join(' | ')}`)
    } else {
      // Both phones are filming, so their screens are their cameras: the
      // Pixel read its list before it recorded (step 2), and every device is
      // checked here through the server's list.
      assert.deepEqual(
        rows.map(row => row.deviceModel),
        [models.get(HOME), models.get(FIRST), models.get(CENTER)],
        'the server names every device'
      )
      results.push(
        `4 the server lists: ${rows.map(row => `${row.label} · ${row.deviceModel ?? '-'} · ${row.state}`).join(' | ')}`
      )
    }

    const answer = await request('GET', `/games/${game()}`, undefined, token)
    const titles = (
      (await answer.json()) as { videos?: Array<{ title: string }> }
    ).videos?.map(video => video.title)
    const pills = [HOME, FIRST, CENTER].filter(
      angle => titles?.some(title => title.endsWith(` — ${angle}`)) === true
    )
    assert.deepEqual(pills, [HOME, FIRST, CENTER], 'a live video per angle')
    results.push(`5 the game has a live video for ${pills.join(', ')}`)
    results.push(await webMultiCam(token, [HOME, FIRST, CENTER]))

    // The Videos tab, framed as videos-tab-native-before.png. The game's
    // videos are read when its screen mounts: start the app again so the
    // live videos are there above the cameras. Not while the Pixel films:
    // E16 stops that take from the streaming screen.
    if (pixel == null) {
      await listing.launch()
      await listing.openGame()
      await listing.scrollTo({ text: 'CAMERAS' })
      await listing.m.swipe({
        start: '50%, 70%',
        end: '50%, 45%',
        duration: 600
      })
      await sleep(1500)
      await listing.shot('videos-tab-native-after.png')
    }
  } finally {
    for (const one of standIns) await one.stop()
    await iphone.detach()
    await pixel?.detach()
  }
  for (const line of results) say(`PASS ${line}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
