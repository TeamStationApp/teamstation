import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  assembleParts,
  failureToShow,
  isComplete,
  liveToReplace,
  missingParts,
  PART_SIZE,
  partBytes,
  partCount,
  partIndexOf,
  partName,
  purgeDateFor,
  receivedBytes,
  receivedParts,
  recordingStart,
  startOf
} from './uploads'

describe('a take arriving in parts', function () {
  it('cuts a two-hour recording into a sane number of them', function () {
    // Nine gigabytes, which is what two hours of programme output comes to.
    const nineGB = 9 * 1024 * 1024 * 1024
    expect(partCount(nineGB)).equals(288)
  })

  it('makes the last part the short one', function () {
    const size = PART_SIZE * 2 + 100
    expect(partCount(size)).equals(3)
    expect(partBytes(0, size)).equals(PART_SIZE)
    expect(partBytes(2, size)).equals(100)
  })

  it('has nothing to say about a part that is not in the file', function () {
    expect(partBytes(9, PART_SIZE)).equals(0)
    expect(partBytes(-1, PART_SIZE)).equals(0)
  })

  it('counts an empty file as no parts rather than one', function () {
    expect(partCount(0)).equals(0)
    expect(isComplete([], 0)).equals(false)
  })
})

describe('resuming an upload that was cut off', function () {
  it('asks for what is missing, in sending order', function () {
    expect(missingParts([0, 1, 4], 6)).deep.equals([2, 3, 5])
  })

  it('is complete only when every part is there', function () {
    expect(isComplete([0, 1, 2], 3)).equals(true)
    expect(isComplete([0, 2], 3)).equals(false)
    // The failure this guards: a hole in the middle, assembled into a
    // recording that plays until it does not.
    expect(isComplete([0, 1, 1], 3)).equals(false)
  })

  it('names parts so a directory listing is sending order', function () {
    expect(partName(7)).equals('part-000007')
    expect([partName(10), partName(2)].sort()).deep.equals([
      'part-000002',
      'part-000010'
    ])
    expect(partIndexOf('part-000010')).equals(10)
    expect(partIndexOf('video.mp4')).equals(null)
  })
})

