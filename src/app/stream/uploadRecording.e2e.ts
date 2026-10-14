// E16: Upload Recording replaces the angle's live copy, and carries on after
// the app is killed part way. Run after E15 (twoDevices.e2e.ts), on the phone
// that recorded the angle. Through maestro-d's JavaScript client; the shared
// environment is in phoneStreamRig.e2e.ts. Besides it:
//
//   TS_STREAM_ANDROID_SERIAL=<the Pixel 10>, or TS_STREAM_IOS_UDID=<an iPhone
//     or its simulator> when there is no Pixel
//   [TS_STREAM_ANGLE=<the angle that phone recorded, First Base>]
//   [TS_STREAM_KILL_AT=<the upload's percentage at which the app is stopped, 30;
//     past the first 32 MB part's share, so the server holds a part to resume
//     from>]
//   [TS_STREAM_OTHER_IOS_UDID=<the other phone, which must stop showing
//     "not uploaded">]
//   [DIRECTOR_DEVICE_UDID=<the iPad Pro M4 running Director>]
//     node -r sucrase/register src/app/stream/uploadRecording.e2e.ts
//
//   1. Slide to Stop, then Close.
//   2. Upload Recording and its caption show; tap it.
//   3. At TS_STREAM_KILL_AT %, stopApp; launchApp and open the game: the
//      progress shows again (upload-recording-progress.png) at the share the
//      server already holds, above 0%, and rises at least twice, never going
//      back, until the row goes.
//   4. "…" on Center Field, then End. With Director on the iPad, after 60 s
//      no new Center Field stream exists, and Director stays off the air until
//      it is uploaded from Director's Upload menu and started again by hand,
//      which this waits for (step 5: a fresh Center Field stream id).
//   Expect: the angle's stream is replaced (`localRecording` "uploaded"); the
//   game's video for the angle is a new one, which ffprobe reads at its
//   playback URL (HEVC 1920×1080); the other phone shows no "not uploaded".
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  apiToken,
  cameras,
  game,
  optional,
  Phone,
  probePlayback,
  request,
  required,
  say,
  sleep,
  type StreamRow
} from './phoneStreamRig.e2e'

const run = promisify(execFile)
const CENTER = 'Center Field'

interface GameVideo {
  id: string
  title: string
}

async function gameVideos(token: string): Promise<GameVideo[]> {
  const answer = await request('GET', `/games/${game()}`, undefined, token)
  return ((await answer.json()) as { videos?: GameVideo[] }).videos ?? []
}

/** The percentage the upload row shows, or null once there is none. */
async function progressOf(phone: Phone, id: string): Promise<number | null> {
  const node = (await phone.nodes()).find(
    one => one.id === `upload-progress-${id}`
  )
  const match = /(\d+)%/.exec(node?.text ?? '')
  return match == null ? null : Number(match[1])
}

