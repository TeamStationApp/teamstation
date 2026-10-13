/** A request ID is supplied only when the server permits opening its terms. */
export interface GameListOpenOptions {
  tab?: 'info' | 'watch' | 'boxScore'
  autoPlay?: boolean
  pendingRequestId?: string | null
}

export function gameListOptions(
  game: {
    pendingApproval?: boolean
    pendingRequestId?: string | null
    videoCount?: number
  },
  mode: 'schedule' | 'videos',
  /** A non-member's game never plays: the video is kept for members. */
  nonMemberView = false
): GameListOpenOptions | undefined {
  if (game.pendingApproval === true && mode === 'schedule') {
    return game.pendingRequestId == null
      ? undefined
      : { pendingRequestId: game.pendingRequestId }
  }
  // Unpublished projected events have no recordings. A Videos control opens
  // the retained published recording even while a scheduling change is pending.
  if (mode === 'videos' && (game.videoCount ?? 0) === 0) return undefined
  return {
    ...(mode === 'videos' ? { tab: 'watch' as const } : {}),
    autoPlay: !nonMemberView && mode === 'videos' && (game.videoCount ?? 0) > 0
  }
}
