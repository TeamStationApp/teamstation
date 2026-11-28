import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import { isLivePart, partTag, remuxOne } from './finishVideo'
import {
  avcParameterSetNals,
  configuredAvcInit,
  configuredInit,
  parameterSetNals
} from './frameWallFixture'

describe('what a live stream leaves behind', function () {
  it('knows a segment from a recording', function () {
    expect(isLivePart('init.mp4')).equals(true)
    expect(isLivePart('seg000000.m4s')).equals(true)
    expect(isLivePart('seg123456.m4s')).equals(true)

    // The three files a recording is made of, which must survive the sweep of
    // the parts it was built from.
    expect(isLivePart('video.mp4')).equals(false)
    expect(isLivePart('video.m3u8')).equals(false)
    expect(isLivePart('master.m3u8')).equals(false)
  })
})

describe('the tag each part of a finished recording is remuxed under (U4)', function () {
  const dir = mkdtempSync(join(tmpdir(), 'ts-part-tag-'))
  after(function () {
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(
    join(dir, 'init.mp4'),
    configuredAvcInit(avcParameterSetNals(1))
  )
  writeFileSync(
    join(dir, 'init-1.mp4'),
    configuredAvcInit(avcParameterSetNals(2))
  )
  writeFileSync(join(dir, 'hevc.mp4'), configuredInit(parameterSetNals(1)))
  writeFileSync(join(dir, 'broken.mp4'), Buffer.alloc(512))

  /** `remuxOne` with every attempt written down, the first of them failing when `fails`. */
  const tagsOf = async (
    initName: string,
    fails = false
  ): Promise<Array<string | null | undefined>> => {
    const tags: Array<string | null | undefined> = []
    await remuxOne(
      'ffmpeg',
      dir,
      join(dir, 'p.m3u8'),
      initName,
      join(dir, 'out'),
      () => {},
      undefined,
      {
        sources: async () => ({ source: 'filled', unfilled: 'unfilled' }),
        remux: async (ffmpegPath, options) => {
          tags.push(options.videoTag)
          if (fails && tags.length === 1)
            throw new Error('the filled remux failed')
        }
      }
    )
    return tags
  }

  it('tags an H.264 part avc1, on the filled and the unfilled attempt', async function () {
    expect(await tagsOf('init.mp4', true)).deep.equals(['avc1', 'avc1'])
    expect(await tagsOf('init.mp4')).deep.equals(['avc1'])
  })

  it('tags an HEVC part hvc1, and one whose init cannot be read hvc1', async function () {
    expect(await tagsOf('hevc.mp4', true)).deep.equals(['hvc1', 'hvc1'])
    expect(await tagsOf('broken.mp4')).deep.equals(['hvc1'])
    expect(await tagsOf('missing.mp4')).deep.equals(['hvc1'])
  })

  it('tags each part of an H.264 recording that changed size by its own init', async function () {
    expect(await tagsOf('init.mp4')).deep.equals(['avc1'])
    expect(await tagsOf('init-1.mp4')).deep.equals(['avc1'])
    expect(await partTag(join(dir, 'init-1.mp4'))).equals('avc1')
  })
})
