import * as React from 'react'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { VideoHandle } from './videoHandle'

/** The media events the readout keeps, newest last. */
const EVENTS = [
  'play',
  'pause',
  'playing',
  'waiting',
  'stalled',
  'seeking',
  'seeked',
  'emptied',
  'loadstart',
  'loadedmetadata',
  'canplay',
  'error',
  'ended'
]
/** How many of them it shows, a run of one counting once. */
const KEPT = 6

interface Media {
  paused: boolean
  readyState: number
  networkState?: number
  seeking?: boolean
  error: { code: number } | null
  currentTime: number
  seekable: {
    length: number
    start: (i: number) => number
    end: (i: number) => number
  }
  buffered?: {
    length: number
    start: (i: number) => number
    end: (i: number) => number
  }
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

/** An event the readout keeps: a run of the same one is kept once, with its count. */
export interface SeenEvent {
  type: string
  count: number
  firstSec: number
  lastSec: number
}

/**
 * Adds an event to the last `KEPT`. A repeat of the newest is counted in it:
 * Safari says `stalled` every few seconds while a live game plays, and six of
 * those would push out the events that say why a picture stopped.
 */
export function noteEvent(
  events: SeenEvent[],
  type: string,
  sec: number
): void {
  const last = events.at(-1)
  if (last?.type === type) {
    last.count += 1
    last.lastSec = sec
    return
  }
  events.push({ type, count: 1, firstSec: sec, lastSec: sec })
  if (events.length > KEPT) events.shift()
}

/** `stalled@205`, or `stalled×6@205–225` for a run of them. */
export function eventText(event: SeenEvent): string {
  return event.count === 1
    ? `${event.type}@${event.firstSec}`
    : `${event.type}×${event.count}@${event.firstSec}–${event.lastSec}`
}

/** One line of what the element is doing, as `?debug=1` shows it. */
export function describeMedia(media: Media): string {
  const range = (ranges?: Media['seekable']): string =>
    ranges == null || ranges.length === 0
      ? '—'
      : `${ranges.start(ranges.length - 1).toFixed(1)}–${ranges.end(ranges.length - 1).toFixed(1)}`
  return (
    `${media.paused ? 'paused' : 'playing'} ready ${media.readyState} ` +
    `net ${media.networkState ?? '?'}${media.seeking === true ? ' seeking' : ''} ` +
    `at ${media.currentTime.toFixed(1)} seekable ${range(media.seekable)} ` +
    `buf ${range(media.buffered)}` +
    (media.error == null ? '' : ` error ${media.error.code}`)
  )
}

/**
 * `?debug=1` on the game page's own player: what its element is doing, and
 * the last media events, so a still or black picture on a phone says why.
 */
export function SinglePlayerReadout(props: {
  element: VideoHandle | null
  /** The page's own reading of the player: recovering, and the viewer's wish. */
  state: () => string
}): React.ReactElement | null {
  const { element, state } = props
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    const media = element as unknown as Media | null
    if (media == null) return
    const started = Date.now()
    const events: SeenEvent[] = []
    const listeners = EVENTS.map(type => {
      const listener = (): void => {
        noteEvent(events, type, Math.round((Date.now() - started) / 1000))
      }
      media.addEventListener(type, listener)
      return { type, listener }
    })
    const sample = (): void => {
      setLines([describeMedia(media), state(), events.map(eventText).join(' ')])
    }
    sample()
    const timer = setInterval(sample, 1000)
    return () => {
      clearInterval(timer)
      for (const { type, listener } of listeners)
        media.removeEventListener(type, listener)
    }
  }, [element, state])
  if (lines.length === 0) return null
  return (
    <View
      testID="singlePlayerReadout"
      style={styles.readout}
      pointerEvents="none"
    >
      {lines.map((line, index) => (
        <Text key={index} style={styles.text}>
          {line}
        </Text>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  readout: {
    position: 'absolute',
    left: 4,
    right: 4,
    bottom: 4,
    zIndex: 6,
    padding: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.72)'
  },
  text: {
    color: '#9cff9c',
    fontFamily: 'monospace',
    fontSize: 10
  }
})
