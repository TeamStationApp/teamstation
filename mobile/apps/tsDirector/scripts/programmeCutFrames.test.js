'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { analyse, decodeRow, pictureRuns, readPictures, readTimes } = require('./programmeCutFrames')

const WIDTH = 16 * 25

function row(value) {
  const bytes = Buffer.alloc(WIDTH)
  const fill = cell => bytes.fill(255, cell * 16, (cell + 1) * 16)
  fill(0)
  for (let bit = 0; bit < 24; bit += 1) {
    if ((value >> bit) & 1) fill(bit + 1)
  }
  return bytes
}

const run = (camera, from, count) =>
  Array.from({ length: count }, (_, index) => ({ camera, frame: (from + index) % 3600 }))
const held = (camera, frame, ticks) => Array.from({ length: ticks }, () => ({ camera, frame }))

describe('decodeRow', () => {
  it('reads the camera and the frame', () => {
    assert.deepEqual(decodeRow(row((2 << 20) + 1234)), { camera: 2, frame: 1234 })
  })

  it('reads an NDI camera as camera 0', () => {
    assert.deepEqual(decodeRow(row(7)), { camera: 0, frame: 7 })
  })

  it('reads nothing without the anchor', () => {
    assert.equal(decodeRow(Buffer.alloc(WIDTH)), null)
  })
})

describe('pictureRuns', () => {
  it('counts unread pictures into the run they fall in', () => {
    const { runs, unread } = pictureRuns([{ camera: 1, frame: 1 }, null, { camera: 1, frame: 2 }])
    assert.equal(unread, 1)
    assert.deepEqual(runs.map(entry => entry.ticks), [2, 1])
  })
})

describe('analyse', () => {
  it('measures how long a cut held the outgoing picture', () => {
    const report = analyse([...run(1, 0, 60), ...held(1, 60, 15), ...run(2, 500, 60)])
    assert.equal(report.seams.length, 1)
    const [cut] = report.seams
    assert.equal(cut.kind, 'cut')
    assert.equal(cut.heldTicks, 15)
    assert.equal(cut.heldMs, 250)
    assert.equal(report.worstHeldMs, 250)
  })

  it('finds a seamless cut seamless', () => {
    const report = analyse([...run(1, 0, 60), ...run(2, 500, 60)])
    assert.equal(report.seams[0].heldTicks, 1)
  })

  it('calls a jump within a camera a jump, across the clip wrap too', () => {
    const report = analyse([...run(1, 1000, 60), ...run(1, 700, 60)])
    assert.deepEqual(report.seams.map(seam => seam.kind), ['jump'])
    assert.equal(analyse(run(1, 3590, 30)).seams.length, 0)
  })

  it('reports a camera shown for a moment between cuts as a flash', () => {
    const report = analyse([...run(1, 0, 60), ...run(2, 500, 2), ...run(1, 62, 60)])
    assert.equal(report.flashes.length, 1)
    assert.equal(report.flashes[0].camera, 2)
  })

  it('measures a hold by the pictures\' times when it has them', () => {
    const pictures = [...run(1, 0, 3), ...run(2, 500, 3)]
    const times = [0, 1 / 60, 0.5, 0.5 + 1 / 60, 0.5 + 2 / 60, 0.5 + 3 / 60]
    const report = analyse(pictures, { times })
    assert.equal(report.longestHoldMs, (0.5 - 1 / 60) * 1000)
    assert.equal(report.seams[0].heldTicks, 1)
    assert.ok(Math.abs(report.seams[0].at - 0.5 - 1 / 60) < 1e-9)
  })

  it('marks the moment of live picture before a replay', () => {
    const report = analyse([...run(1, 0, 60), ...run(2, 500, 2), ...run(2, 100, 60)])
    assert.equal(report.flashes.length, 1)
    assert.equal(report.flashes[0].beforeReplay, true)
  })

  it('reports the longest hold away from any seam apart', () => {
    const report = analyse([...run(1, 0, 30), ...held(1, 30, 9), ...run(1, 31, 30), ...run(2, 100, 30)])
    assert.equal(report.longestHoldElsewhereTicks, 9)
    assert.equal(report.seams[0].heldTicks, 1)
  })
})

describe('a video', () => {
  // Half a second of camera 1, then of camera 2, each still: its strip reads the same on every frame.
  function strip(camera, frame) {
    const value = camera * 2 ** 20 + frame
    const boxes = ['drawbox=x=0:y=0:w=400:h=16:color=black:t=fill', 'drawbox=x=0:y=0:w=16:h=16:color=white:t=fill']
    for (let bit = 0; bit < 24; bit += 1) {
      if (Math.floor(value / 2 ** bit) % 2 === 1) boxes.push(`drawbox=x=${16 * (bit + 1)}:y=0:w=16:h=16:color=white:t=fill`)
    }
    return boxes.join(',')
  }

  function clip(directory) {
    const file = path.join(directory, 'clip.mp4')
    const part = (camera, frame, name) => {
      const output = path.join(directory, name)
      execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=640x64:r=60:d=0.5',
        '-vf', strip(camera, frame), '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', output
      ])
      return output
    }
    const list = path.join(directory, 'list.txt')
    fs.writeFileSync(list, `file '${part(1, 10, 'a.mp4')}'\nfile '${part(2, 500, 'b.mp4')}'\n`)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', file])
    return file
  }

  it('reads every picture of a file, and the command line reports the cut', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'programme-cut-frames-'))
    try {
      const file = clip(directory)
      const pictures = await readPictures(file)
      assert.equal(pictures.length, 60)
      assert.equal(readTimes(file).length, 60)
      assert.deepEqual(pictures[0], { camera: 1, frame: 10 })
      assert.deepEqual(pictures[59], { camera: 2, frame: 500 })

      const json = path.join(directory, 'cuts.json')
      const output = execFileSync(process.execPath, [path.join(__dirname, 'programmeCutFrames.js'), file, '--json', json], { encoding: 'utf8' })
      assert.match(output, /cut 1->2 held 30 ticks \(500 ms\)/)
      assert.equal(JSON.parse(fs.readFileSync(json, 'utf8')).seams.length, 1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a file ffmpeg cannot read', async () => {
    await assert.rejects(readPictures('/nonexistent.mp4'), /ffmpeg exited/)
  })
})
