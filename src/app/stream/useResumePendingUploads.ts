import { useEffect } from 'react'
import { AppState } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { observeUpload } from '../../common/observability/upload'
import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import {
  deleteTake,
  type PhoneRecording,
  type PhoneStream,
  phoneStream
} from './phoneStream'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long ago a take's 30 days can have begun when the server first hears of
 * it. The server warns from day 27, and only for one day, so one heard of later
 * starts its days here instead, on the phone as well. That leaves the warning
 * its day and the owner three more.
 */
const LATEST_RETENTION_REPORT_MS = 26 * DAY_MS

/** Where an account's settled reports of takes the list leaves out are kept. */
export const UNLISTED_REPORTED_KEY = 'phoneStream.unlistedReported.'

/**
 * The streams the camera list leaves out whose take this account has finished
 * reporting, kept on the phone for each account: the server has their
 * recording, or answered that the stream is not this account's (404). The
 * list cannot say which, so without this each would be reported again at
 * every launch. Only streams of takes still on the phone are kept.
 */
async function unlistedReports(
  storage: PreferenceStorage,
  account: string,
  held: Set<string>
): Promise<{
  has: (id: string) => boolean
  note: (id: string) => Promise<void>
}> {
  const key = UNLISTED_REPORTED_KEY + account
  let stored: unknown = []
  try {
    stored = JSON.parse((await storage.getItem(key)) ?? '[]')
  } catch {
    // Unreadable: each is reported again, which the server takes as it is.
  }
  const ids = Array.isArray(stored)
    ? stored.filter((id): id is string => typeof id === 'string')
    : []
  const kept = new Set(ids.filter(id => held.has(id)))
  const save = async (): Promise<void> => {
    await storage.setItem(key, JSON.stringify([...kept]))
  }
  if (kept.size !== ids.length) await save().catch(() => undefined)
  return {
    has: id => kept.has(id),
    note: async id => {
      kept.add(id)
      await save()
    }
  }
}

/** The part of React Native's `AppState` this needs; a test hands in its own. */
export interface AppStateLike {
  addEventListener: (
    type: 'change',
    listener: (state: string) => void
  ) => { remove: () => void }
}

/**
 * Carries on every recording upload that was cut off: once somebody is signed
 * in at launch, and again each time the app comes back to the front. A killed
 * app, or a phone back from its lock screen, picks up from the parts the
 * server already has; an upload already running in this process is left to
 * run. Nothing happens on a phone that cannot record, nor in a browser.
 *
 * Only the signed-in account's own takes. A take the server already opened
 * an upload for carries its id, and that upload is its opener's: the server
 * answers it only to that account, so it resumes as it is, even once the
 * server has finished it and ended the take's stream (it then reads as
 * done). A take cut off before the server opened it is filmed into a stream,
 * and the stream is its account's: the game's camera list says which are this
 * account's (`mine`). A take on a stream that is not among them was made by
 * somebody else who used this phone, or cannot be told apart from one, and is
 * left waiting for them. Opened under the wrong account it would land as that
 * account's upload, and its maker's reminder would never settle.
 *
 * A take whose camera was deleted (the list's `discarded`) has nothing to come
 * back to, so it is deleted from the phone rather than retried for ever.
 *
 * It also tells the server about every ended take of this account's it has
 * not heard of. The streaming screen says so when a part ends, and a failed
 * report is said again only when another part ends: after a take's last
 * part, a slide to stop on a weak signal and then Close, nothing would say
 * it again, and the take would never get its upload reminder. So any take
 * never uploaded nor opened for upload, on a stream the camera list still
 * says holds no recording (`localRecording: 'none'`), is reported here.
 *
 * So is one on a stream a list that was read leaves out, which is not
 * somebody else's camera there nor a deleted one: its owner may have removed
 * it after the report failed, and a removed camera's take still has its
 * reminder and its warning, which it gets only from this report. Such a
 * report is said at each launch and each return to the front until it lands,
 * and then no more (`unlistedReports`). A 404, the server's word that the
 * stream is not this account's, also ends it for this account; the take
 * stays on the phone for its maker, whose own launches report it.
 *
 * The phone's sweep runs without telling anyone, on any game, so this is also
 * what tells the server about it. A stream the sweep took a take of is reported
 * as `removed` and then forgotten, which settles its reminder and warning
 * whether or not its Videos tab ever opens here. A stream the list leaves out
 * is reported all the same: one its owner removed still has a reminder and a
 * warning, and the server takes the report only from that owner. Until a
 * report lands, or the list says there is nothing to report, it stays
 * remembered: a failed report, a list that cannot be read, and somebody else's
 * take all wait for a later launch.
 *
 * And a take recorded before the phone's 30-day limit began reports when its
 * 30 days began, so the server warns before the phone deletes it. The phone
 * keeps such a take until that report has landed.
 */
interface GameTakes {
  pending: PhoneRecording[]
  unopened: PhoneRecording[]
  counting: PhoneRecording[]
  swept: string[]
}

