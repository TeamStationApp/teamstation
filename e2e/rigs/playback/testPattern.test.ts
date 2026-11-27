import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { DURATION_SEC, GOP_FRAMES, patternArgs } from './testPattern'

describe('playback probe: test pattern', function () {
  it('encodes the counter, the name and the clock, keyed as the uploads are', function () {
    const args = patternArgs({
      label: "1st: o'clock",
      startMs: Date.parse('2026-10-26T17:15:30.926Z'),
      durationSec: DURATION_SEC,
      out: 'out.mp4',
      fontfile: 'font.ttc'
    })
    const text = args.join(' ')
    assert.equal(GOP_FRAMES, 120)
    assert.match(text, /testsrc2=size=1920x1080:rate=60/)
    assert.match(text, /-t 5630\.3 /)
    assert.match(text, /-c:v hevc_videotoolbox -profile:v main -tag:v hvc1/)
    assert.match(text, /-g 120 /)
    assert.match(text, /drawbox=x=iw\*0\.3:y=ih\*0\.56:w=iw\*0\.4:h=ih\*0\.15/)
    assert.match(text, /%\{eif\\:n\\:d\\:7\}/)
    assert.match(text, /gmtime\\:1793034930\.926\\:/)
    assert.match(text, /text='1st\\: o'clock'/)
    assert.equal(args[args.length - 1], 'out.mp4')
  })

  it('sends it live as FLV, and encodes it with libx265 where there is no VideoToolbox', function () {
    const live = patternArgs({
      label: 'Home',
      startMs: 0,
      durationSec: 60,
      out: 'rtmp://ingest.example.test/live/key',
      fontfile: 'font.ttc'
    }).join(' ')
    assert.match(live, /^-nostdin -loglevel error -re /)
    assert.match(live, /-realtime 1/)
    assert.match(live, /-f flv rtmp:/)
    assert.doesNotMatch(live, /hvc1/)
    const stack = patternArgs({
      label: 'Home',
      startMs: 0,
      durationSec: 60,
      out: 'out.mp4',
      fontfile: 'font.ttc',
      encoder: 'libx265'
    }).join(' ')
    assert.match(stack, /-c:v libx265 -preset ultrafast/)
    assert.match(stack, /-tag:v hvc1/)
    assert.doesNotMatch(stack, /-profile:v/)
  })
})
