import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { NO_WALK_UP_MUSIC } from './useWalkUpNote'
import type { OfflineReport, WalkUpMusic } from './walkUpMusicTypes'
import {
  markOnboarded,
  needsDownload,
  NO_READINESS_FLAGS,
  type Readiness,
  type ReadinessFlags,
  type ReadinessStore,
  readinessStore,
  useWalkUpReadiness
} from './walkUpReadiness'

/**
 * Getting a game's songs onto the phone: the per-device flags, and when the
 * walkthrough and the notice open.
 */
let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

function memory(initial?: string): PreferenceStorage & {
  items: Map<string, string>
} {
  const items = new Map<string, string>()
  if (initial != null) items.set('teamstation:walkUp:readiness', initial)
  return {
    items,
    getItem: async key => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value)
    }
  }
}

describe('readinessStore', function () {
  it('reads nothing shown from empty, corrupt or odd storage', async function () {
    expect(await readinessStore(memory()).read()).deep.equals(
      NO_READINESS_FLAGS
    )
    expect(await readinessStore(memory('{nope')).read()).deep.equals(
      NO_READINESS_FLAGS
    )
    expect(await readinessStore(memory('7')).read()).deep.equals(
      NO_READINESS_FLAGS
    )
    expect(
      await readinessStore(memory('{"onboarded":"yes"}')).read()
    ).deep.equals(NO_READINESS_FLAGS)
  })

  it('keeps both flags, and shrugs off storage that refuses', async function () {
    const store = readinessStore(memory())
    await store.write({ onboarded: true, promptShown: false })
    expect(await store.read()).deep.equals({
      onboarded: true,
      promptShown: false
    })
    const refusing: PreferenceStorage = {
      getItem: async () => {
        throw new Error('restricted')
      },
      setItem: async () => {
        throw new Error('restricted')
      }
    }
    await readinessStore(refusing).write({
      onboarded: true,
      promptShown: true
    })
    expect(await readinessStore(refusing).read()).deep.equals(
      NO_READINESS_FLAGS
    )
  })
})

describe('needsDownload and markOnboarded', function () {
  const song = (
    state: 'downloaded' | 'pending' | 'added'
  ): { providerId: string; state: 'downloaded' | 'pending' | 'added' } => ({
    providerId: state,
    state
  })

  it('says nothing the settings cannot fix', function () {
    const base = { authorized: true, subscribed: true, syncLibrary: true }
    expect(needsDownload({ ...base, songs: [song('pending')] })).equals(true)
    // No subscription, or a phone that could not say: no notice.
    expect(
      needsDownload({ ...base, subscribed: false, songs: [song('pending')] })
    ).equals(false)
    // Every song on the phone: nothing to do, whatever Sync Library says.
    expect(
      needsDownload({
        ...base,
        syncLibrary: false,
        songs: [song('downloaded'), song('downloaded')]
      })
    ).equals(false)
    expect(
      needsDownload({ ...base, syncLibrary: false, songs: [song('added')] })
    ).equals(true)
    expect(needsDownload({ ...base, syncLibrary: false, songs: [] })).equals(
      true
    )
  })

  it('marks the walkthrough seen, keeping the notice flag', async function () {
    const store = readinessStore(
      memory('{"onboarded":false,"promptShown":true}')
    )
    await markOnboarded(store)
    expect(await store.read()).deep.equals({
      onboarded: true,
      promptShown: true
    })
  })
})

