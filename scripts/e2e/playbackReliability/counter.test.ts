import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { after, before, describe, it } from 'mocha'

import {
  type CounterReading,
  judgeCounter,
  namesAngle,
  parseCounter,
  readCounter,
  readLabel,
  steadyFrom,
  withoutMisreads
} from './counter'
import { contentRect, counterBox, labelBox, LAYOUT } from './testPattern'

/** Readings every 500 ms, advancing `perStep` frames each time. */
function readings(frames: Array<number | null>): CounterReading[] {
  return frames.map((frame, index) => ({ atMs: index * 500, frame }))
}

describe('playback probe: frame counter', function () {
  this.timeout(60000)
  let dir: string

  before(function () {
    dir = mkdtempSync(join(tmpdir(), 'pbr-counter-'))
  })

  after(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the counter the pattern draws, through the layout box, on a phone-sized tile', async function () {
    // A 1920x1080 picture with the counter where the pattern puts it, scaled
    // to a portrait phone's 1179-wide tile and letterboxed 300 px down it.
    const box = LAYOUT.counter
    const picture = join(dir, 'picture.png')
    execFileSync('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080',
      '-frames:v',
      '1',
      '-vf',
      `drawbox=x=iw*${box.x}:y=ih*${box.y}:w=iw*${box.w}:h=ih*${box.h}:color=black:t=fill,` +
        `drawtext=text='0123456':fontcolor=white:fontsize=h*${box.h * 0.8}:` +
        `x=w*${box.x}+(w*${box.w}-tw)/2:y=h*${box.y}+(h*${box.h}-th)/2,` +
        'format=rgb24,scale=1179:-1,pad=1179:2000:0:300:black',
      '-y',
      picture
    ])
    const content = contentRect({
      x: 0,
      y: 0,
      w: 1179,
      h: 600 + 1179 / (16 / 9)
    })
    assert.ok(Math.abs(content.y - 300) < 0.01)
    assert.equal(
      await readCounter(picture, counterBox(content), join(dir, 'crop.png')),
      123456
    )
  })

  it("reads the angle's name the pattern draws, and says which angle it is", async function () {
    const { label } = LAYOUT
    const picture = join(dir, 'named.png')
    execFileSync('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080',
      '-frames:v',
      '1',
      '-vf',
      `drawtext=fontfile=/System/Library/Fonts/Menlo.ttc:fontcolor=white:text='Home':` +
        `fontsize=h*${label.size}:x=w*${label.x}:y=h*${label.y}:box=1:boxcolor=black@0.6,` +
        'format=rgb24,scale=1101:-1',
      '-y',
      picture
    ])
    const content = contentRect({ x: 0, y: 0, w: 1101, h: 1101 / (16 / 9) })
    const text = await readLabel(
      picture,
      labelBox(content),
      join(dir, 'name.png')
    )
    assert.equal(namesAngle(text, ['Primary', 'Home', '1st', '3rd']), 'Home')
  })

  it('names the one angle a read shows, and none for nothing or for two', function () {
    const angles = ['Primary', 'Home', '1st', '3rd']
    assert.equal(namesAngle(' 1st\n', angles), '1st')
    assert.equal(namesAngle('PRIMARY', angles), 'Primary')
    assert.equal(namesAngle('rune', angles), null)
    assert.equal(namesAngle('Home 3rd', angles), null)
  })

  it('places a picture inside a wide or a tall tile', function () {
    assert.deepEqual(contentRect({ x: 0, y: 0, w: 1600, h: 450 }), {
      x: 400,
      y: 0,
      w: 800,
      h: 450
    })
    assert.deepEqual(contentRect({ x: 10, y: 20, w: 160, h: 400 }), {
      x: 10,
      y: 175,
      w: 160,
      h: 90
    })
    const counter = counterBox({ x: 0, y: 0, w: 1000, h: 100 })
    assert.deepEqual(
      [counter.x, counter.y, counter.w, counter.h].map(
        value => Math.round(value * 1000) / 1000
      ),
      [300, 56, 400, 15]
    )
  })

  it('takes only a whole seven-digit number', function () {
    assert.equal(parseCounter(' 0001234\n'), 1234)
    assert.equal(parseCounter('000 1234'), 1234)
    assert.equal(parseCounter('12345'), null)
    assert.equal(parseCounter('9134988'), 134988)
    assert.equal(parseCounter(''), null)
  })

  it('passes a counter moving at real speed', function () {
    const verdict = judgeCounter(readings([600, 630, 660, 691, 720, 750]))
    assert.equal(verdict.pass, true)
    assert.ok(verdict.rate != null && Math.abs(verdict.rate - 1) < 0.01)
    assert.deepEqual(verdict.reasons, [])
  })

  it('fails a counter that stands still, and joins the run', function () {
    const verdict = judgeCounter(readings([600, 630, 630, 630, 660, 690]))
    assert.equal(verdict.pass, false)
    assert.deepEqual(verdict.repeats, [{ fromMs: 500, toMs: 1500, frame: 630 }])
    assert.match(
      verdict.reasons.join(),
      /stood still at frame 630 for ≥1000 ms/
    )
  })

  it('fails slow playback and a counter going backwards', function () {
    const slow = judgeCounter(readings([0, 15, 30, 45, 60]))
    assert.ok(slow.rate != null && Math.abs(slow.rate - 0.5) < 0.01)
    assert.match(slow.reasons.join(), /0\.50× real time/)
    const back = judgeCounter(readings([600, 630, 660, 690, 100, 130, 160]))
    assert.equal(back.backwards, 1)
    assert.match(back.reasons.join(), /backwards 1 times/)
  })

  it('will not pass a window it could hardly read', function () {
    const verdict = judgeCounter(readings([600, null, null, 690, null]))
    assert.equal(verdict.readable, 2)
    assert.equal(verdict.unreadable, 3)
    assert.equal(verdict.pass, false)
    assert.match(verdict.reasons.join(), /only 2 readable/)
    assert.equal(judgeCounter([]).rate, null)
  })

  it('drops a digit misread between readings that agree, as the Pixel 8 read 0003872', function () {
    const reads = [3729, 3771, 3372, 3928, 3992].map((frame, index) => ({
      atMs: index * 1000,
      frame
    }))
    assert.deepEqual(
      withoutMisreads(reads).map(read => read.frame),
      [3729, 3771, 3928, 3992]
    )
  })

  it('drops a lone misread, but not a real jump its neighbours agree on', function () {
    const reads = [0, 30, 99999, 90, 120].map((frame, index) => ({
      atMs: index * 500,
      frame
    }))
    assert.deepEqual(
      withoutMisreads(reads).map(read => read.frame),
      [0, 30, 90, 120]
    )
    const jump = [0, 30, 9000, 9030, 9060].map((frame, index) => ({
      atMs: index * 500,
      frame
    }))
    assert.equal(withoutMisreads(jump).length, 5)
    // At the ends, the line through the two readings beside it.
    const ends = [33372, 3906, 3936, 3966, 3996, 4026, 36].map(
      (frame, index) => ({ atMs: index * 500, frame })
    )
    assert.deepEqual(
      withoutMisreads(ends).map(read => read.frame),
      [3906, 3936, 3966, 3996, 4026]
    )
  })

  it('judges play from where the counter starts rising steadily', function () {
    // Landed after a drag back: the drag's last frame held, then the landing.
    const reads = [70000, 70000, 33406, 33436, 33466, 33496, 33526].map(
      (frame, index) => ({ atMs: index * 500, frame })
    )
    assert.equal(steadyFrom(reads), 2)
    const verdict = judgeCounter(reads)
    assert.equal(verdict.pass, true)
    assert.equal(verdict.backwards, 0)
    assert.equal(steadyFrom([{ atMs: 0, frame: 1 }]), 0)
  })

  it('does not count the creep as a grid lets a tile go as play, as the Pixel 8 1st angle showed', function () {
    // A second apart: six frames as the grid opened, then real speed.
    const reads = [134792, 134798, 134863, 134913, 134968, 135021, 135075].map(
      (frame, index) => ({ atMs: index * 900, frame })
    )
    assert.equal(steadyFrom(reads), 1)
    assert.equal(judgeCounter(reads).pass, true)
  })
})
