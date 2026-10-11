import { useCallback, useEffect, useRef, useState } from 'react'

import type { WalkUpSong } from '../../common/walkUpSong'
import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import type { OfflineReport, WalkUpMusic } from './walkUpMusicTypes'

/** What this device has already shown about keeping songs on the phone. */
export interface ReadinessFlags {
  /** The Apple Music settings walkthrough has been closed here. */
  onboarded: boolean
  /** The "songs still need to be downloaded" notice has appeared here. */
  promptShown: boolean
}

export const NO_READINESS_FLAGS: ReadinessFlags = {
  onboarded: false,
  promptShown: false
}

const KEY = 'teamstation:walkUp:readiness'

export interface ReadinessStore {
  read: () => Promise<ReadinessFlags>
  write: (value: ReadinessFlags) => Promise<void>
}

/**
 * The two flags, per device, in the storage the other walk-up settings use,
 * so a new phone shows both again. Anything unreadable is neither shown.
 */
export function readinessStore(storage: PreferenceStorage): ReadinessStore {
  return {
    async read() {
      try {
        const raw = await storage.getItem(KEY)
        if (raw == null) return NO_READINESS_FLAGS
        const value: unknown = JSON.parse(raw)
        if (typeof value !== 'object' || value == null) {
          return NO_READINESS_FLAGS
        }
        return {
          onboarded: 'onboarded' in value && value.onboarded === true,
          promptShown: 'promptShown' in value && value.promptShown === true
        }
      } catch {
        return NO_READINESS_FLAGS
      }
    },
    async write(value) {
      try {
        await storage.setItem(KEY, JSON.stringify(value))
      } catch {
        // Restricted storage shows them again; it must not block anything.
      }
    }
  }
}

export const walkUpReadiness = readinessStore(deviceStorage)

/** A game's Apple Music walk-up songs, each catalog id once. */
export function appleMusicIds(
  songs: ReadonlyArray<WalkUpSong | null | undefined>
): string[] {
  const ids = new Set<string>()
  for (const song of songs) {
    if (song?.provider === 'appleMusic') ids.add(song.providerId)
  }
  return [...ids]
}

/**
 * Whether a report calls for the notice: Sync Library off, or a song in the
 * library that is not on the phone. A song just added is on its way, one
 * the library cannot hold is not a setting's fault, and the settings cannot
 * help without access or a subscription — or when the phone could not say
 * (offline at a field). Every song already on the phone needs nothing.
 */
export function needsDownload(report: OfflineReport): boolean {
  if (!report.authorized || !report.subscribed) return false
  const { songs } = report
  if (songs.length > 0 && songs.every(song => song.state === 'downloaded')) {
    return false
  }
  return !report.syncLibrary || songs.some(song => song.state === 'pending')
}

/** Records that the walkthrough has been seen on this device. */
export async function markOnboarded(store: ReadinessStore): Promise<void> {
  const flags = await store.read()
  await store.write({ ...flags, onboarded: true })
}

export interface ReadinessOptions {
  /** DJ Game opens the walkthrough on a device's first visit; scoring never. */
  screen: 'dj' | 'scoring'
  /**
   * Another of the screen's own modals is up. iOS presents one at a time,
   * so the notice waits until it closes.
   */
  blocked?: boolean
  store?: ReadinessStore
  /**
   * How long a modal takes to finish leaving. iOS drops a modal presented
   * while another is still animating away, so each hand-off waits this long
   * after the one before has closed. 600 ms.
   */
  settleMs?: number
}

/** Longer than a modal's slide or fade out. */
export const MODAL_SETTLE_MS = 600

