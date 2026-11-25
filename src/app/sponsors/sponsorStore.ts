// Where the sponsor screens read and change a league's sponsor data: one
// `SponsorStore` per league, backed by the server (apiSponsorStore.ts).
// Every change resolves the whole `SponsorState` the server answers.
import type { TeamStationClient } from '../../common/api'
import { createApiSponsorStore, type SponsorClient } from './apiSponsorStore'
import type { PlacementDraft, PreparedFile, SponsorState } from './sponsorTypes'
import type { SampleClient } from './useSponsorSample'

export { SponsorRuleError } from '../../common/sponsors/sponsorRules'

export interface SponsorStore {
  read: () => Promise<SponsorState>
  subscribe: (listener: (state: SponsorState) => void) => () => void
  /** Uploads the shrunk logo, then lists it with its allocation. */
  addLogo: (input: {
    picked: PreparedFile
    allocation: number
  }) => Promise<SponsorState>
  setLogoAllocation: (id: string, allocation: number) => Promise<SponsorState>
  deactivateLogo: (id: string) => Promise<SponsorState>
  /** Uploads the shrunk reel, then lists it with its allocation. */
  addReel: (input: {
    picked: PreparedFile
    durationSec: number
    allocation: number
  }) => Promise<SponsorState>
  setReelAllocation: (id: string, allocation: number) => Promise<SponsorState>
  deactivateReel: (id: string) => Promise<SponsorState>
  /** Shrinks and uploads the row's logo and background, then places it. */
  addPlacement: (draft: PlacementDraft) => Promise<SponsorState>
  /** Uploads only the pictures that changed, then edits the row. */
  editPlacement: (id: string, draft: PlacementDraft) => Promise<SponsorState>
  deletePlacement: (id: string) => Promise<SponsorState>
}

const leagueStores = new WeakMap<object, Map<string, SponsorStore>>()

/**
 * The league's store on `client`. It lives as long as the session, so
 * moving between the sponsor screens shares one state and one set of
 * subscribers.
 */
export function sponsorStoreFor(
  leagueId: string,
  client: SponsorClient
): SponsorStore {
  let stores = leagueStores.get(client)
  if (stores == null) {
    stores = new Map()
    leagueStores.set(client, stores)
  }
  let store = stores.get(leagueId)
  if (store == null) {
    store = createApiSponsorStore(client, leagueId)
    stores.set(leagueId, store)
  }
  return store
}

/** What a sponsor screen asks of the client: the league, its store and its sample. */
export type SponsorScreenClient = SponsorClient &
  SampleClient &
  Pick<TeamStationClient, 'group'>
