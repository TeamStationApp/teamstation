// Sponsor features on the wire: what a league holds and what the client and
// server say about it. The admin screens read and change it only through a
// `SponsorStore`, and the server answers the whole `SponsorState` after
// every change.
import type { SponsorOverlay } from '../nodeSettings'

/** What the league holds: credits for logos and reels, event slots. */
export interface SponsorTotals {
  /** Game logo credits: one game shown with one logo. */
  logoCredits: number
  /** Broadcast credits: one broadcast showing one reel. */
  reelCredits: number
  /** Event stream placements, ever. */
  eventSlots: number
}

/**
 * A logo shown over game video, with the games allocated to it. Its image
 * never changes: a new logo is a new row.
 */
export interface SponsorLogo {
  id: string
  name: string
  imageUrl: string
  allocation: number
  used: number
  active: boolean
}

/** A 10–15 second reel shown in the scoreboard's place during broadcasts. */
export interface SponsorReel {
  id: string
  name: string
  /** The reel itself; empty for a sample with only a poster. */
  videoUrl: string
  /** A still for the row; empty when the reel's own first frame is drawn. */
  posterUrl: string
  durationSec: number
  allocation: number
  used: number
  active: boolean
}

/**
 * A sponsored row's title and message colour, each with a shadow to match:
 * dark text on a light shadow, or white text on a dark one.
 */
export type SponsoredTextColor = 'dark' | 'white'

/** A sponsored row in the league's event stream. */
export interface EventPlacement {
  id: string
  logoUrl: string
  backgroundUrl: string
  title: string
  message: string
  url: string
  /** Dark when not given. */
  textColor?: SponsoredTextColor
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

/** What an upload is for, which sets its checks. */
export type SponsorMediaPurpose = 'logo' | 'reel' | 'rowLogo' | 'rowBackground'

export const SPONSOR_MEDIA_PURPOSES: readonly SponsorMediaPurpose[] = [
  'logo',
  'reel',
  'rowLogo',
  'rowBackground'
]

/** A checked, stored upload, as `POST …/sponsors/media` answers it. */
export interface UploadedSponsorMedia {
  mediaId: string
  url: string
  width: number
  height: number
  durationMs: number | null
}

/**
 * The video the previews play: the league's own recording, from `window[0]`
 * to `window[1]` seconds, or the node's sample clip. `overlay` places the
 * logo and the reel as the node's settings do.
 */
export type SampleVideo = (
  | {
      kind: 'recording'
      videoId: string
      url: string
      window: [number, number]
    }
  | { kind: 'node'; url: string; window: [number, number] }
) & { overlay: SponsorOverlay }

/** A sponsor's logo over a game's video: the image and its own size. */
export interface GameSponsorLogo {
  url: string
  width: number
  height: number
}

/** One broadcast of a reel on a game's clock. */
export interface GameSponsorReel {
  /** The placement (`srp_`). */
  id: string
  reelId: string
  url: string
  width: number
  height: number
  /** When it starts, on the wall clock, in epoch ms. */
  startMs: number
  durationMs: number
}

/**
 * The sponsorship a game's players draw, as `GET /games/:gameId/sponsors`
 * answers it: the league whose sponsorship it is, its logo, its reels, and
 * where the node's settings put them. No league, no logo and no reels when
 * the game has none.
 */
export interface GameSponsors {
  leagueId: string | null
  logo: GameSponsorLogo | null
  reels: GameSponsorReel[]
  overlay: SponsorOverlay
}

/**
 * A sponsored row as a Schedule shows it, from `GET /sponsor-rows`: a live
 * row of a league that manages one of the Schedule's teams.
 */
export interface SponsoredRow {
  id: string
  /** The league whose event stream it is in. */
  leagueId: string
  logoUrl: string
  backgroundUrl: string
  title: string
  message: string
  /** An https address, opened when the row is tapped. */
  url: string
  textColor: SponsoredTextColor
  /** Where it sits among the Schedule's games, as an ISO date-time. */
  startsAt: string
}

/**
 * Whose Schedule the rows are for: a team's, a season's, or the signed-in
 * person's own combined Schedule. `public` reads a team or season as a
 * visitor does.
 */
export type SponsorRowsQuery =
  | { team: string; public?: boolean }
  | { season: string; public?: boolean }
  | { scope: 'me' }

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
  /** Dark when not given. */
  textColor?: SponsoredTextColor
  /** An ISO date-time, or empty when none is chosen. */
  startsAt: string
}

export type PlacementField = keyof PlacementDraft

/** The sentence for each placement field that fails its check. */
export type PlacementProblems = Partial<Record<PlacementField, string>>
