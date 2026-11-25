// Where the sponsor screens read and change their data. `SponsorStore` is
// async so an API-backed store can replace the in-memory mock without a
// screen changing. The mock applies the rules in sponsorRules.ts and keeps
// its state only in memory: a reload starts again from the seed.
import {
  allocated,
  allocationProblem,
  checkPlacementEdit,
  checkPlacementSlot,
  deactivated,
  logoFileProblem,
  placementDeleted,
  placementProblems,
  reelFileProblem,
  reelLengthProblem,
  SponsorRuleError
} from './sponsorRules'
import { emptySponsorState, sponsorSeed } from './sponsorSeed'
import type {
  EventPlacement,
  PickedFile,
  PlacementDraft,
  SponsorLogo,
  SponsorReel,
  SponsorState
} from './sponsorTypes'

export { SponsorRuleError } from './sponsorRules'

export type SponsorSeedName = 'sample' | 'empty'

export interface SponsorStore {
  read: () => Promise<SponsorState>
  subscribe: (listener: (state: SponsorState) => void) => () => void
  addLogo: (input: {
    picked: PickedFile
    allocation: number
  }) => Promise<SponsorState>
  setLogoAllocation: (id: string, allocation: number) => Promise<SponsorState>
  deactivateLogo: (id: string) => Promise<SponsorState>
  addReel: (input: {
    picked: PickedFile
    durationSec: number
    allocation: number
  }) => Promise<SponsorState>
  setReelAllocation: (id: string, allocation: number) => Promise<SponsorState>
  deactivateReel: (id: string) => Promise<SponsorState>
  addPlacement: (draft: PlacementDraft) => Promise<SponsorState>
  editPlacement: (id: string, draft: PlacementDraft) => Promise<SponsorState>
  deletePlacement: (id: string) => Promise<SponsorState>
  /** Demo only: back to the seeded rows, or to no rows at all. */
  reset: (seed: SponsorSeedName) => Promise<SponsorState>
}

export interface MockSponsorStoreOptions {
  /** The clock for placement times and the 24-hour window. */
  now?: () => Date
  seed?: SponsorSeedName
}

/** A file's name without its extension, as a row's name. */
function nameOf(picked: PickedFile): string {
  const name = picked.name.replace(/\.[^.]+$/, '')
  return name === '' ? picked.name : name
}

function check(problem: string | null): void {
  if (problem != null) throw new SponsorRuleError(problem)
}

function checkPlacement(draft: PlacementDraft, editing: boolean): void {
  const problems = Object.values(placementProblems(draft, editing))
  if (problems.length > 0) throw new SponsorRuleError(problems.join(' '))
}

export function createMockSponsorStore({
  now = () => new Date(),
  seed = 'sample'
}: MockSponsorStoreOptions = {}): SponsorStore {
  const seeded = (name: SponsorSeedName): SponsorState =>
    name === 'sample' ? sponsorSeed(now()) : emptySponsorState()
  let state = seeded(seed)
  let nextId = 1
  const listeners = new Set<(state: SponsorState) => void>()

  /**
   * Runs `change` on the current state. A broken rule rejects and leaves
   * the state as it was; otherwise the new state is kept and announced.
   */
  async function apply(
    change: (current: SponsorState) => SponsorState
  ): Promise<SponsorState> {
    await Promise.resolve()
    state = change(state)
    for (const listener of [...listeners]) listener(state)
    return state
  }
  const id = (kind: string): string => `${kind}-${nextId++}`

  return {
    async read() {
      await Promise.resolve()
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    addLogo: async ({ picked, allocation }) =>
      await apply(current => {
        check(logoFileProblem(picked))
        check(
          allocationProblem(
            current.logos,
            current.totals.logoCredits,
            null,
            allocation,
            'game logo'
          )
        )
        const logo: SponsorLogo = {
          id: id('logo'),
          name: nameOf(picked),
          imageUrl: picked.url,
          version: 1,
          allocation,
          used: 0,
          active: true
        }
        return { ...current, logos: [...current.logos, logo] }
      }),
    setLogoAllocation: async (logoId, allocation) =>
      await apply(current => ({
        ...current,
        logos: allocated(
          current.logos,
          current.totals.logoCredits,
          logoId,
          allocation,
          'game logo'
        )
      })),
    deactivateLogo: async logoId =>
      await apply(current => ({
        ...current,
        logos: deactivated(current.logos, logoId)
      })),
    addReel: async ({ picked, durationSec, allocation }) =>
      await apply(current => {
        check(reelFileProblem(picked))
        check(reelLengthProblem(durationSec))
        check(
          allocationProblem(
            current.reels,
            current.totals.reelCredits,
            null,
            allocation,
            'broadcast'
          )
        )
        const reel: SponsorReel = {
          id: id('reel'),
          name: nameOf(picked),
          videoUrl: picked.url,
          posterUrl: '',
          durationSec,
          version: 1,
          allocation,
          used: 0,
          active: true
        }
        return { ...current, reels: [...current.reels, reel] }
      }),
    setReelAllocation: async (reelId, allocation) =>
      await apply(current => ({
        ...current,
        reels: allocated(
          current.reels,
          current.totals.reelCredits,
          reelId,
          allocation,
          'broadcast'
        )
      })),
    deactivateReel: async reelId =>
      await apply(current => ({
        ...current,
        reels: deactivated(current.reels, reelId)
      })),
    addPlacement: async draft =>
      await apply(current => {
        checkPlacementSlot(current)
        checkPlacement(draft, false)
        const placement: EventPlacement = {
          id: id('placement'),
          // The checks above refuse a draft without both images.
          logoUrl: draft.logo?.url ?? '',
          backgroundUrl: draft.background?.url ?? '',
          title: draft.title,
          message: draft.message,
          url: draft.url,
          textColor: draft.textColor ?? 'dark',
          startsAt: new Date(draft.startsAt).toISOString(),
          placedAt: now().toISOString()
        }
        return { ...current, placements: [...current.placements, placement] }
      }),
    editPlacement: async (placementId, draft) =>
      await apply(current => {
        const placement = checkPlacementEdit(current, placementId, now())
        checkPlacement(draft, true)
        const edited: EventPlacement = {
          ...placement,
          logoUrl: draft.logo?.url ?? placement.logoUrl,
          backgroundUrl: draft.background?.url ?? placement.backgroundUrl,
          title: draft.title,
          message: draft.message,
          url: draft.url,
          textColor: draft.textColor ?? placement.textColor ?? 'dark',
          startsAt: new Date(draft.startsAt).toISOString()
        }
        return {
          ...current,
          placements: current.placements.map(each =>
            each.id === placementId ? edited : each
          )
        }
      }),
    deletePlacement: async placementId =>
      await apply(current => placementDeleted(current, placementId, now())),
    reset: async name => await apply(() => seeded(name))
  }
}

const leagueStores = new Map<string, SponsorStore>()

/**
 * The league's mock store. It lives as long as the page, so moving between
 * the sponsor screens keeps the numbers and a reload starts over.
 */
export function sponsorStoreFor(leagueId: string): SponsorStore {
  let store = leagueStores.get(leagueId)
  if (store == null) {
    store = createMockSponsorStore()
    leagueStores.set(leagueId, store)
  }
  return store
}
