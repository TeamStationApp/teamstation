import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import puppeteer from 'puppeteer'

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Real media playback and shipped controls, checked through the administrator API. */
export async function webVideo(
  m: any,
  origin: string,
  fixtures: any
): Promise<void> {
  const started = new Date().toISOString()
  const account = fixtures.accounts.find((a: any) => a.role === 'admin')
  const query = async (): Promise<any[]> => {
    const response = await fetch(origin + '/api/v1/admin/analytics/query', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + account.token
      },
      body: JSON.stringify({
        sql: "SELECT event_name, properties, user_id FROM analytics.events WHERE occurred_at >= $1 AND properties->>'vi' = $2 ORDER BY occurred_at",
        parameters: [started, fixtures.videoId]
      })
    })
    assert.equal(response.status, 200)
    return (await response.json()).rows
  }
  const state = async (): Promise<any> =>
    JSON.parse(
      (
        await m.evalBrowserScript({
          script:
            "const v=[...document.querySelectorAll('video')].find(v=>!v.closest('#root'));return JSON.stringify(v?{paused:v.paused,t:v.currentTime,ready:v.readyState,ended:v.ended}:null);"
        })
      ).data
    )
  const waitState = async (
    predicate: (value: any) => boolean
  ): Promise<any> => {
    for (let i = 0; i < 30; i++) {
      const value = await state()
      if (value != null && predicate(value)) return value
      await pause(500)
    }
    assert.fail('Player did not reach the expected state')
  }
  await m.openLink({
    link: origin + '/games/' + fixtures.gameId + '?video=' + fixtures.videoId
  })
  await m.tapOn({ text: 'Watch full screen' })
  await waitState(value => value.paused === false && value.ready >= 3)
  // A reused profile can contain other tabs on this origin. Mark the exact
  // document driven by Maestro so the recording proves the same interaction.
  const recordingToken = randomUUID()
  await m.evalBrowserScript({
    script: `document.documentElement.setAttribute('data-observability-recording', ${JSON.stringify(recordingToken)}); return 'marked';`
  })
  const [port, path] = (
    await readFile(
      join(process.env.OBSERVABILITY_BROWSER_PROFILE!, 'DevToolsActivePort'),
      'utf8'
    )
  )
    .trim()
    .split('\n')
  const browser = await puppeteer.connect({
    browserWSEndpoint: `ws://127.0.0.1:${port}${path}`,
    defaultViewport: null
  })
  let recorder: { stop: () => Promise<void> } | undefined
  try {
    const pages = []
    for (const page of await browser.pages()) {
      if (
        await page.evaluate(
          token =>
            document.documentElement.getAttribute(
              'data-observability-recording'
            ) === token,
          recordingToken
        )
      )
        pages.push(page)
    }
    assert.equal(pages.length, 1, 'Recording must target the driven player tab')
    recorder = await pages[0].record({
      path: join(
        process.env.OBSERVABILITY_ARTIFACT_DIR!,
        'playback-observation.mp4'
      )
    })
    await pause(20000)
    await m.pressKey({ key: 'Space' })
    const stopped = await waitState(value => value.paused)
    await pause(5000)
    assert(
      Math.abs((await state()).t - stopped.t) < 0.5,
      'Paused video advanced'
    )
    await m.pressKey({ key: 'Right' })
    await waitState(value => value.t > stopped.t + 8)
    await m.pressKey({ key: 'Space' })
    await waitState(value => value.paused === false && value.ready >= 3)
    await pause(5000)
    await m.pressKey({ key: 'Tab' })
    await m.tapOn({ text: 'Close' })
  } finally {
    try {
      await recorder?.stop()
    } finally {
      await browser.disconnect()
    }
  }
  let rows: any[] = []
  for (let i = 0; i < 20; i++) {
    rows = await query()
    if (rows.some(row => row.event_name === 'video_left')) break
    await pause(500)
  }
  for (const event of [
    'video_started',
    'video_paused',
    'video_resumed',
    'video_seeked',
    'video_left',
    'watch_progress'
  ]) {
    assert(
      rows.some(row => row.event_name === event),
      'Missing ' + event
    )
  }
  assert(rows.every(row => row.user_id === account.id))
  const watched = rows
    .filter(row => row.event_name === 'watch_progress')
    .reduce((total, row) => total + row.properties.ms, 0)
  assert(
    watched >= 23000 && watched <= 29000,
    'Watch time must exclude five paused seconds and the ten-second seek'
  )
  assert.equal(
    new Set(rows.map(row => row.properties.ps)).size,
    1,
    'Only the selected full viewer counts'
  )
  console.log(
    `web: actual 20s play, 5s pause, 10s seek, 5s play and leave; ${Math.round(watched)}ms stored, correct viewer/video and one viewing session`
  )
}
