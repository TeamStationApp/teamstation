import { useEffect, useMemo, useState } from 'react'

import {
  CODEC_REFUSAL,
  type GameLiveStreams,
  type LiveStream
} from '../../common/api'
import { shortName } from '../../common/names'
import { lstrings, sprintf } from '../locales/strings'

/** One camera on the game, marked whether it is the caller's own. */
export interface Angle {
  stream: LiveStream
  mine: boolean
}

/** What a row does when tapped. */
export type CameraTap = 'details' | 'play' | 'rtmp' | 'camera' | 'none'

/**
 * Over: the ingest finished it, or End was pressed and the ingest has yet to
 * notice. A closing camera keeps `publishing` until then, and is over all the
 * same, since nothing can bring it back.
 */
export function isEnded(stream: LiveStream): boolean {
  return stream.state === 'ended' || stream.closesAt != null
}

/** The chip's word: Live while video arrives, Ended once it was ended. */
export function angleState(stream: LiveStream): 'live' | 'idle' | 'ended' {
  if (stream.state === 'publishing') return 'live'
  return isEnded(stream) ? 'ended' : 'idle'
}

/** An external camera's own words for what is filming, on the owner's row. */
function usingWords(stream: LiveStream): string {
  switch (stream.source) {
    case 'gopro':
      return lstrings.stream_row_using_gopro
    case 'mevo':
      return lstrings.stream_row_using_mevo
    case 'mevoStudio':
      return lstrings.stream_row_using_mevo_studio
    default:
      return lstrings.stream_row_using_rtmp
  }
}

/**
 * The line under a row's angle. An own row with no `deviceId` is external,
 * website and older Director cameras among them. Rows in `others` never carry
 * a `deviceId`, so they are told apart by `mine` and are never external. Only
 * a camera that is neither live nor over is waiting for video.
 */
export function cameraSubtitle(stream: LiveStream, mine: boolean): string {
  const waiting = angleState(stream) === 'idle'
  if (!mine) {
    const name = shortName({ id: stream.userId, displayName: stream.ownerName })
    return sprintf(
      waiting ? lstrings.stream_row_waiting : lstrings.stream_row_other,
      name
    )
  }
  if (stream.deviceId == null) return usingWords(stream)
  const model =
    stream.deviceModel == null || stream.deviceModel === ''
      ? lstrings.stream_row_a_phone
      : stream.deviceModel
  return sprintf(
    waiting ? lstrings.stream_row_waiting : lstrings.stream_row_streaming,
    model
  )
}

/**
 * Why an own camera sits idle, when the ingest turned it away for its codec.
 * From the camera's end a refusal looks like a dropped connection, so this
 * line is the only place the person learns of it.
 */
export function cameraRefusal(
  stream: LiveStream,
  mine: boolean
): string | undefined {
  if (!mine || angleState(stream) !== 'idle') return undefined
  const { lastError } = stream
  return lastError?.startsWith(CODEC_REFUSAL) === true ? lastError : undefined
}

/**
 * What a tap on a row does, first match winning: one's own ended rows open
 * Video details, whatever filmed them. Somebody else's ended rows play, when
 * there is a video to play. Own external rows open the RTMP sheet on any
 * device, and own phone rows open the camera on the phone holding them.
 */
export function cameraTap(
  stream: LiveStream,
  mine: boolean,
  myId: string | undefined
): CameraTap {
  if (isEnded(stream)) {
    if (mine) return 'details'
    return stream.playableVideoId == null ? 'none' : 'play'
  }
  if (!mine) return 'none'
  if (stream.deviceId == null) return 'rtmp'
  return stream.deviceId === myId ? 'camera' : 'none'
}

const byCreated = (one: LiveStream, two: LiveStream): number =>
  (one.createdAt ?? '').localeCompare(two.createdAt ?? '')

/**
 * The rows in the order they are drawn: the caller's own, then everybody
 * else's, each oldest first. `ended` go at the bottom of the tab, in that same
 * order.
 */
export function orderAngles(streams: GameLiveStreams | undefined): {
  active: Angle[]
  ended: Angle[]
} {
  const all: Angle[] =
    streams == null
      ? []
      : [
          ...[...streams.mine]
            .sort(byCreated)
            .map(stream => ({ stream, mine: true })),
          ...[...streams.others]
            .sort(byCreated)
            .map(stream => ({ stream, mine: false }))
        ]
  return {
    active: all.filter(({ stream }) => !isEnded(stream)),
    ended: all.filter(({ stream }) => isEnded(stream))
  }
}

/** Video is arriving and nobody has ended it. */
function isOnAir(stream: LiveStream): boolean {
  return (
    stream.state === 'publishing' &&
    stream.closesAt == null &&
    stream.publishedAt != null
  )
}

/** How long a camera on the air has run at `at`, by the clock of this phone. */
function secondsOnAir(stream: LiveStream, at: number): number {
  return isOnAir(stream)
    ? Math.max(
        0,
        Math.floor((at - Date.parse(stream.publishedAt ?? '')) / 1000)
      )
    : 0
}

/** `0:00`, `9:59`, `10:00`: hours and minutes, no seconds. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * How long a row has run, as `formatDuration` writes it, or undefined with no
 * length to show.
 *
 * A camera on the air counts from `publishedAt`, from a baseline taken each
 * time the list is read, and a second is added each second between reads with
 * nothing asked of the server. That stops once it is no longer on the air.
 * Anything else shows the video's own length, which is empty for a while after
 * a stream ends.
 */
export function useCameraDuration(
  stream: LiveStream,
  now: () => number = Date.now
): string | undefined {
  const onAir = isOnAir(stream)
  // `stream` is a new object on each list read, which is when this is read.
  const baseline = useMemo(() => secondsOnAir(stream, now()), [stream, now])
  const [counted, setCounted] = useState({ read: stream, seconds: 0 })
  useEffect(() => {
    if (!onAir) return
    const timer = setInterval(() => {
      setCounted(last => ({
        read: stream,
        seconds: last.read === stream ? last.seconds + 1 : 1
      }))
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [onAir, stream])
  if (onAir)
    return formatDuration(
      baseline + (counted.read === stream ? counted.seconds : 0)
    )
  return stream.durationSec == null
    ? undefined
    : formatDuration(stream.durationSec)
}
