import assert from 'node:assert/strict'

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Native playback uses the real player and its accessibility controls. */
export async function nativeVideo(
  m: any,
  origin: string,
  fixtures: any
): Promise<void> {
  const started = new Date().toISOString()
  const admin = fixtures.accounts.find((a: any) => a.role === 'admin')
  const viewer = fixtures.accounts.find((a: any) => a.role === 'second')
  const query = async (): Promise<any[]> => {
    const response = await fetch(origin + '/api/v1/admin/analytics/query', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + admin.token
      },
      body: JSON.stringify({
        sql: "SELECT event_name, properties, user_id FROM analytics.events WHERE occurred_at >= $1 AND app = $2 AND properties->>'vi' = $3 ORDER BY occurred_at",
        parameters: [started, 'TS', fixtures.videoId]
      })
    })
    assert.equal(response.status, 200)
    return (await response.json()).rows
  }
  await m.openLink({
    link:
      'teamstation://games/' + fixtures.gameId + '?video=' + fixtures.videoId
  })
  await m.tapOn({ text: 'Watch full screen', timeout: 15000 })
  await pause(20000)
  // The shipped center tap toggles playback; the bottom third shows controls.
  await m.tapOn({ id: 'grid-touches' })
  await pause(5000)
  await m.tapOn({ id: 'grid-touches' })
  await pause(5000)
  await m.pressKey({ key: 'HOME' })
  await pause(5000)
  // Returning through the launcher preserves the live player and its session.
  if (process.env.TS_ANDROID_DEVICE != null)
    await m.launchApp({ appId: 'app.teamstation.app', stopApp: false })
  else await m.tapOn({ text: 'TeamStation' })
  await pause(5000)
  await m.tapOn({ point: '50%,85%' })
  const findTrack = (node: any): any =>
    node.text === 'Position in the game' || node.type === 'SeekBar'
      ? node
      : (node.children ?? []).map(findTrack).find(Boolean)
  const track = findTrack(await m.hierarchy())?.bounds
  assert(track != null, 'Visible native transport required')
  await m.tapOn({
    point: `${Math.round(track.x + track.width * 0.9)},${Math.round(track.y + track.height / 2)}`
  })
  await pause(8000)
  await m.tapOn({ point: '50%,85%' })
  await m.tapOn({ text: '^Close$' })
  let rows: any[] = []
  for (let i = 0; i < 20; i++) {
    rows = await query()
    if (rows.some(row => row.event_name === 'video_completed')) break
    await pause(500)
  }
  for (const event of [
    'video_started',
    'video_paused',
    'video_resumed',
    'video_seeked',
    'video_completed',
    'watch_progress'
  ])
    assert(
      rows.some(row => row.event_name === event),
      'Missing ' + event
    )
  assert(rows.every(row => row.user_id === viewer.id))
  assert.equal(new Set(rows.map(row => row.properties.ps)).size, 1)
  const watched = rows
    .filter(row => row.event_name === 'watch_progress')
    .reduce((sum, row) => sum + row.properties.ms, 0)
  assert(
    watched >= 33000 && watched <= 39000,
    'Watch time excludes pause, background and seek jumps'
  )
  console.log(
    `native: actual video pause/resume/background/seek/completion/leave, ${Math.round(watched)}ms stored; correct viewer/video and one selected session`
  )
}
