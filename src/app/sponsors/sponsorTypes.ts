// The sponsor features demo's data. The screens read and change it only
// through `SponsorStore` (sponsorStore.ts), so an API-backed store can take
// the mock's place without a screen changing.

/** What the league has bought: credits for logos and reels, event slots. */
export interface SponsorTotals {
  /** Game logo credits: one game shown with one logo. */
  logoCredits: number
  /** Broadcast credits: one broadcast showing one reel. */
  reelCredits: number
  /** Event stream placements, ever. */
  eventSlots: number
}

/** A logo shown over game video, with the games allocated to it. */
export interface SponsorLogo {
  id: string
  name: string
  imageUrl: string
  /** Starts at 1 and goes up by 1 each time the image is changed. */
  version: number
  allocation: number
  used: number
  active: boolean
}

/** A 10–15 second reel shown in the scoreboard's place during broadcasts. */
export interface SponsorReel {
  id: string
  name: string
  /** The reel itself; empty for a seeded sample, which has only a poster. */
  videoUrl: string
  /** A still for the row; empty when the reel was picked from a file. */
  posterUrl: string
  durationSec: number
  version: number
  allocation: number
  used: number
  active: boolean
}

/** A sponsored row in the league's event stream. */
export interface EventPlacement {
  id: string
  logoUrl: string
  backgroundUrl: string
  title: string
  message: string
  url: string
  /** When the row shows, as an ISO date-time. */
  startsAt: string
  /** When the administrator placed it, as an ISO date-time. */
  placedAt: string
}

export interface SponsorState {
  totals: SponsorTotals
  logos: SponsorLogo[]
  reels: SponsorReel[]
  placements: EventPlacement[]
  /** Placements deleted more than 24 hours after they were placed. */
  keptSlots: number
}

/** A file the administrator dropped or chose, held as an object URL. */
export interface PickedFile {
  name: string
  /** The MIME type the browser gave the file. */
  type: string
  size: number
  url: string
}

/**
 * An event stream placement as the form holds it. On an edit, a `null`
 * logo or background keeps the placement's current image.
 */
export interface PlacementDraft {
  logo: PickedFile | null
  background: PickedFile | null
  title: string
  message: string
  url: string
  /** An ISO date-time, or empty when none is chosen. */
  startsAt: string
}

export type PlacementField = keyof PlacementDraft

/** The sentence for each placement field that fails its check. */
export type PlacementProblems = Partial<Record<PlacementField, string>>