export function useResumePendingUploads(
  client: TeamStationClient,
  signedInAs: unknown,
  phone: PhoneStream = phoneStream,
  appState: AppStateLike = AppState,
  storage: PreferenceStorage = deviceStorage
): void {
  useEffect(() => {
    if (signedInAs == null) return
    let alive = true
    const resume = async (): Promise<void> => {
      const token = client.token
      if (token == null || token === '') return
      const found = await phone.capabilities()
      if (!alive || !found.supported) return
      const recordings = await phone.recordings()
      const pending = recordings.filter(
        recording =>
          recording.hasPendingUpload &&
          !recording.uploadRunning &&
          recording.uploadedAt == null
      )
      // Ended takes the server has not opened an upload for: what it knows of
      // them is only what the streaming screen managed to tell it. A take
      // with no end is still being filmed, or waits to be resumed, and the
      // app coming back mid-take must not remind anyone to upload it yet.
      const unopened = recordings.filter(
        recording =>
          recording.endedAt != null &&
          recording.uploadedAt == null &&
          recording.uploadId == null
      )
      // Takes kept from before the 30-day limit, whose count the server has
      // not heard of.
      const counting = recordings.filter(
        recording =>
          recording.retentionFrom != null &&
          !recording.retentionReported &&
          recording.uploadedAt == null
      )
      const swept = await phone.sweptStreams().catch(() => [])
      if (!alive) return
      const held = new Set(recordings.map(take => take.liveStreamId))
      const account =
        typeof signedInAs === 'string' ? signedInAs : JSON.stringify(signedInAs)
      const reported = await unlistedReports(storage, account, held)
      if (!alive) return
      const games = new Map<string, GameTakes>()
      const gameOf = (gameId: string): GameTakes => {
        const found = games.get(gameId) ?? {
          pending: [],
          unopened: [],
          counting: [],
          swept: []
        }
        games.set(gameId, found)
        return found
      }
      for (const recording of pending) {
        gameOf(recording.gameId).pending.push(recording)
      }
      for (const recording of unopened) {
        gameOf(recording.gameId).unopened.push(recording)
      }
      for (const recording of counting) {
        gameOf(recording.gameId).counting.push(recording)
      }
      for (const stream of swept) {
        gameOf(stream.gameId).swept.push(stream.liveStreamId)
      }
      for (const [gameId, group] of games) {
        const { pending: takes, unopened: unreported } = group
        // Unreadable, or not this account's game to film: whose an unopened
        // take is, and whether a camera was deleted, are unknown, so a take
        // the server has not opened waits, and one it has opened resumes.
        const streams = await client.liveStreams(gameId).catch(() => undefined)
        if (!alive) return
        const mine = new Set(streams?.mine.map(stream => stream.id) ?? [])
        const discarded = new Set(streams?.discarded)
        const others = new Set(streams?.others.map(stream => stream.id) ?? [])
        for (const take of unreported) {
          const id = take.liveStreamId
          const stream = streams?.mine.find(item => item.id === id)
          if (stream != null) {
            if (
              stream.localRecording !== 'none' ||
              group.counting.includes(take)
            )
              continue
            client
              .updateLiveStream(gameId, id, { localRecording: 'recorded' })
              .catch(() => undefined)
            continue
          }
          // Left out of a list that was read: removed by its owner, or
          // somebody else's, which the server refuses with a 404.
          if (
            streams == null ||
            discarded.has(id) ||
            others.has(id) ||
            reported.has(id)
          )
            continue
          const report = async (): Promise<void> => {
            try {
              await client.updateLiveStream(gameId, id, {
                localRecording: 'recorded'
              })
            } catch (error) {
              if (!(error instanceof HttpError && error.code === 'notFound'))
                throw error
            }
            await reported.note(id)
          }
          report().catch(() => undefined)
        }
        for (const take of group.counting) {
          const stream = streams?.mine.find(
            item => item.id === take.liveStreamId
          )
          if (stream == null || take.retentionFrom == null) continue
          const from = Math.max(
            take.retentionFrom,
            Date.now() - LATEST_RETENTION_REPORT_MS
          )
          // In one request: the warning needs both, and once this lands the
          // phone counts on it.
          client
            .updateLiveStream(gameId, stream.id, {
              ...(stream.localRecording === 'none'
                ? { localRecording: 'recorded' as const }
                : {}),
              localCopyFrom: new Date(from).toISOString()
            })
            .then(async () => {
              await phone.retentionReported(stream.id, from)
            })
            .catch(() => undefined)
        }
        for (const id of group.swept) {
          const stream = streams?.mine.find(item => item.id === id)
          // On the phone again: a later take on the same stream, so nothing has
          // gone. Deleted: its reminder and warning went with it.
          const moot = held.has(id) || discarded.has(id)
          if (!moot && streams == null) continue
          const report = async (): Promise<void> => {
            // Listed: only what still says it holds a recording. Not listed:
            // removed, or somebody else's, which the server refuses.
            if (
              !moot &&
              (stream == null || stream.localRecording === 'recorded')
            ) {
              await client.updateLiveStream(gameId, id, {
                localRecording: 'removed'
              })
            }
            await phone.forgetSwept(id)
          }
          report().catch(() => undefined)
        }
        for (const take of takes) {
          if (discarded.has(take.liveStreamId)) {
            deleteTake(phone, take.liveStreamId).catch(() => undefined)
            continue
          }
          if (take.uploadId == null && !mine.has(take.liveStreamId)) continue
          observeUpload(
            async () =>
              await phone.resumeUpload({
                liveStreamId: take.liveStreamId,
                apiBase: client.baseUrl,
                token,
                title: take.uploadTitle ?? take.angleName
              }),
            client.captureAnalytics,
            true
          ).catch(() => undefined)
        }
      }
    }
    const resumeQuietly = (): void => {
      resume().catch(() => undefined)
    }
    resumeQuietly()
    const subscription = appState.addEventListener('change', state => {
      if (state === 'active') resumeQuietly()
    })
    return () => {
      alive = false
      subscription.remove()
    }
  }, [appState, client, phone, signedInAs, storage])
}
