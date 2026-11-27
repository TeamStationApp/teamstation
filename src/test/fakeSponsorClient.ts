// A stand-in for the server's sponsor API, for the sponsor screens' and
// store's tests: it keeps one league's `SponsorState` in memory and applies
// the shared rules as the server does, refusing with a 400's sentence.
import type { SponsorRowInput, TeamStationClient } from '../common/api'
import { badRequest } from '../common/errors'
import { defaultSponsorSettings } from '../common/nodeSettings'
import {
  allocated,
  allocationProblem,
  checkPlacementEdit,
  checkPlacementSlot,
  deactivated,
  placementDeleted,
  SponsorRuleError
} from '../common/sponsors/sponsorRules'
import type {
  SampleVideo,
  SponsorMediaPurpose,
  SponsorState,
  UploadedSponsorMedia
} from '../common/sponsors/types'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** A square tile with a business's initials, as a data URL. */
export function initialsTile(initials: string, color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">` +
    `<rect width="240" height="240" fill="${color}"/>` +
    `<text x="120" y="150" font-size="96" fill="#fff" text-anchor="middle">${initials}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** No rows: the 300 / 1,000 / 10 a league starts with. */
export function emptySponsorState(): SponsorState {
  return {
    totals: { logoCredits: 300, reelCredits: 1000, eventSlots: 10 },
    logos: [],
    reels: [],
    placements: [],
    keptSlots: 0
  }
}

/**
 * A league that has used its sponsors for a while: 120 of 300 logo credits
 * and 500 of 1,000 broadcasts left, two of 10 event stream slots used, one
 * of them placed three days ago and one two hours ago.
 */
export function usedSponsorState(now: Date): SponsorState {
  const at = (offsetMs: number): string =>
    new Date(now.getTime() + offsetMs).toISOString()
  return {
    ...emptySponsorState(),
    logos: [
      {
        id: 'slg_harbor',
        name: 'Harbor Hardware',
        imageUrl: initialsTile('HH', '#1f5fa8'),
        allocation: 100,
        used: 42,
        active: true
      },
      {
        id: 'slg_summit',
        name: 'Summit Dental',
        imageUrl: initialsTile('SD', '#2e8b57'),
        allocation: 50,
        used: 0,
        active: true
      },
      {
        id: 'slg_lakeside',
        name: 'Lakeside Pizza',
        imageUrl: initialsTile('LP', '#c0392b'),
        allocation: 30,
        used: 30,
        active: false
      }
    ],
    reels: [
      {
        id: 'srl_harbor',
        name: 'Harbor Hardware',
        videoUrl: 'https://example.test/media/harbor.mp4',
        posterUrl: '',
        durationSec: 12,
        allocation: 400,
        used: 120,
        active: true
      },
      {
        id: 'srl_ridgeview',
        name: 'Ridgeview Auto',
        videoUrl: 'https://example.test/media/ridgeview.mp4',
        posterUrl: '',
        durationSec: 15,
        allocation: 100,
        used: 0,
        active: true
      }
    ],
    placements: [
      {
        id: 'ser_summit',
        logoUrl: initialsTile('SD', '#2e8b57'),
        backgroundUrl: initialsTile('SD', '#a3e4bc'),
        title: 'Summit Dental',
        message: 'Free sports mouthguard fitting for every player this month.',
        url: 'https://example.test/mouthguards',
        textColor: 'dark',
        startsAt: at(5 * DAY_MS),
        placedAt: at(-3 * DAY_MS)
      },
      {
        id: 'ser_lakeside',
        logoUrl: initialsTile('LP', '#c0392b'),
        backgroundUrl: initialsTile('LP', '#f5b7b1'),
        title: 'Lakeside Pizza',
        message: 'Team night: 20% off for families who show their schedule.',
        url: 'https://example.test/team-night',
        textColor: 'white',
        startsAt: at(9 * DAY_MS),
        placedAt: at(-2 * HOUR_MS)
      }
    ]
  }
}

export const NODE_SAMPLE: SampleVideo = {
  kind: 'node',
  url: 'https://example.test/sponsors/sample/default.mp4',
  window: [0, 120],
  overlay: defaultSponsorSettings
}

export interface FakeSponsorClientOptions {
  state?: SponsorState
  now?: () => Date
  canManage?: boolean | 'fails'
  sample?: SampleVideo | 'fails'
}

/** One call the fake was asked to make, with its arguments. */
export interface FakeCall {
  name: string
  args: unknown[]
}

export interface FakeSponsorClient {
  calls: FakeCall[]
  state: () => SponsorState
  setState: (state: SponsorState) => void
  /** The next call of `name` rejects with `error` instead. */
  failNext: (name: string, error: Error) => void
  /** The media uploaded, by id. */
  media: Map<
    string,
    { purpose: SponsorMediaPurpose; type: string; bytes: number }
  >
  /** The league's read: only `canManage` and no children matter here. */
  group: TeamStationClient['group']
  sponsorSample: (leagueId: string) => Promise<SampleVideo>
  sponsorState: (leagueId: string) => Promise<SponsorState>
  uploadSponsorMedia: (
    leagueId: string,
    purpose: SponsorMediaPurpose,
    contentType: string,
    bytes: Uint8Array
  ) => Promise<UploadedSponsorMedia>
  addSponsorLogo: (
    leagueId: string,
    logo: { mediaId: string; name: string; allocation: number }
  ) => Promise<SponsorState>
  setSponsorLogoAllocation: (
    id: string,
    allocation: number
  ) => Promise<SponsorState>
  deactivateSponsorLogo: (id: string) => Promise<SponsorState>
  addSponsorReel: (
    leagueId: string,
    reel: { mediaId: string; name: string; allocation: number }
  ) => Promise<SponsorState>
  setSponsorReelAllocation: (
    id: string,
    allocation: number
  ) => Promise<SponsorState>
  deactivateSponsorReel: (id: string) => Promise<SponsorState>
  addSponsorRow: (
    leagueId: string,
    row: SponsorRowInput
  ) => Promise<SponsorState>
  editSponsorRow: (
    id: string,
    patch: Partial<SponsorRowInput>
  ) => Promise<SponsorState>
  deleteSponsorRow: (id: string) => Promise<SponsorState>
}

/** The fake server. Every refusal is a 400 with the rule's sentence. */
export function fakeSponsorClient({
  state: start = emptySponsorState(),
  now = () => new Date(),
  canManage = true,
  sample = NODE_SAMPLE
}: FakeSponsorClientOptions = {}): FakeSponsorClient {
  let state = start
  let next = 1
  const failures = new Map<string, Error>()
  const calls: FakeCall[] = []
  const media: FakeSponsorClient['media'] = new Map()

  async function serve<T>(
    name: string,
    args: unknown[],
    run: () => T
  ): Promise<T> {
    calls.push({ name, args })
    await Promise.resolve()
    const failure = failures.get(name)
    if (failure != null) {
      failures.delete(name)
      throw failure
    }
    try {
      return run()
    } catch (caught) {
      if (caught instanceof SponsorRuleError) throw badRequest(caught.message)
      throw caught
    }
  }
  const urlOf = (mediaId: string): string => {
    if (!media.has(mediaId))
      throw badRequest('That upload is not this league’s.')
    return `https://example.test/media/${mediaId}`
  }
  const check = (problem: string | null): void => {
    if (problem != null) throw badRequest(problem)
  }
  const change = (next: SponsorState): SponsorState => {
    state = next
    return state
  }

  return {
    calls,
    media,
    state: () => state,
    setState: next => {
      state = next
    },
    failNext: (name, error) => {
      failures.set(name, error)
    },
    group: (async (ref: unknown) =>
      await serve('group', [ref], () => {
        if (canManage === 'fails') throw new Error('offline')
        return { canManage, children: [] }
      })) as unknown as TeamStationClient['group'],
    sponsorSample: async leagueId =>
      await serve('sponsorSample', [leagueId], () => {
        if (sample === 'fails') throw new Error('offline')
        return sample
      }),
    sponsorState: async leagueId =>
      await serve('sponsorState', [leagueId], () => state),
    uploadSponsorMedia: async (leagueId, purpose, contentType, bytes) =>
      await serve(
        'uploadSponsorMedia',
        [leagueId, purpose, contentType, bytes.length],
        () => {
          const mediaId = `smd_${next++}`
          media.set(mediaId, {
            purpose,
            type: contentType,
            bytes: bytes.length
          })
          return {
            mediaId,
            url: `https://example.test/media/${mediaId}`,
            width: 0,
            height: 0,
            durationMs: purpose === 'reel' ? 12_000 : null
          }
        }
      ),
    addSponsorLogo: async (leagueId, logo) =>
      await serve('addSponsorLogo', [leagueId, logo], () => {
        check(
          allocationProblem(
            state.logos,
            state.totals.logoCredits,
            null,
            logo.allocation,
            'game logo'
          )
        )
        return change({
          ...state,
          logos: [
            ...state.logos,
            {
              id: `slg_${next++}`,
              name: logo.name,
              imageUrl: urlOf(logo.mediaId),
              allocation: logo.allocation,
              used: 0,
              active: true
            }
          ]
        })
      }),
    setSponsorLogoAllocation: async (id, allocation) =>
      await serve('setSponsorLogoAllocation', [id, allocation], () =>
        change({
          ...state,
          logos: allocated(
            state.logos,
            state.totals.logoCredits,
            id,
            allocation,
            'game logo'
          )
        })
      ),
    deactivateSponsorLogo: async id =>
      await serve('deactivateSponsorLogo', [id], () =>
        change({ ...state, logos: deactivated(state.logos, id) })
      ),
    addSponsorReel: async (leagueId, reel) =>
      await serve('addSponsorReel', [leagueId, reel], () => {
        check(
          allocationProblem(
            state.reels,
            state.totals.reelCredits,
            null,
            reel.allocation,
            'broadcast'
          )
        )
        return change({
          ...state,
          reels: [
            ...state.reels,
            {
              id: `srl_${next++}`,
              name: reel.name,
              videoUrl: urlOf(reel.mediaId),
              posterUrl: '',
              durationSec: 12,
              allocation: reel.allocation,
              used: 0,
              active: true
            }
          ]
        })
      }),
    setSponsorReelAllocation: async (id, allocation) =>
      await serve('setSponsorReelAllocation', [id, allocation], () =>
        change({
          ...state,
          reels: allocated(
            state.reels,
            state.totals.reelCredits,
            id,
            allocation,
            'broadcast'
          )
        })
      ),
    deactivateSponsorReel: async id =>
      await serve('deactivateSponsorReel', [id], () =>
        change({ ...state, reels: deactivated(state.reels, id) })
      ),
    addSponsorRow: async (leagueId, row) =>
      await serve('addSponsorRow', [leagueId, row], () => {
        checkPlacementSlot(state)
        return change({
          ...state,
          placements: [
            ...state.placements,
            {
              id: `ser_${next++}`,
              logoUrl: urlOf(row.logoMediaId),
              backgroundUrl: urlOf(row.backgroundMediaId),
              title: row.title,
              message: row.message,
              url: row.url,
              textColor: row.textColor,
              startsAt: row.startsAt,
              placedAt: now().toISOString()
            }
          ]
        })
      }),
    editSponsorRow: async (id, patch) =>
      await serve('editSponsorRow', [id, patch], () => {
        const placement = checkPlacementEdit(state, id, now())
        const { logoMediaId, backgroundMediaId, ...fields } = patch
        const edited = {
          ...placement,
          ...fields,
          ...(logoMediaId != null ? { logoUrl: urlOf(logoMediaId) } : {}),
          ...(backgroundMediaId != null
            ? { backgroundUrl: urlOf(backgroundMediaId) }
            : {})
        }
        return change({
          ...state,
          placements: state.placements.map(each =>
            each.id === id ? edited : each
          )
        })
      }),
    deleteSponsorRow: async id =>
      await serve('deleteSponsorRow', [id], () =>
        change(placementDeleted(state, id, now()))
      )
  }
}