export interface Readiness {
  setupOpen: boolean
  promptOpen: boolean
  /**
   * Each has opened on this visit. A screen mounts the modal from then on,
   * so it can animate away and say when it has gone, and mounts nothing on
   * a visit that never needs it.
   */
  setupUsed: boolean
  promptUsed: boolean
  /**
   * The walkthrough or the notice is up, or still leaving: what it covers
   * should wait (the scoring clock, a dictation question) until it has gone.
   */
  covering: boolean
  openSetup: () => void
  /** The walkthrough closed: it has been seen on this device. */
  closeSetup: () => void
  closePrompt: () => void
  /** The notice is on screen: it will not appear on this device again. */
  onPromptShown: () => void
}

/**
 * Getting a game's walk-up songs onto this iPhone, once per visit to DJ Game
 * or the scoring screen.
 *
 * As soon as the game's Apple Music ids are known, it asks the phone to put
 * them in the library and on TeamStation's playlist. DJ Game opens the
 * Apple Music settings walkthrough on the device's first visit. Otherwise,
 * when the answer shows songs that still need downloading, it raises the
 * notice — once per device, never on a visit that opened the walkthrough,
 * and not while another modal is up. Later changes to the ids, the music or
 * the store in the same visit ask nothing more, and do not cancel the
 * answer already on its way; leaving the screen does.
 */
export function useWalkUpReadiness(
  music: WalkUpMusic,
  providerIds: readonly string[] | null,
  options: ReadinessOptions
): Readiness {
  const {
    screen,
    blocked = false,
    store = walkUpReadiness,
    settleMs = MODAL_SETTLE_MS
  } = options
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupUsed, setSetupUsed] = useState(false)
  const [due, setDue] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptUsed, setPromptUsed] = useState(false)
  const started = useRef(false)
  const flags = useRef<ReadinessFlags>(NO_READINESS_FLAGS)
  // Alive until the screen goes: the check runs once per visit, so a change
  // to what it was given must not cancel the answer on its way.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (started.current || providerIds == null || !music.djSupported) return
    started.current = true
    const ids = [...providerIds]
    const run = async (): Promise<void> => {
      flags.current = await store.read()
      const onboarding = screen === 'dj' && !flags.current.onboarded
      if (onboarding && mounted.current) {
        setSetupUsed(true)
        setSetupOpen(true)
      }
      if (ids.length === 0) return
      const report = await music.prepareOffline(ids)
      if (
        !mounted.current ||
        report == null ||
        onboarding ||
        flags.current.promptShown ||
        !needsDownload(report)
      ) {
        return
      }
      setDue(true)
    }
    run().catch(() => undefined)
  }, [music, providerIds, screen, store])

  // The notice opens once whatever blocked it has finished leaving, not on
  // the render that started it leaving.
  useEffect(() => {
    if (!due || blocked) return
    const timer = setTimeout(() => {
      setDue(false)
      setPromptUsed(true)
      setPromptOpen(true)
    }, settleMs)
    return () => {
      clearTimeout(timer)
    }
  }, [due, blocked, settleMs])

  // Covering from the moment either opens until it has finished leaving.
  const [covering, setCovering] = useState(false)
  const open = setupOpen || promptOpen
  useEffect(() => {
    if (open) {
      setCovering(true)
      return
    }
    const timer = setTimeout(() => {
      setCovering(false)
    }, settleMs)
    return () => {
      clearTimeout(timer)
    }
  }, [open, settleMs])

  const remember = useCallback(
    (change: Partial<ReadinessFlags>) => {
      flags.current = { ...flags.current, ...change }
      store.write(flags.current).catch(() => undefined)
    },
    [store]
  )

  const openSetup = useCallback(() => {
    setSetupUsed(true)
    setSetupOpen(true)
  }, [])
  const closeSetup = useCallback(() => {
    setSetupOpen(false)
    remember({ onboarded: true })
  }, [remember])
  const closePrompt = useCallback(() => {
    setPromptOpen(false)
  }, [])
  const onPromptShown = useCallback(() => {
    remember({ promptShown: true })
  }, [remember])

  return {
    setupOpen,
    promptOpen,
    setupUsed,
    promptUsed,
    covering,
    openSetup,
    closeSetup,
    closePrompt,
    onPromptShown
  }
}
