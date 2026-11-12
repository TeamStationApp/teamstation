import React, { useCallback, useEffect, useRef, useState } from 'react'
import Video, {
  type OnLoadData,
  type OnProgressData,
  type ReactVideoSource,
  type VideoRef
} from 'react-native-video'

import { setOtherAudio } from '../scoring/cueSoundsController'
import {
  bedGains,
  CHEER_GAIN,
  type CheerSize,
  type Crowd,
  CROWD_IDLE_GAIN,
  MAX_CHEERS,
  nextStartsAt
} from './crowdCheer'

/** Metro's asset ids, which the player takes as its source. */
const CROWD_IDLE_SOUND = require('../assets/crowd/crowd-idle.m4a') as number
const CHEER_SOUNDS: Record<CheerSize, number> = {
  small: require('../assets/crowd/cheer-small.m4a') as number,
  medium: require('../assets/crowd/cheer-medium.m4a') as number,
  large: require('../assets/crowd/cheer-large.m4a') as number,
  huge: require('../assets/crowd/cheer-huge.m4a') as number
}

const ignore = (): void => undefined

/** An asset id as the player's source, which it resolves itself. */
const sourceOf = (asset: number): ReactVideoSource =>
  asset as unknown as ReactVideoSource

/** How often a playing copy of the idle crowd reports where it is, in ms. */
export const CROWD_PROGRESS_MS = 50

/** The other of the idle crowd's two copies. */
const otherOf = (copy: number): number => 1 - copy

/**
 * The idle crowd, as two hidden players of the same file, neither repeating,
 * that take turns: as the copy playing reports its progress, every
 * CROWD_PROGRESS_MS, it is levelled by `bedGains`, and once it reaches
 * `nextStartsAt` the other seeks to its start and plays, the two crossing
 * over CROWD_CROSSFADE_SECONDS. While both play, both volumes follow the
 * outgoing copy's position, so they stay equal power whatever the other's
 * start lagged by. The outgoing copy rests at its start once it ends. Both
 * pause with `paused`, and play on from where they stand. Mounted fresh each
 * time the sound comes on, the first copy rises from silence.
 *
 * Only this component re-renders as the volumes move, not the replay.
 */
function CrowdBed(props: { paused: boolean }): React.ReactElement {
  const { paused } = props
  const first = useRef<VideoRef>(null)
  const second = useRef<VideoRef>(null)
  const players = [first, second]
  /** Which copies are playing or paused part way. */
  const [sounding, setSounding] = useState<boolean[]>([true, false])
  const [volumes, setVolumes] = useState<number[]>([0, 0])
  /** The copies' positions and durations, as they last reported them. */
  const at = useRef([0, 0])
  const lengths = useRef([Infinity, Infinity])
  /** The copies playing, the oldest first. */
  const order = useRef<number[]>([0])
  const level = (): void => {
    const [outgoing, incoming] = order.current
    const next = [0, 0]
    if (outgoing != null) {
      const position = at.current[outgoing]
      const length = lengths.current[outgoing]
      next[outgoing] = CROWD_IDLE_GAIN * bedGains(position, length)
      if (incoming != null)
        next[incoming] =
          CROWD_IDLE_GAIN *
          bedGains(position - nextStartsAt(length), lengths.current[incoming])
    }
    setVolumes(now =>
      now.every((volume, copy) => Math.abs(volume - next[copy]) < 1e-4)
        ? now
        : next
    )
  }
  const begin = (copy: number): void => {
    at.current[copy] = 0
    players[copy].current?.seek(0)
    order.current = [...order.current, copy]
    setSounding(now => now.map((on, which) => on || which === copy))
  }
  const loaded = (copy: number, data: OnLoadData): void => {
    if (data.duration > 0) lengths.current[copy] = data.duration
  }
  const progressed = (copy: number, data: OnProgressData): void => {
    if (!order.current.includes(copy)) return
    at.current[copy] = data.currentTime
    if (!(lengths.current[copy] < Infinity) && data.seekableDuration > 0)
      lengths.current[copy] = data.seekableDuration
    if (
      order.current.length === 1 &&
      data.currentTime >= nextStartsAt(lengths.current[copy])
    )
      begin(otherOf(copy))
    level()
  }
  const ended = (copy: number): void => {
    if (!order.current.includes(copy)) return
    order.current = order.current.filter(which => which !== copy)
    at.current[copy] = 0
    players[copy].current?.seek(0)
    setSounding(now => now.map((on, which) => on && which !== copy))
    // Reported too late to have handed over: the other starts now.
    if (order.current.length === 0) begin(otherOf(copy))
    level()
  }
  return (
    <>
      {players.map((player, copy) => (
        <Video
          key={copy}
          ref={player}
          source={sourceOf(CROWD_IDLE_SOUND)}
          volume={volumes[copy]}
          paused={paused || !sounding[copy]}
          progressUpdateInterval={CROWD_PROGRESS_MS}
          ignoreSilentSwitch="ignore"
          mixWithOthers="mix"
          disableFocus
          style={{ width: 0, height: 0 }}
          onLoad={data => {
            loaded(copy, data)
          }}
          onProgress={data => {
            progressed(copy, data)
          }}
          onEnd={() => {
            ended(copy)
          }}
        />
      ))}
    </>
  )
}

/**
 * The stadium crowd under the replay, on a phone: hidden players, as the
 * announcer's is, that sound with the ring switch on silent and mix with the
 * field's cues. None of them takes Android's audio focus, so the crowd mixes
 * under the announcer instead of pausing it or being paused by it. The idle
 * murmur (`CrowdBed`) plays while the sound is on, paused with the replay and
 * once it is over; each cheer mounts its own player, paused with the replay, removed
 * when it ends, at most two at once, and plays out at the end. While any of
 * them is mounted the cues leave the audio session to them. A phone plays
 * them without a tap, so `unlock` does nothing.
 */
export function useCrowd(options: {
  on: boolean
  paused: boolean
  over: boolean
}): Crowd {
  const { on, paused, over } = options
  const [cheers, setCheers] = useState<Array<{ id: number; size: CheerSize }>>(
    []
  )
  const ids = useRef(0)
  const live = useRef(on)
  useEffect(() => {
    live.current = on
    if (!on) setCheers([])
  }, [on])
  const mounted = on || cheers.length > 0
  useEffect(() => {
    setOtherAudio('crowd', mounted)
  }, [mounted])
  useEffect(
    () => () => {
      live.current = false
      setOtherAudio('crowd', false)
    },
    []
  )
  const cheer = useCallback((size: CheerSize): void => {
    if (!live.current) return
    const id = ++ids.current
    setCheers(now => [...now, { id, size }].slice(-MAX_CHEERS))
  }, [])
  const end = (id: number): void => {
    setCheers(now => now.filter(entry => entry.id !== id))
  }
  return {
    cheer,
    unlock: ignore,
    element: !mounted ? null : (
      <>
        {on && <CrowdBed paused={paused || over} />}
        {cheers.map(entry => (
          <Video
            key={entry.id}
            source={sourceOf(CHEER_SOUNDS[entry.size])}
            volume={CHEER_GAIN[entry.size]}
            paused={paused}
            ignoreSilentSwitch="ignore"
            mixWithOthers="mix"
            disableFocus
            style={{ width: 0, height: 0 }}
            onEnd={() => {
              end(entry.id)
            }}
            onError={() => {
              end(entry.id)
            }}
          />
        ))}
      </>
    )
  }
}
