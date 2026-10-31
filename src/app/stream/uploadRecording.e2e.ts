// E16: Upload Recording replaces the angle's live copy, and carries on after
// the app is killed part way. Run after E15 (twoDevices.e2e.ts), on the phone
// that recorded the angle. Through maestro-d's JavaScript client; the shared
// environment is in phoneStreamRig.e2e.ts. Besides it:
//
//   TS_STREAM_ANDROID_SERIAL=<the Pixel 10>, or TS_STREAM_IOS_UDID=<an iPhone
//     or its simulator> when there is no Pixel
//   [TS_STREAM_ANGLE=<the angle that phone recorded, First Base>]
//   [TS_STREAM_OTHER_ANGLE=<another phone's angle, whose live copy stays, Home Plate>]
//   [TS_STREAM_KILL_AT=<the upload's percentage at which the app is stopped, 30;
//     past the first 32 MB part's share, so the server holds a part to resume
//     from>]
//   [TS_STREAM_OTHER_IOS_UDID=<the other phone, which must stop showing
//     "not uploaded">]
//   [DIRECTOR_DEVICE_UDID=<the iPad Pro M4 running Director>]
//   [TS_STREAM_FAST_UPLINK=1, when the upload outruns the relaunch: step 3 then
//     asks only that the progress shows again and never goes back]
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
//   Expect: the angle's stream stays listed as an ended row whose local
//   recording is `uploaded`, and playing it plays the upload; the game's
//   video for the angle is a new one, which ffprobe reads at its playback URL
//   as HEVC 1920×1080 at about 6 Mbit/s with no gap of more than a frame
//   between its pictures; the other angle's live copy (TS_STREAM_OTHER_ANGLE,
//   Home Plate) is still on the game; the other phone shows no "not
//   uploaded".
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

/** The recording's bitrate, which ProgramEncoder writes at 6 Mbit/s. */
const RECORDING_MBIT = 6

/**
 * The longest step between two pictures of a video at `url`, against its
 * usual step, from the packets ffprobe reads there (no decoding).
 */
/**
 * The file a playback URL plays. A ready video is served as HLS: one fMP4
 * file cut into byte ranges, of which ffmpeg's HLS reader reads only the
 * first (180 pictures of a 90 s upload), so the file itself, the media
 * playlist's EXT-X-MAP, is read instead.
 */
async function wholeFile(playback: string): Promise<string> {
  const master = await (await fetch(playback)).text()
  if (!master.startsWith('#EXTM3U')) return playback
  const mediaLine = master
    .split('\n')
    .find(line => line.trim() !== '' && !line.startsWith('#'))
  assert(mediaLine != null, 'the HLS playlist names its media playlist')
  const mediaUrl = new URL(mediaLine.trim(), playback).toString()
  const media = await (await fetch(mediaUrl)).text()
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(media)?.[1]
  assert(map != null, 'the media playlist names its file')
  return new URL(map, mediaUrl).toString()
}

/**
 * The picture packets of the playback URL: how many, the usual step and the
 * longest one between them, and their bit rate. Read from the packets because
 * the URL can be an HLS playlist, whose `format=bit_rate` is the playlist's.
 */
async function longestStep(
  playback: string
): Promise<{ frames: number; step: number; longest: number; mbit: number }> {
  const url = await wholeFile(playback)
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,size',
      '-of',
      'csv=p=0',
      url
    ],
    { timeout: 600000, maxBuffer: 1 << 28 }
  )
  const packets = stdout
    .split('\n')
    .map(line => line.split(',').map(Number))
    .filter(([time, size]) => Number.isFinite(time) && Number.isFinite(size))
  const times = packets.map(([time]) => time).sort((a, b) => a - b)
  const bytes = packets.reduce((sum, [, size]) => sum + size, 0)
  assert(times.length > 1, 'the uploaded copy has pictures')
  const steps = times.slice(1).map((time, index) => time - times[index])
  const step = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]
  const span = times[times.length - 1] - times[0] + step
  return {
    frames: times.length,
    step,
    longest: Math.max(...steps),
    mbit: (bytes * 8) / span / 1e6
  }
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
    // A local network can land every byte within the relaunch.
    if (optional('TS_STREAM_FAST_UPLINK') == null)
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
    const { frames, step, longest, mbit: bitRate } = await longestStep(url)
    say(
      `$ ffprobe -show_entries packet=pts_time,size: ${frames} pictures, step ${(step * 1000).toFixed(1)} ms, longest ${(longest * 1000).toFixed(1)} ms, ${bitRate.toFixed(2)} Mbit/s`
    )
    assert(
      bitRate >= RECORDING_MBIT * 0.75 && bitRate <= RECORDING_MBIT * 1.25,
      `the uploaded copy is about ${RECORDING_MBIT} Mbit/s (${bitRate.toFixed(2)})`
    )
    assert(
      longest <= step * 2 + 0.001,
      `no gap of more than a frame in the uploaded copy (longest step ${(longest * 1000).toFixed(1)} ms)`
    )
    // A replaced camera is an ordinary ended row, playing its upload.
    assert.equal(after?.state, 'ended', 'the replaced camera stays listed')
    assert.equal(after?.localRecording, 'uploaded', 'as uploaded')
    const other = optional('TS_STREAM_OTHER_ANGLE') ?? 'Home Plate'
    const others = (await gameVideos(token)).filter(video =>
      video.title.endsWith(` — ${other}`)
    )
    assert(
      others.length > 0,
      `${other}'s live copy is still on the game: only ${angle}'s was replaced`
    )
    results.push(
      `5 ${angle} plays ${videos[0].id} (live copy ${liveVideo ?? '-'} replaced, stream ${stream.id} ended): ${probe.split('\n').join(' ; ')}; ${bitRate.toFixed(2)} Mbit/s; ${frames} pictures, longest step ${(longest * 1000).toFixed(1)} ms; ${other} still has ${others.map(video => video.id).join(', ')}`
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