async function main(): Promise<void> {
  const email = required('TS_STREAM_EMAIL')
  const token = await apiToken(email)
  const angle = optional('TS_STREAM_ANGLE') ?? 'First Base'
  const killAt = Number(optional('TS_STREAM_KILL_AT') ?? '30')
  const serial = optional('TS_STREAM_ANDROID_SERIAL')
  const phone =
    serial != null
      ? await Phone.attach(serial, 'android')
      : await Phone.attach(required('TS_STREAM_IOS_UDID'), 'ios')
  const results: string[] = []
  try {
    // 1. Stop and close, or open the game when the camera is not up.
    if ((await phone.find(node => node.id === 'camera-screen', 3000)) != null) {
      await phone.stopAndClose()
    } else {
      await phone.launch()
      await phone.signInIfAsked(email)
      await phone.openGame()
    }
    const stream = (await cameras(token)).mine.find(row => row.label === angle)
    assert(stream != null, `${angle} is on the game`)
    const liveVideo = stream.videoId
    results.push(
      `1 stopped and closed ${angle} (${stream.id}, live video ${liveVideo ?? '-'})`
    )

    // 2. Upload Recording.
    const rowId = `upload-row-${stream.id}`
    const button = `upload-recording-${stream.id}`
    await phone.scrollTo({ id: button })
    say('$ assertVisible Upload Recording')
    const pressable = await phone.find(node => node.id === button, 5000)
    assert(
      pressable != null &&
        (await phone.textsOf(button)).includes('Upload Recording'),
      'Upload Recording shows'
    )
    const caption = 'Provide a higher-quality copy for future viewing.'
    say(`$ assertVisible ${caption}`)
    assert(
      (await phone.find(node => node.text === caption, 5000)) != null,
      'its caption shows'
    )
    say(`$ tapOn upload-recording-${stream.id}`)
    await phone.m.tapOn({ id: `upload-recording-${stream.id}` })
    const first = await phone.find(
      node => node.id === `upload-progress-${stream.id}`,
      15000
    )
    assert(first != null, 'the progress shows')
    // The screenshot waits for the relaunch: a short take's upload can pass
    // the cut-off point while one is taken.
    results.push(`2 Upload Recording pressed: “${first.text ?? ''}”`)

    // 3. Cut off part way, then carried on.
    let seen = 0
    let uploading = false
    for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
      const node = (await phone.nodes()).find(
        one => one.id === `upload-progress-${stream.id}`
      )
      if (node == null) break
      const match = /(\d+)%/.exec(node.text ?? '')
      seen = match == null ? seen : Number(match[1])
      uploading = node.text?.startsWith('Uploading') === true
      if (uploading && seen >= killAt) break
    }
    assert(
      uploading && seen < 100,
      `the upload was caught part way (last seen ${seen}%)`
    )
    say(`$ stopApp (at “Uploading ${seen}%”)`)
    await phone.m.stopApp({ appId: 'app.teamstation.app' })
    await sleep(3000)
    await phone.launch()
    await phone.signInIfAsked(email)
    await phone.openGame()
    // Android's hierarchy holds only what is on screen, and the upload row
    // sits below the cameras: scroll to the row itself there.
    await phone.scrollTo(
      phone.platform === 'android' ? { id: rowId } : { text: 'CAMERAS' }
    )
    await phone.find(node => node.id === `upload-progress-${stream.id}`, 15000)
    const resumed = await progressOf(phone, stream.id)
    say(`$ assertVisible upload-progress-${stream.id}: ${resumed ?? 'none'}%`)
    assert(resumed != null, 'the progress shows again after the relaunch')
    // Resumed at launch, the upload has already said where it stands; the row
    // reads that, not 0% until the next part lands.
    assert(
      resumed > 0,
      `the relaunched row starts where the upload stands, not at 0% (stopped at ${seen}%; stop past the first part)`
    )
    await phone.scrollTo({ id: `upload-progress-${stream.id}` })
    await phone.shot('upload-recording-progress.png')
    const marks: string[] = [`${resumed}%`]
    const climb: number[] = [resumed]
    for (const until = Date.now() + 15 * 60000; ;) {
      const now = await progressOf(phone, stream.id)
      if (
        now == null &&
        (await phone.find(
          node => node.id === button || node.id === `upload-retry-${stream.id}`,
          0
        )) == null
      )
        break
      if (now != null && marks.at(-1) !== `${now}%`) {
        marks.push(`${now}%`)
        climb.push(now)
      }
      assert(Date.now() < until, 'the upload landed')
      await sleep(1000)
    }
    say(`$ assertNotVisible ${rowId} (no progress, button or Retry)`)
    // It moves within a part, so a part of a slow uplink shows the bar
    // climbing rather than sitting still and then jumping.
    const rises = climb.filter(
      (value, index) => index > 0 && value > climb[index - 1]
    ).length
    assert(
      climb.every((value, index) => index === 0 || value >= climb[index - 1]),
      `the progress never goes back: ${marks.join(' → ')}`
    )
    assert(
      rises >= 2 && climb.filter(value => value < 100).length >= 3,
      `the progress rises at least twice before it completes: ${marks.join(' → ')}`
    )
    results.push(
      `3 stopApp at ${seen}%; after launchApp the row read ${marks.join(' → ')}, then went`
    )

    // 4. End Center Field from the phone.
    const center = (await cameras(token)).mine.find(
      row => row.label === CENTER && row.state !== 'ended'
    )
    const director = optional('DIRECTOR_DEVICE_UDID')
    if (center != null) {
      await phone.scrollTo({ id: `angle-more-${center.id}` })
      say(`$ tapOn angle-more-${center.id}`)
      await phone.m.tapOn({ id: `angle-more-${center.id}` })
      say('$ tapOn stream-action-end')
      await phone.m.tapOn({ id: 'stream-action-end' })
      if (
        (await phone.find(node => node.text === 'Tap again: End', 2000)) != null
      ) {
        say('$ tapOn stream-action-end (again, it is live)')
        await phone.m.tapOn({ id: 'stream-action-end' })
      }
      await sleep(3000)
      const ended = (await cameras(token)).mine.find(
        row => row.id === center.id
      )
      say(`server: ${CENTER} ${center.id} ${ended?.state ?? 'gone'}`)
      if (director != null) {
        await sleep(60000)
        const again = (await cameras(token)).mine.filter(
          row => row.label === CENTER && row.id !== center.id
        )
        assert.deepEqual(again, [], 'Director stays off the air after End')
        say(
          `upload the take from Director's Upload menu, then tap Start Streaming once; waiting for a fresh ${CENTER}`
        )
        let fresh: StreamRow | undefined
        for (const until = Date.now() + 20 * 60000; fresh == null;) {
          fresh = (await cameras(token)).mine.find(
            row =>
              row.label === CENTER &&
              row.id !== center.id &&
              row.state === 'publishing'
          )
          assert(Date.now() < until, 'Director went live again')
          await sleep(3000)
        }
        results.push(
          `4-5 End kept Director off the air for 60 s; it came back on a fresh stream ${fresh.id}`
        )
      } else {
        results.push(
          `4 “…” → End on ${CENTER}: ${ended?.state ?? 'gone'} (no iPad: Director's half not run)`
        )
      }
    }

    // What the server and the player now have.
    const after = (await cameras(token)).mine.find(row => row.id === stream.id)
    say(
      `server: ${angle} ${stream.id} ${after?.state ?? 'not listed'} ${after?.localRecording ?? ''}`
    )
    const videos = (await gameVideos(token)).filter(video =>
      video.title.endsWith(` — ${angle}`)
    )
    say(
      `game videos for ${angle}: ${videos.map(video => `${video.id} “${video.title}”`).join(', ')}`
    )
    assert.equal(videos.length, 1, `one video for ${angle}`)
    assert.notEqual(videos[0].id, liveVideo, 'the live copy was replaced')
    const { url, probe } = await probePlayback(token, videos[0].id)
    say(probe)
    assert(probe.includes('codec_name=hevc'), 'the uploaded copy is HEVC')
    assert(probe.includes('width=1920|height=1080'), 'and 1920×1080')
    results.push(
      `5 ${angle} plays ${videos[0].id} (live copy ${liveVideo ?? '-'} replaced): ${probe.split('\n').join(' ; ')}`
    )
    const dir = optional('TS_STREAM_ARTIFACT_DIR')
    if (dir != null) {
      say('$ ffmpeg -i <playback URL> -t 60 -c copy uploaded-replacement.mp4')
      await run(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-i',
          url,
          '-t',
          '60',
          '-c',
          'copy',
          path.join(dir, 'uploaded-replacement.mp4')
        ],
        { timeout: 180000 }
      )
    }

    // The other phone no longer says the recording is not uploaded.
    const otherUdid = optional('TS_STREAM_OTHER_IOS_UDID')
    const observer =
      otherUdid == null ? phone : await Phone.attach(otherUdid, 'ios')
    if (observer !== phone) {
      await observer.launch()
      await observer.openGame()
    }
    await sleep(6000)
    const row = await observer.textsOf(`angle-row-${stream.id}`)
    say(`$ assertNotVisible “not uploaded” on ${angle} (its row: “${row}”)`)
    assert(!row.includes('not uploaded'), 'no “not uploaded” for the angle')
    results.push(
      `6 ${observer === phone ? 'this phone' : 'the other phone'} shows no “not uploaded” for ${angle}`
    )
    if (observer !== phone) await observer.detach()
  } finally {
    await phone.detach()
  }
  for (const line of results) say(`PASS ${line}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
