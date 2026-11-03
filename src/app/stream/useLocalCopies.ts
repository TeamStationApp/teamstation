import { useCallback, useEffect, useRef } from 'react'

import type {
  GameLiveStreams,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import { deleteTake, type PhoneStream, type Recordings } from './phoneStream'

export interface LocalCopiesOptions {
  client: TeamStationClient
  gameId: string
  phone: PhoneStream
  /** The game's cameras, as last read. */
  streams: GameLiveStreams | undefined
  /** This install's id, once it is known. */
  myId: string | undefined
  takes: Recordings
  /** Reads the game's cameras again. */
  reload: () => void
}

/**
 * Keeps this phone's copies and the server's word about them in step, each
 * time the game's cameras are read:
 *
 * - A camera deleted from anywhere takes this phone's copy with it, and any
 *   upload of it. A refusal, such as a take still filming, is tried at the
 *   next read.
 * - A camera the server thinks this phone holds a recording of, and it does
 *   not, is reported `removed`, so its owner is no longer told to upload it.
 *
 * Both wait for the first read of the takes, since an empty list before then
 * says nothing, and ask the phone only when the takes last read give them
 * something to do, so a game with a deleted camera costs no read at each poll.
 * Each then reads the takes again: the poll's own read runs beside the list's,
 * and can predate a take the list already knows of.
 *
 * Answers Delete local copy's work.
 */
export function useLocalCopies(options: LocalCopiesOptions): {
  dropCopy: (stream: LiveStream) => Promise<void>
} {
  const { client, gameId, phone, streams, myId, takes, reload } = options
  const { loaded, recordings, refresh } = takes
  /** Takes being deleted now, which a read meanwhile must not start again. */
  const deleting = useRef(new Set<string>())
  /** Cameras being reported now, or reported already. */
  const reported = useRef(new Set<string>())
  /**
   * Which cameras the takes last read are of. A key rather than the list, so
   * reading the same takes again, as a refused delete does, runs nothing.
   */
  const heldKey = recordings
    .map(take => take.liveStreamId)
    .sort()
    .join('\n')

  const dropTake = useCallback(
    async (liveStreamId: string): Promise<void> => {
      await deleteTake(phone, liveStreamId)
    },
    [phone]
  )

  const sayRemoved = useCallback(
    async (streamId: string): Promise<void> => {
      await client.updateLiveStream(gameId, streamId, {
        localRecording: 'removed'
      })
    },
    [client, gameId]
  )

  useEffect(() => {
    if (!loaded || streams == null) return
    const discarded = new Set(streams.discarded)
    const claimed = streams.mine.filter(
      stream =>
        myId != null &&
        stream.deviceId === myId &&
        stream.localRecording === 'recorded'
    )
    const last = new Set(heldKey === '' ? [] : heldKey.split('\n'))
    const anyDoomed = [...last].some(id => discarded.has(id))
    const anyMissing = claimed.some(
      stream => !last.has(stream.id) && !reported.current.has(stream.id)
    )
    if (!anyDoomed && !anyMissing) return

    const dropDiscarded = async (held: Set<string>): Promise<void> => {
      const doomed = [...held].filter(
        id => discarded.has(id) && !deleting.current.has(id)
      )
      await Promise.all(
        doomed.map(async id => {
          deleting.current.add(id)
          await dropTake(id).catch(() => undefined)
          deleting.current.delete(id)
        })
      )
      if (doomed.length > 0) refresh()
    }

    const reportMissing = async (held: Set<string>): Promise<void> => {
      const missing = claimed.filter(
        stream => !held.has(stream.id) && !reported.current.has(stream.id)
      )
      for (const stream of missing) reported.current.add(stream.id)
      const answers = await Promise.allSettled(
        missing.map(async stream => {
          await sayRemoved(stream.id)
        })
      )
      // What failed is said again at the next read, not by forcing one.
      answers.forEach((answer, index) => {
        if (answer.status === 'rejected')
          reported.current.delete(missing[index].id)
      })
      if (answers.some(answer => answer.status === 'fulfilled')) reload()
    }

    const check = async (): Promise<void> => {
      const read = await phone.recordings()
      const held = new Set(read.map(take => take.liveStreamId))
      await Promise.all([dropDiscarded(held), reportMissing(held)])
    }
    check().catch(() => undefined)
  }, [
    dropTake,
    heldKey,
    loaded,
    myId,
    phone,
    refresh,
    reload,
    sayRemoved,
    streams
  ])

  const dropCopy = useCallback(
    async (stream: LiveStream): Promise<void> => {
      await dropTake(stream.id)
      refresh()
      await sayRemoved(stream.id).catch(() => undefined)
      reload()
    },
    [dropTake, refresh, reload, sayRemoved]
  )

  return { dropCopy }
}
