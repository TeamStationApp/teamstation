/**
 * What the game's owner does through the API during a targeted run: end one
 * camera, as the person running the team can (`POST …/live-streams/:id/end`).
 * The session token is the owner's, from an e-mailed code (`sessionToken`); it
 * stays in memory and is never logged.
 */

export interface OwnerApiOptions {
  /** The stack's API root, `…/api/v1`. */
  api: string
  token: string
  fetch?: typeof fetch
}

export interface OwnerApi {
  /** Ends the camera now; the ingest closes its playlist within moments. */
  endCamera: (gameId: string, streamId: string) => Promise<void>
}

export function ownerApi(options: OwnerApiOptions): OwnerApi {
  const call = options.fetch ?? fetch
  const root = options.api.replace(/\/$/, '')
  return {
    endCamera: async (gameId, streamId) => {
      const path = `/games/${encodeURIComponent(gameId)}/live-streams/${encodeURIComponent(streamId)}/end`
      const answer = await call(`${root}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}` }
      })
      if (!answer.ok) {
        throw new Error(
          `the stack would not end camera ${streamId}: ${answer.status}`
        )
      }
    }
  }
}
