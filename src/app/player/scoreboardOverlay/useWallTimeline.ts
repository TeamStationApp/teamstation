import { useEffect, useRef, useState } from 'react'

import type { TeamStationClient } from '../../../common/api'
import type { WallTimeline } from '../../../common/wallTimeline'
import { realSchedule, type Schedule } from '../../scoreboard/scoreboardSocket'
import { appendPoll, pollAfter } from './wallTimeline'

/** How often a live video's timeline is asked for the points it has gained. */
export const WALL_POLL_MS = 4000

/** One video whose timeline is wanted, and whether it is streaming now. */
export interface TimelineWanted {
  id: string
  live: boolean
}

/**
 * The wall-clock timelines of a set of videos, by id: each fetched whole,
 * then, while the server says it is live, asked every `WALL_POLL_MS` for the
 * points after the last one held, which are appended. While it holds only
 * the video's start, because no point had been stored yet, it asks for the
 * whole timeline again instead (`pollAfter`, `appendPoll`).
 *
 * When a poll says the stream has ended, the whole timeline is fetched again:
 * the recording's own points replace the live ones (`finishVideo`). A video
 * whose `live` changes is fetched again whole as well, which is the other
 * way a player learns the stream ended.
 *
 * A video's timeline is missing until it has been fetched, and stays missing
 * when it cannot be: no board is drawn over a picture nobody can place.
 */
export function useWallTimelines(
  client: TeamStationClient,
  videos: readonly TimelineWanted[],
  schedule: Schedule = realSchedule
): Record<string, WallTimeline> {
  const [timelines, setTimelines] = useState<Record<string, WallTimeline>>({})
  const key = videos.map(video => `${video.id}:${String(video.live)}`).join(',')
  const wanted = useRef(videos)
  wanted.current = videos

  useEffect(() => {
    let done = false
    const cancels: Array<() => void> = []
    const held: Record<string, WallTimeline> = {}
    const put = (id: string, timeline: WallTimeline): void => {
      held[id] = timeline
      setTimelines(current => ({ ...current, [id]: timeline }))
    }

    for (const { id, live } of wanted.current) {
      const later = (run: () => Promise<void>): void => {
        cancels.push(
          schedule(() => {
            run().catch(() => undefined)
          }, WALL_POLL_MS)
        )
      }
      const whole = async (): Promise<void> => {
        try {
          const timeline = await client.wallTimeline(id)
          if (done) return
          put(id, timeline)
          if (timeline.live) later(poll)
        } catch {
          // A stream that is meant to be live is worth asking again; a
          // recording that cannot be placed is not going to change.
          if (!done && live) later(whole)
        }
      }
      const poll = async (): Promise<void> => {
        const before = held[id]
        try {
          const polled = await client.wallTimeline(id, pollAfter(before))
          if (done) return
          if (!polled.live) {
            await whole()
            return
          }
          put(id, appendPoll(before, polled))
        } catch {
          // Missed one: the next poll asks from the same point.
        }
        if (!done) later(poll)
      }
      whole().catch(() => undefined)
    }
    return () => {
      done = true
      for (const cancel of cancels) cancel()
    }
  }, [client, key, schedule])

  return timelines
}

/** One video's wall-clock timeline (`useWallTimelines`), or null. */
export function useWallTimeline(
  client: TeamStationClient,
  videoId: string | null | undefined,
  live: boolean,
  schedule?: Schedule
): WallTimeline | null {
  const timelines = useWallTimelines(
    client,
    videoId == null ? NONE : [{ id: videoId, live }],
    schedule
  )
  return videoId == null ? null : (timelines[videoId] ?? null)
}

const NONE: readonly TimelineWanted[] = []
