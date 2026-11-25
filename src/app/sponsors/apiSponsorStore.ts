// The sponsor screens' store on the server's API. Each change answers the
// league's whole `SponsorState`, which every subscriber hears. A picture or
// reel is uploaded before the call that uses it, so a failed upload adds or
// changes nothing.
import type { SponsorRowInput, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  NAME_LIMIT,
  placementProblems,
  SponsorRuleError
} from '../../common/sponsors/sponsorRules'
import { prepareMedia } from './prepareMedia'
import type { SponsorStore } from './sponsorStore'
import type {
  PickedFile,
  PlacementDraft,
  PreparedFile,
  SponsorMediaPurpose,
  SponsorState
} from './sponsorTypes'

/** The client calls the store makes, so a test can stand in for the server. */
export type SponsorClient = Pick<
  TeamStationClient,
  | 'sponsorState'
  | 'uploadSponsorMedia'
  | 'addSponsorLogo'
  | 'setSponsorLogoAllocation'
  | 'deactivateSponsorLogo'
  | 'addSponsorReel'
  | 'setSponsorReelAllocation'
  | 'deactivateSponsorReel'
  | 'addSponsorRow'
  | 'editSponsorRow'
  | 'deleteSponsorRow'
>

export interface ApiSponsorStoreOptions {
  /** Shrinks a row's picture before it is uploaded; `prepareMedia` by default. */
  prepare?: (
    purpose: SponsorMediaPurpose,
    picked: PickedFile
  ) => Promise<PreparedFile>
}

/**
 * A file's name without its extension, as a row's name: cut to the
 * `NAME_LIMIT` code points the server takes, since the admin never types it
 * and has no field to shorten it in.
 */
export function nameOf(picked: Pick<PickedFile, 'name'>): string {
  const bare = picked.name.replace(/\.[^.]+$/, '').trim()
  const name = bare === '' ? picked.name.trim() : bare
  return Array.from(name).slice(0, NAME_LIMIT).join('').trimEnd()
}

/** A server refusal as the sentence the screen shows; anything else as is. */
function asRuleError(caught: unknown): unknown {
  if (caught instanceof HttpError && caught.code === 'badRequest')
    return new SponsorRuleError(caught.message)
  return caught
}

/** A form's date and time, local or ISO, as an ISO date-time. */
function isoOf(startsAt: string): string {
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime()))
    throw new SponsorRuleError('Choose a date and time.')
  return date.toISOString()
}

function checkDraft(draft: PlacementDraft, editing: boolean): void {
  const problems = Object.values(placementProblems(draft, editing))
  if (problems.length > 0) throw new SponsorRuleError(problems.join(' '))
}

/** The league's sponsor store on `client`. */
export function createApiSponsorStore(
  client: SponsorClient,
  leagueId: string,
  { prepare = prepareMedia }: ApiSponsorStoreOptions = {}
): SponsorStore {
  const listeners = new Set<(state: SponsorState) => void>()

  /** Runs `call`; its answer is announced, a refusal is a rule error. */
  async function apply(
    call: () => Promise<SponsorState>
  ): Promise<SponsorState> {
    let state: SponsorState
    try {
      state = await call()
    } catch (caught) {
      throw asRuleError(caught)
    }
    for (const listener of [...listeners]) listener(state)
    return state
  }

  async function upload(
    purpose: SponsorMediaPurpose,
    file: PreparedFile
  ): Promise<string> {
    const uploaded = await client.uploadSponsorMedia(
      leagueId,
      purpose,
      file.type,
      file.bytes
    )
    return uploaded.mediaId
  }

  /** Shrinks and uploads a row's picture, answering its media id. */
  async function uploadPicture(
    purpose: 'rowLogo' | 'rowBackground',
    picked: PickedFile
  ): Promise<string> {
    return await upload(purpose, await prepare(purpose, picked))
  }

  return {
    read: async () =>
      await apply(async () => await client.sponsorState(leagueId)),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    addLogo: async ({ picked, allocation }) =>
      await apply(async () => {
        const mediaId = await upload('logo', picked)
        return await client.addSponsorLogo(leagueId, {
          mediaId,
          name: nameOf(picked),
          allocation
        })
      }),
    setLogoAllocation: async (logoId, allocation) =>
      await apply(
        async () => await client.setSponsorLogoAllocation(logoId, allocation)
      ),
    deactivateLogo: async logoId =>
      await apply(async () => await client.deactivateSponsorLogo(logoId)),
    addReel: async ({ picked, allocation }) =>
      await apply(async () => {
        const mediaId = await upload('reel', picked)
        return await client.addSponsorReel(leagueId, {
          mediaId,
          name: nameOf(picked),
          allocation
        })
      }),
    setReelAllocation: async (reelId, allocation) =>
      await apply(
        async () => await client.setSponsorReelAllocation(reelId, allocation)
      ),
    deactivateReel: async reelId =>
      await apply(async () => await client.deactivateSponsorReel(reelId)),
    addPlacement: async draft =>
      await apply(async () => {
        checkDraft(draft, false)
        const { logo, background } = draft
        // The check above refuses a draft without both pictures.
        if (logo == null || background == null)
          throw new SponsorRuleError('Choose a logo and a background image.')
        const row: SponsorRowInput = {
          logoMediaId: await uploadPicture('rowLogo', logo),
          backgroundMediaId: await uploadPicture('rowBackground', background),
          title: draft.title,
          message: draft.message,
          url: draft.url,
          textColor: draft.textColor ?? 'dark',
          startsAt: isoOf(draft.startsAt)
        }
        return await client.addSponsorRow(leagueId, row)
      }),
    editPlacement: async (rowId, draft) =>
      await apply(async () => {
        checkDraft(draft, true)
        const patch: Partial<SponsorRowInput> = {}
        // A picture left as it was sends no media id: the row keeps it.
        if (draft.logo != null)
          patch.logoMediaId = await uploadPicture('rowLogo', draft.logo)
        if (draft.background != null)
          patch.backgroundMediaId = await uploadPicture(
            'rowBackground',
            draft.background
          )
        patch.title = draft.title
        patch.message = draft.message
        patch.url = draft.url
        patch.textColor = draft.textColor ?? 'dark'
        patch.startsAt = isoOf(draft.startsAt)
        return await client.editSponsorRow(rowId, patch)
      }),
    deletePlacement: async rowId =>
      await apply(async () => await client.deleteSponsorRow(rowId))
  }
}