describe('useWalkUpReadiness', function () {
  const pending: OfflineReport = {
    authorized: true,
    subscribed: true,
    syncLibrary: true,
    songs: [
      { providerId: '1', state: 'downloaded' },
      { providerId: '2', state: 'pending' }
    ]
  }

  function phone(report: OfflineReport | null): WalkUpMusic & {
    asked: string[][]
  } {
    const asked: string[][] = []
    return {
      ...NO_WALK_UP_MUSIC,
      available: true,
      djSupported: true,
      asked,
      prepareOffline: async ids => {
        asked.push(ids)
        return report
      }
    }
  }

  function flagStore(start: ReadinessFlags): ReadinessStore & {
    written: ReadinessFlags[]
  } {
    let held = start
    const written: ReadinessFlags[] = []
    return {
      written,
      read: async () => held,
      write: async value => {
        held = value
        written.push(value)
      }
    }
  }

  interface Probe {
    current: Readiness
    rerender: (props: Partial<HarnessProps>) => Promise<void>
  }
  interface HarnessProps {
    music: WalkUpMusic
    ids: string[] | null
    screen: 'dj' | 'scoring'
    blocked: boolean
    store: ReadinessStore
    settleMs?: number
  }

  async function mount(props: HarnessProps): Promise<Probe> {
    let latest: Readiness | undefined
    const probe: Probe = {
      get current(): Readiness {
        return latest!
      },
      rerender: async () => undefined
    }
    function Harness(given: HarnessProps): null {
      latest = useWalkUpReadiness(given.music, given.ids, {
        screen: given.screen,
        blocked: given.blocked,
        store: given.store,
        settleMs: given.settleMs ?? 0
      })
      return null
    }
    let current = props
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    probe.rerender = async next => {
      current = { ...current, ...next }
      await act(async () => {
        root!.render(<Harness {...current} />)
        await delay(10)
      })
      // The answer, then the hand-off's timer: each lands on its own turn.
      await act(async () => {
        await delay(10)
      })
    }
    await probe.rerender({})
    return probe
  }

  it('opens the walkthrough on a first DJ visit, prepares the songs, and shows no notice', async function () {
    const music = phone(pending)
    const store = flagStore(NO_READINESS_FLAGS)
    const probe = await mount({
      music,
      ids: ['1', '2'],
      screen: 'dj',
      blocked: false,
      store
    })
    expect(probe.current.setupOpen).equals(true)
    expect(probe.current.promptOpen).equals(false)
    expect(music.asked).deep.equals([['1', '2']])
    await act(async () => {
      probe.current.closeSetup()
      await delay(10)
    })
    expect(probe.current.setupOpen).equals(false)
    expect(store.written).deep.equals([{ onboarded: true, promptShown: false }])
  })

  it('raises the notice once a song is waiting, and records it when shown', async function () {
    const store = flagStore({ onboarded: true, promptShown: false })
    const probe = await mount({
      music: phone(pending),
      ids: ['1', '2'],
      screen: 'dj',
      blocked: false,
      store
    })
    expect(probe.current.setupOpen).equals(false)
    expect(probe.current.promptOpen).equals(true)
    expect(store.written).deep.equals([])
    await act(async () => {
      probe.current.onPromptShown()
      await delay(10)
    })
    expect(store.written).deep.equals([{ onboarded: true, promptShown: true }])
    await act(async () => {
      probe.current.closePrompt()
      probe.current.openSetup()
      await delay(10)
    })
    expect(probe.current.promptOpen).equals(false)
    expect(probe.current.setupOpen).equals(true)
  })

  it('says nothing for songs just added or that the library cannot hold', async function () {
    const probe = await mount({
      music: phone({
        authorized: true,
        subscribed: true,
        syncLibrary: true,
        songs: [
          { providerId: '1', state: 'added' },
          { providerId: '2', state: 'unavailable' },
          { providerId: '3', state: 'downloaded' }
        ]
      }),
      ids: ['1', '2', '3'],
      screen: 'scoring',
      blocked: false,
      store: flagStore({ onboarded: true, promptShown: false })
    })
    expect(probe.current.promptOpen).equals(false)
  })

  it('raises the notice for Sync Library off, but not without access', async function () {
    const off = await mount({
      music: phone({
        authorized: true,
        subscribed: true,
        syncLibrary: false,
        songs: []
      }),
      ids: ['1'],
      screen: 'scoring',
      blocked: false,
      store: flagStore({ onboarded: false, promptShown: false })
    })
    expect(off.current.setupOpen).equals(false)
    expect(off.current.promptOpen).equals(true)
    await act(async () => {
      root?.unmount()
    })
    const denied = await mount({
      music: phone({
        authorized: false,
        subscribed: false,
        syncLibrary: false,
        songs: [{ providerId: '1', state: 'unavailable' }]
      }),
      ids: ['1'],
      screen: 'scoring',
      blocked: false,
      store: flagStore({ onboarded: true, promptShown: false })
    })
    expect(denied.current.promptOpen).equals(false)
  })

  it('never shows the notice twice on a device, nor for no answer', async function () {
    const shown = await mount({
      music: phone(pending),
      ids: ['1', '2'],
      screen: 'dj',
      blocked: false,
      store: flagStore({ onboarded: true, promptShown: true })
    })
    expect(shown.current.promptOpen).equals(false)
    await act(async () => {
      root?.unmount()
    })
    const none = await mount({
      music: phone(null),
      ids: ['1'],
      screen: 'dj',
      blocked: false,
      store: flagStore({ onboarded: true, promptShown: false })
    })
    expect(none.current.promptOpen).equals(false)
  })

  it('holds the notice while another modal is up', async function () {
    const probe = await mount({
      music: phone(pending),
      ids: ['1', '2'],
      screen: 'scoring',
      blocked: true,
      store: flagStore({ onboarded: true, promptShown: false })
    })
    expect(probe.current.promptOpen).equals(false)
    await probe.rerender({ blocked: false })
    expect(probe.current.promptOpen).equals(true)
  })

  it('asks once per visit, waits for the ids, and does nothing off an iPhone', async function () {
    const music = phone(pending)
    const probe = await mount({
      music,
      ids: null,
      screen: 'dj',
      blocked: false,
      store: flagStore({ onboarded: true, promptShown: true })
    })
    expect(music.asked).deep.equals([])
    await probe.rerender({ ids: ['1'] })
    await probe.rerender({ ids: ['1', '2'] })
    expect(music.asked).deep.equals([['1']])
    await act(async () => {
      root?.unmount()
    })
    const android = { ...phone(pending), djSupported: false }
    const store = flagStore(NO_READINESS_FLAGS)
    const off = await mount({
      music: android,
      ids: ['1'],
      screen: 'dj',
      blocked: false,
      store
    })
    expect(android.asked).deep.equals([])
    expect(off.current.setupOpen).equals(false)
  })

  it('keeps the answer on its way when what it was given changes', async function () {
    let answer: ((report: OfflineReport) => void) | undefined
    const music = {
      ...phone(null),
      prepareOffline: async () =>
        await new Promise<OfflineReport>(resolve => {
          answer = resolve
        })
    }
    const probe = await mount({
      music,
      ids: ['1', '2'],
      screen: 'scoring',
      blocked: false,
      store: flagStore({ onboarded: true, promptShown: false })
    })
    // A new list and a new store while the phone is still answering.
    await probe.rerender({
      ids: ['1', '2'],
      store: flagStore({ onboarded: true, promptShown: false })
    })
    await act(async () => {
      answer?.(pending)
      await delay(10)
    })
    await act(async () => {
      await delay(10)
    })
    expect(probe.current.promptOpen).equals(true)
  })

  it('waits for what blocked it to finish leaving, and covers until it has gone', async function () {
    const probe = await mount({
      music: phone(pending),
      ids: ['1', '2'],
      screen: 'scoring',
      blocked: true,
      store: flagStore({ onboarded: true, promptShown: false }),
      settleMs: 80
    })
    expect(probe.current.covering).equals(false)
    await probe.rerender({ blocked: false })
    // The sheet that blocked it is still sliding away.
    expect(probe.current.promptOpen).equals(false)
    await act(async () => {
      await delay(120)
    })
    expect(probe.current.promptOpen).equals(true)
    expect(probe.current.covering).equals(true)
    await act(async () => {
      probe.current.closePrompt()
      await delay(10)
    })
    // Still fading out: what it covers keeps waiting.
    expect(probe.current.covering).equals(true)
    await act(async () => {
      await delay(120)
    })
    expect(probe.current.covering).equals(false)
  })

  it('opens the walkthrough for a first DJ visit with no songs, asking nothing', async function () {
    const music = phone(pending)
    const probe = await mount({
      music,
      ids: [],
      screen: 'dj',
      blocked: false,
      store: flagStore(NO_READINESS_FLAGS)
    })
    expect(probe.current.setupOpen).equals(true)
    expect(music.asked).deep.equals([])
  })
})
