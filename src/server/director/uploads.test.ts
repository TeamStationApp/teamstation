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
    dir = await mkdtemp(join(tmpdir(), 'tsUploadTest-'))
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
  /** The stream went live here. */
  const T0 = Date.parse('2026-09-20T18:00:00.000Z')
  const at = (sec: number): Date => new Date(T0 + sec * 1000)
  const live = {
    id: 'vid_live',
    kind: 'live',
    hidden: false,
    startAt: at(0),
    durationSec: 2 * HOUR
  }
  const game = [
    live,
    {
      id: 'vid_camera',
      kind: 'program',
      hidden: false,
      startAt: at(0),
      durationSec: 2 * HOUR
    },
    {
      id: 'vid_mosaic',
      kind: 'combined',
      hidden: false,
      startAt: at(0),
      durationSec: 2 * HOUR
    }
  ]
  /** An upload from `startSec` to `endSec` on the stream's clock. */
  const upload = (
    startSec: number,
    endSec: number
  ): { startAt: Date; durationSec: number } => ({
    startAt: at(startSec),
    durationSec: endSec - startSec
  })

  it('takes the place of the live stream, and nothing else', function () {
    expect(liveToReplace(game, 'vid_upload', upload(0, 2 * HOUR))).deep.equals([
      'vid_live'
    ])
  })

  it('covers a stream that went live long before the recording started', function () {
    // The game that showed it: the stream went live 28 minutes before the
    // iPad started recording, and both stopped together. Comparing lengths
    // left the stream on the page and made it the game's default.
    expect(
      liveToReplace(game, 'vid_upload', upload(28 * 60, 2 * HOUR))
    ).deep.equals(['vid_live'])
  })

  it('does not cover a stream it stops three minutes short of', function () {
    expect(
      liveToReplace(game, 'vid_upload', upload(0, 2 * HOUR - 180))
    ).deep.equals([])
  })

  it('allows the couple of minutes either way a stream ordinarily ends by', function () {
    expect(
      liveToReplace(game, 'vid_upload', upload(0, 2 * HOUR - 120))
    ).deep.equals(['vid_live'])
    expect(
      liveToReplace(game, 'vid_upload', upload(0, 2 * HOUR - 121))
    ).deep.equals([])
    expect(
      liveToReplace(game, 'vid_upload', upload(0, 2 * HOUR + 120))
    ).deep.equals(['vid_live'])
    // A recording left running after the stream stopped still has it all.
    expect(
      liveToReplace(game, 'vid_upload', upload(-600, 2 * HOUR + 1800))
    ).deep.equals(['vid_live'])
  })

  it('does not cover a stream it starts after', function () {
    expect(
      liveToReplace(game, 'vid_upload', upload(2 * HOUR, 3 * HOUR))
    ).deep.equals([])
    expect(
      liveToReplace(game, 'vid_upload', upload(2 * HOUR + 60, 2 * HOUR + 90))
    ).deep.equals([])
  })

  it('will not let a clip displace a whole game', function () {
    // What actually happened: a 107-second bench recording uploaded to a game
    // hid its two-hour live recording and dated it for deletion. The claim an
    // upload makes is "a better copy of the same game", and this is not one.
    expect(liveToReplace(game, 'vid_upload', upload(600, 707))).deep.equals([])
  })

  it('never itself', function () {
    const self = [{ ...live, id: 'vid_upload' }]
    expect(liveToReplace(self, 'vid_upload', upload(0, 2 * HOUR))).deep.equals(
      []
    )
  })

  it('leaves a recording that is already hidden alone', function () {
    // Its purge clock may be nearly up; starting it again would keep paying
    // for a copy on no page.
    const hidden = [{ ...live, hidden: true }]
    expect(
      liveToReplace(hidden, 'vid_upload', upload(0, 2 * HOUR))
    ).deep.equals([])
  })

  it('replaces nothing when a start or a length is unknown', function () {
    // With nothing to compare there is no evidence the upload covers the
    // stream, and hiding a game's only recording is not a thing to guess at.
    const whole = upload(0, 2 * HOUR)
    for (const unknown of [
      { ...live, durationSec: null },
      { ...live, durationSec: 0 },
      { ...live, startAt: null },
      { ...live, startAt: 'not a time' }
    ]) {
      expect(liveToReplace([unknown], 'vid_upload', whole)).deep.equals([])
    }
    expect(liveToReplace(game, 'vid_upload', null)).deep.equals([])
    expect(
      liveToReplace(game, 'vid_upload', { ...whole, durationSec: null })
    ).deep.equals([])
    expect(
      liveToReplace(game, 'vid_upload', { ...whole, startAt: undefined })
    ).deep.equals([])
  })

  it('reads a start written as text', function () {
    const text = [{ ...live, startAt: at(0).toISOString() }]
    expect(
      liveToReplace(text, 'vid_upload', {
        startAt: at(60).toISOString(),
        durationSec: 2 * HOUR
      })
    ).deep.equals(['vid_live'])
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
        'ffprobe exited 1: /srv/TeamStation_multiCamera/uploads/dup_x/whole: Invalid data found when processing input\n' +
          'Command: /srv/teamstation/bin/ffprobe -v error -show_entries stream=codec_type'
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
