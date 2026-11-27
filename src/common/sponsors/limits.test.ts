import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  fitWithin,
  imageProblem,
  LOGO_BOX,
  maxBytesFor,
  REEL_BOX,
  reelProbeProblem,
  sampleProbeProblem,
  sampleSizeProblem,
  sizeProblem,
  type VideoProbe
} from './limits'

const reel: VideoProbe = {
  codec: 'h264',
  width: 640,
  height: 360,
  fps: 30,
  durationSec: 12,
  bitRate: 1_200_000
}

const sample: VideoProbe = {
  codec: 'h264',
  width: 1920,
  height: 1080,
  fps: 60,
  durationSec: 120,
  bitRate: 8_000_000
}

describe('U2 sponsor limits', function () {
  describe('reels', function () {
    it('accepts H.264 640 × 360 at 30 fps, 12 s, 1.2 Mbit/s and 2 MB', function () {
      expect(reelProbeProblem(reel, 2_000_000)).equals(null)
      // 29.97 fps, as a phone records it.
      expect(
        reelProbeProblem({ ...reel, fps: 30000 / 1001 }, 2_000_000)
      ).equals(null)
    })

    it('refuses each limit with its sentence', function () {
      const cases: Array<[Partial<VideoProbe>, number, string]> = [
        [{ codec: 'hevc' }, 2_000_000, 'Reels must be H.264 video.'],
        [{ width: 641 }, 2_000_000, 'Reels can be at most 640 × 360.'],
        [{ height: 361 }, 2_000_000, 'Reels can be at most 640 × 360.'],
        [{ fps: 30.01 }, 2_000_000, 'Reels can be at most 30 frames a second.'],
        [{ fps: 0 }, 2_000_000, 'Reels can be at most 30 frames a second.'],
        [
          { durationSec: 9.9 },
          2_000_000,
          'This reel is 9.9 seconds. Reels must be 10 to 15 seconds long.'
        ],
        [
          { durationSec: 15.1 },
          2_000_000,
          'This reel is 15.1 seconds. Reels must be 10 to 15 seconds long.'
        ],
        [{ bitRate: 1_710_000 }, 2_000_000, 'Reels can be at most 1.7 Mbit/s.'],
        [{}, 3_200_001, 'Reels can be at most 3.2 MB.']
      ]
      for (const [change, bytes, sentence] of cases)
        expect(
          reelProbeProblem({ ...reel, ...change }, bytes),
          JSON.stringify(change)
        ).equals(sentence)
      expect(reelProbeProblem(reel, 3_200_000)).equals(null)
    })
  })

  describe('samples', function () {
    it('accepts H.264 and HEVC 1920 × 1080 at 60 fps, 120 s and 120 MB', function () {
      for (const codec of ['h264', 'hevc'])
        expect(
          sampleProbeProblem({ ...sample, codec }, 120_000_000),
          codec
        ).equals(null)
    })

    it('refuses 720p, 60.1 fps, 120.1 s, another codec and 120,000,001 bytes', function () {
      expect(
        sampleProbeProblem({ ...sample, width: 1280, height: 720 }, 1000)
      ).equals('The sample video must be 1,920 × 1,080.')
      expect(sampleProbeProblem({ ...sample, fps: 60.1 }, 1000)).equals(
        'The sample video can be at most 60 frames a second.'
      )
      expect(
        sampleProbeProblem({ ...sample, durationSec: 120.1 }, 1000)
      ).equals('The sample video can be at most 2 minutes long.')
      expect(sampleProbeProblem({ ...sample, durationSec: 0 }, 1000)).equals(
        'The sample video can be at most 2 minutes long.'
      )
      expect(sampleProbeProblem({ ...sample, codec: 'vp9' }, 1000)).equals(
        'The sample video must be H.264 or HEVC.'
      )
      expect(sampleProbeProblem(sample, 120_000_001)).equals(
        'The sample video can be at most 120 MB.'
      )
    })

    it('refuses a size past 120 MB alone, before anything is read', function () {
      expect(sampleSizeProblem(120_000_000)).equals(null)
      expect(sampleSizeProblem(120_000_001)).equals(
        'The sample video can be at most 120 MB.'
      )
    })
  })

  describe('pictures', function () {
    const png = (width: number, height: number) =>
      ({ type: 'image/png', width, height }) as const
    const jpeg = (width: number, height: number) =>
      ({ type: 'image/jpeg', width, height }) as const

    it('takes PNG logos within 480 × 270 and at most 1 MB', function () {
      expect(imageProblem('logo', png(480, 270), 1000)).equals(null)
      expect(imageProblem('logo', png(481, 270), 1000)).equals(
        'Logos can be at most 480 × 270 pixels.'
      )
      expect(imageProblem('logo', png(480, 271), 1000)).equals(
        'Logos can be at most 480 × 270 pixels.'
      )
      expect(imageProblem('logo', jpeg(100, 100), 1000)).equals(
        'Logos must be PNG files.'
      )
      expect(imageProblem('logo', null, 1000)).equals(
        'Logos must be PNG files.'
      )
      expect(imageProblem('logo', png(10, 10), 1_000_001)).equals(
        'Logos can be at most 1 MB.'
      )
    })

    it('takes 128 × 128 row logos and backgrounds within 1920 × 224, JPEG or PNG', function () {
      expect(imageProblem('rowLogo', jpeg(128, 128), 1000)).equals(null)
      expect(imageProblem('rowLogo', png(128, 128), 1000)).equals(null)
      expect(imageProblem('rowLogo', png(100, 100), 1000)).equals(
        'Row logos must be 128 × 128 pixels.'
      )
      expect(imageProblem('rowBackground', jpeg(1920, 224), 1000)).equals(null)
      expect(imageProblem('rowBackground', jpeg(1921, 224), 1000)).equals(
        'Backgrounds can be at most 1,920 × 224 pixels.'
      )
      expect(imageProblem('rowBackground', null, 1000)).equals(
        'Images must be JPEG or PNG.'
      )
      expect(imageProblem('rowBackground', jpeg(10, 10), 4_000_001)).equals(
        'Images can be at most 4 MB.'
      )
    })

    it("caps each purpose's bytes", function () {
      expect(maxBytesFor('logo')).equals(1_000_000)
      expect(maxBytesFor('reel')).equals(3_200_000)
      expect(maxBytesFor('rowLogo')).equals(4_000_000)
      expect(maxBytesFor('rowBackground')).equals(4_000_000)
      expect(sizeProblem('reel', 3_200_000)).equals(null)
      expect(sizeProblem('rowLogo', 4_000_001)).equals(
        'Images can be at most 4 MB.'
      )
    })
  })

  describe('fitting', function () {
    it('scales down to fit, keeping the aspect ratio, each side even', function () {
      expect(fitWithin(3840, 2160, REEL_BOX)).deep.equals({
        width: 640,
        height: 360
      })
      expect(fitWithin(1080, 1920, REEL_BOX)).deep.equals({
        width: 202,
        height: 360
      })
      expect(fitWithin(400, 200, LOGO_BOX)).deep.equals({
        width: 400,
        height: 200
      })
      expect(fitWithin(960, 540, LOGO_BOX)).deep.equals({
        width: 480,
        height: 270
      })
      // Never below 2 a side, however thin.
      expect(fitWithin(10_000, 1, LOGO_BOX)).deep.equals({
        width: 480,
        height: 2
      })
    })
  })
})