describe('what the disk says has arrived', function () {
  let dir = ''
  beforeEach(async function () {
    dir = await mkdtemp(join(tmpdir(), 'gsUploadTest-'))
  })
  afterEach(async function () {
    await rm(dir, { recursive: true, force: true })
  })

  it('counts the parts that are really there, and ignores anything else', async function () {
    await writeFile(join(dir, partName(0)), 'aaaa')
    await writeFile(join(dir, partName(2)), 'bb')
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    expect(await receivedParts(dir)).deep.equals([0, 2])
    expect(await receivedBytes(dir)).equals(6)
  })

  it('says nothing arrived for a directory that is not there', async function () {
    expect(await receivedParts(join(dir, 'nope'))).deep.equals([])
  })

  it('joins the parts in order, whatever order they landed in', async function () {
    await writeFile(join(dir, partName(2)), 'three')
    await writeFile(join(dir, partName(0)), 'one')
    await writeFile(join(dir, partName(1)), 'two')
    const into = join(dir, 'whole.mov')
    const size = await assembleParts({ dir, total: 3, into })
    expect(size).equals('onetwothree'.length)
  })

  it('refuses to assemble a recording with a hole in it', async function () {
    await writeFile(join(dir, partName(0)), 'one')
    await writeFile(join(dir, partName(2)), 'three')
    let threw = ''
    try {
      await assembleParts({ dir, total: 3, into: join(dir, 'whole.mov') })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    expect(threw).contains('1 parts missing')
  })
})

describe('what an upload replaces', function () {
  const HOUR = 3600
  const game = [
    { id: 'vid_live', kind: 'live', hidden: false, durationSec: 2 * HOUR },
    { id: 'vid_camera', kind: 'program', hidden: false, durationSec: 2 * HOUR },
    {
      id: 'vid_mosaic',
      kind: 'combined',
      hidden: false,
      durationSec: 2 * HOUR
    },
    { id: 'vid_upload', kind: 'program', hidden: false, durationSec: 2 * HOUR }
  ]

  it('takes the place of the live stream, and nothing else', function () {
    expect(liveToReplace(game, 'vid_upload', 2 * HOUR)).deep.equals([
      'vid_live'
    ])
  })

  it('never itself', function () {
    const live = [
      { id: 'vid_upload', kind: 'live', hidden: false, durationSec: HOUR }
    ]
    expect(liveToReplace(live, 'vid_upload', HOUR)).deep.equals([])
  })

  it('leaves a recording that is already hidden alone', function () {
    // Its purge clock may be nearly up; starting it again would keep paying
    // for a copy on no page.
    const hidden = [
      { id: 'vid_live', kind: 'live', hidden: true, durationSec: HOUR }
    ]
    expect(liveToReplace(hidden, 'vid_upload', HOUR)).deep.equals([])
  })

  it('will not let a clip displace a whole game', function () {
    // What actually happened: a 107-second bench recording uploaded to a game
    // hid its two-hour live recording and dated it for deletion. The claim an
    // upload makes is "a better copy of the same game", and this is not one.
    expect(liveToReplace(game, 'vid_upload', 107)).deep.equals([])
  })

  it('allows the couple of minutes a stream is ordinarily short by', function () {
    // The stream is started after the recording and stopped before it, so the
    // upload being a little longer — or a little shorter — is the normal case.
    expect(liveToReplace(game, 'vid_upload', 2 * HOUR - 90)).deep.equals([
      'vid_live'
    ])
    expect(liveToReplace(game, 'vid_upload', 2 * HOUR + 600)).deep.equals([
      'vid_live'
    ])
  })

  it('replaces nothing when either length is unknown', function () {
    // With nothing to compare there is no evidence the upload covers the
    // stream, and hiding a game's only recording is not a thing to guess at.
    const unknown = [
      { id: 'vid_live', kind: 'live', hidden: false, durationSec: null }
    ]
    expect(liveToReplace(unknown, 'vid_upload', 2 * HOUR)).deep.equals([])
    expect(liveToReplace(game, 'vid_upload', null)).deep.equals([])
  })
})

describe('when a replaced recording goes', function () {
  it('is thirty days after it was replaced', function () {
    const now = new Date('2026-09-21T00:00:00.000Z')
    expect(purgeDateFor(now).toISOString()).equals('2026-10-21T00:00:00.000Z')
  })
})

describe('when the recording an upload carries began', function () {
  const now = new Date('2026-09-21T20:00:00.000Z')

  it('is what the app said, whenever the upload happened', function () {
    const said = recordingStart('2026-09-20T19:16:49.000Z', now)
    expect(said?.toISOString()).equals('2026-09-20T19:16:49.000Z')
  })

  it('takes a take that sat on the iPad for a fortnight', function () {
    expect(recordingStart('2026-09-07T19:16:49.000Z', now)).not.equals(null)
  })

  it('refuses what is not an instant, rather than guessing', function () {
    // A wrong start is worse than none: the library lays a take's cameras out
    // against it.
    expect(recordingStart('yesterday afternoon', now)).equals(null)
    expect(recordingStart('', now)).equals(null)
    expect(recordingStart(undefined, now)).equals(null)
    expect(recordingStart('1970-01-01T00:00:00.000Z', now)).equals(null)
  })

  it('places the video where the app said, not when the upload was opened', function () {
    // The bug this exists for: two cameras of one take, sent one after the
    // other, must land on the same instant however far apart they were sent.
    const game = new Date('2026-09-20T19:15:00.000Z')
    const began = new Date('2026-09-20T19:16:49.000Z')
    expect(startOf(began, game).toISOString()).equals(
      '2026-09-20T19:16:49.000Z'
    )
    expect(startOf(began.toISOString(), game).toISOString()).equals(
      '2026-09-20T19:16:49.000Z'
    )
  })

  it('falls back to the game, for an app too old to say', function () {
    const game = new Date('2026-09-20T19:15:00.000Z')
    expect(startOf(null, game).toISOString()).equals('2026-09-20T19:15:00.000Z')
    expect(startOf('not a date', game).toISOString()).equals(
      '2026-09-20T19:15:00.000Z'
    )
  })
})

describe('what an operator is told about a conversion that failed', function () {
  it('keeps the sentence and drops the server’s paths', function () {
    const said = failureToShow(
      new Error(
        'ffprobe exited 1: /srv/GameStation_multiCamera/uploads/dup_x/whole: Invalid data found when processing input\n' +
          'Command: /srv/gamestation/bin/ffprobe -v error -show_entries stream=codec_type'
      )
    )
    expect(said).contains('Invalid data found')
    expect(said).does.not.contain('/srv/')
    expect(said).does.not.contain('dup_x')
  })

  it('never hands back an empty message', function () {
    expect(failureToShow(new Error('   '))).equals(
      'That recording could not be taken in.'
    )
  })

  it('takes something that is not an error at all', function () {
    expect(failureToShow('no video stream')).equals('no video stream')
  })
})
