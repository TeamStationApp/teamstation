import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  AAC_PRIMING_SAMPLES,
  INIT_FILE,
  KEEP_STREAM_TIMES,
  remuxToHlsArgs,
  SEGMENT_FILE_PATTERN,
  VIDEO_FILE
} from './ffmpeg'

/**
 * The remux's arguments, with no FFmpeg run: what each layout asks the HLS
 * muxer for, and that everything else is the same in both.
 */
describe('remuxToHlsArgs', function () {
  const valueOf = (args: string[], flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at < 0 ? undefined : args[at + 1]
  }

  /** Every argument apart from the ones the layout chooses. */
  const shared = (args: string[]): string[] => {
    const out: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (
        [
          '-hls_flags',
          '-hls_fmp4_init_filename',
          '-start_number',
          '-hls_segment_filename'
        ].includes(args[i])
      ) {
        i++
        continue
      }
      out.push(args[i])
    }
    return out
  }

  it('writes init.mp4 and seg######.m4s by default, and when asked', function () {
    for (const args of [
      remuxToHlsArgs({ input: 'in.mov', outDir: '/tmp/out' }),
      remuxToHlsArgs({
        input: 'in.mov',
        outDir: '/tmp/out',
        layout: 'segments'
      })
    ]) {
      expect(valueOf(args, '-hls_fmp4_init_filename')).equals(INIT_FILE)
      expect(INIT_FILE).equals('init.mp4')
      expect(valueOf(args, '-start_number')).equals('0')
      expect(valueOf(args, '-hls_segment_filename')).equals(
        `/tmp/out/${SEGMENT_FILE_PATTERN}`
      )
      expect(SEGMENT_FILE_PATTERN).equals('seg%06d.m4s')
      expect(valueOf(args, '-hls_flags')).equals('independent_segments')
      expect(args.join(' ')).does.not.contain('single_file')
      expect(args.join(' ')).does.not.contain(VIDEO_FILE)
    }
  })

  it('writes one video.mp4 for the single-file layout', function () {
    for (const args of [
      remuxToHlsArgs({
        input: 'in.mov',
        outDir: '/tmp/out',
        layout: 'single-file'
      })
    ]) {
      expect(valueOf(args, '-hls_flags')).equals(
        'single_file+independent_segments'
      )
      expect(valueOf(args, '-hls_segment_filename')).equals(
        `/tmp/out/${VIDEO_FILE}`
      )
      expect(args).does.not.contain('-hls_fmp4_init_filename')
      expect(args).does.not.contain('-start_number')
    }
  })

  it('never writes temp_file, in either layout', function () {
    for (const layout of ['segments', 'single-file'] as const) {
      const args = remuxToHlsArgs({ input: 'in.mov', outDir: '/o', layout })
      expect(valueOf(args, '-hls_flags')).does.not.contain('temp_file')
    }
  })

  it('changes nothing else between the layouts', function () {
    const cases = [
      { input: 'in.mov', outDir: '/o' },
      { input: 'in.mov', outDir: '/o', videoTag: 'avc1' },
      { input: 'in.mov', outDir: '/o', videoTag: null },
      {
        input: 'in.mov',
        outDir: '/o',
        soundPrimingSamples: AAC_PRIMING_SAMPLES
      },
      { input: 'list.txt', outDir: '/o', concatList: true },
      { input: 'in.mov', outDir: '/o', segmentSeconds: 4 }
    ]
    for (const options of cases) {
      const segments = remuxToHlsArgs({ ...options, layout: 'segments' })
      const single = remuxToHlsArgs({ ...options, layout: 'single-file' })
      expect(shared(segments)).deep.equals(shared(single))
    }
  })

  it('keeps the tag, the priming, the stream times and the concat options', function () {
    const args = remuxToHlsArgs({
      input: 'list.txt',
      outDir: '/o',
      layout: 'segments',
      concatList: true,
      soundPrimingSamples: AAC_PRIMING_SAMPLES
    })
    expect(valueOf(args, '-c')).equals('copy')
    expect(valueOf(args, '-tag:v')).equals('hvc1')
    expect(valueOf(args, '-f')).equals('concat')
    expect(valueOf(args, '-bsf:v')).contains('setts=pts=PTS')
    expect(valueOf(args, '-bsf:a')).match(/^setts=ts=TS-2112\/\(SR\*TB\),setts/)
    const at = args.indexOf('-hls_segment_options')
    expect(args.slice(at, at + 2)).deep.equals([...KEEP_STREAM_TIMES])
    expect(valueOf(args, '-hls_segment_type')).equals('fmp4')
    expect(valueOf(args, '-hls_playlist_type')).equals('vod')
    expect(args[args.length - 1]).equals('/o/video.m3u8')
    expect(valueOf(args, '-master_pl_name')).equals('master.m3u8')
  })
})
