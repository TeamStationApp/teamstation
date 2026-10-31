/**
 * Plays one of the game's videos by its id, as a camera row's tap and Video
 * details' Play ask. A camera can name a video the game's own list does not
 * hold yet, such as an upload that became ready since the game was read, so
 * the list is read again and the video played once it is there, rather than
 * a tap doing nothing. A video still missing then is not played: the row
 * that offered it is read again at the next poll.
 *
 * `reread` answers the game's videos fresh, or nothing when the screen has
 * moved on to another game meanwhile.
 */
export async function playById<Video extends { id: string }>(
  id: string,
  options: {
    listed: readonly Video[]
    reread: () => Promise<readonly Video[] | undefined>
    play: (video: Video) => void
  }
): Promise<void> {
  const found = options.listed.find(one => one.id === id)
  if (found != null) {
    options.play(found)
    return
  }
  const fresh = await options.reread()
  const arrived = fresh?.find(one => one.id === id)
  if (arrived != null) options.play(arrived)
}
