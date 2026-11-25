import { expect } from 'chai'
import { describe, it } from 'mocha'

import { probeSponsorVideo, readVideoProbe } from './probe'

describe('probeSponsorVideo', function () {
  it('reads the stream and format ffprobe names', function () {
    expect(
      readVideoProbe(
        JSON.stringify({
          streams: [
            {
              codec_name: 'h264',
              width: 640,
              height: 360,
              avg_frame_rate: '30000/1001'
            }
          ],
          format: { duration: '12.000000', bit_rate: '1200000' }
        })
      )
    ).deep.equals({
      codec: 'h264',
      width: 640,
      height: 360,
      fps: 30000 / 1001,
      durationSec: 12,
      bitRate: 1_200_000
    })
  })

  it('reads a missing rate, size or format as 0, and no stream as nothing', function () {
    expect(
      readVideoProbe(
        JSON.stringify({
          streams: [{ codec_name: 'h264', avg_frame_rate: '0/0' }]
        })
      )
    ).deep.equals({
      codec: 'h264',
      width: 0,
      height: 0,
      fps: 0,
      durationSec: 0,
      bitRate: 0
    })
    expect(
      readVideoProbe(
        JSON.stringify({
          streams: [{ codec_name: 'h264', avg_frame_rate: '25' }]
        })
      )?.fps
    ).equals(25)
    expect(
      readVideoProbe(
        JSON.stringify({
          streams: [{ codec_name: 'h264', avg_frame_rate: 'x' }]
        })
      )?.fps
    ).equals(0)
    expect(readVideoProbe(JSON.stringify({ streams: [] }))).equals(null)
    expect(readVideoProbe('not json')).equals(null)
  })

  it('refuses a file ffprobe cannot read, or one with no video, with the sentence', async function () {
    const failing = await probeSponsorVideo(
      '/nonexistent/ffmpeg',
      '/nonexistent/reel.mp4'
    ).catch((error: unknown) => (error as Error).message)
    expect(failing).equals('This video could not be read. Try another file.')
  })
})
