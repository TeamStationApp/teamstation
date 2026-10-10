import * as defaultSdk from '../sentrySdk'
import type { WalkUpClip, WalkUpMusicOptions } from './makeWalkUpMusic'
import type { NativeWalkUpMusicState } from './NativeWalkUpMusic'

export type MusicLogSdk = Pick<typeof defaultSdk, 'addBreadcrumb'>

/**
 * Records every clip started and every `WalkUpMusicState` report, so what a
 * phone played — positions, levels, fades — is known when something goes
 * wrong. Each report is written to the console, which is the device log.
 * Sentry keeps the ones that tell the story as breadcrumbs: each start, with
 * its handle, clip and fades; every report but `playing`, which comes every
 * 250 ms and would crowd out everything else; and the first `playing` of
 * each start, which shows the clip really began. A start is told apart by
 * its handle and its clip: a tick from the clip before can still arrive
 * after the next one is asked for. An `error` is kept at the
 * error level but sends no event of its own: the screen already shows it,
 * and the app does not report what the screen explains. Without a DSN,
 * Sentry keeps nothing.
 */
export function musicLog(
  sdk: MusicLogSdk = defaultSdk
): Required<Pick<WalkUpMusicOptions, 'onPlay' | 'onReport'>> {
  let started: WalkUpClip | undefined
  let heard = false

  return {
    onPlay: clip => {
      started = clip
      heard = false
      sdk.addBreadcrumb({
        category: 'walkUpMusic',
        level: 'info',
        message: 'WalkUpMusic play',
        data: { ...clip }
      })
    },
    onReport: report => {
      console.log(`WalkUpMusicState ${JSON.stringify(report)}`)
      if (report.kind === 'playing') {
        if (heard || !isFrom(started, report)) return
        heard = true
      }
      sdk.addBreadcrumb({
        category: 'walkUpMusic',
        level: report.kind === 'error' ? 'error' : 'info',
        message: `WalkUpMusicState ${report.kind}`,
        data: { ...report }
      })
    }
  }
}

/** How far before its start a clip's first tick may read, as a seek settles. */
const SEEK_SLACK_MS = 1000

/** Whether a `playing` report is from this clip, or from the one before. */
function isFrom(
  clip: WalkUpClip | undefined,
  report: NativeWalkUpMusicState
): boolean {
  if (clip == null) return true
  const positionMs = report.positionMs ?? 0
  return (
    report.handle === clip.handle &&
    positionMs >= clip.startMs - SEEK_SLACK_MS &&
    positionMs <= clip.endMs
  )
}
