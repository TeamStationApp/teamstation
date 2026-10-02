import { videoFrameSource } from './locations'
import type { MediaContext } from './mediaContext'
import { warmStills } from './stills'

/**
 * Cuts the stills a highlight list will ask for.
 *
 * Nothing awaits this and nothing fails because of it: a thumbnail that is not
 * there yet is a grey rectangle, and a grey rectangle is a better answer than
 * a page that waits on FFmpeg before it draws.
 */
export async function warmVideoStills(
  media: MediaContext,
  storage: 'peertube' | 'local' | 'spaces',
  videoId: string,
  highlights: Array<{ playOffsetSec: number }>
): Promise<void> {
  try {
    const source = await videoFrameSource({
      mediaRoot: media.mediaRoot,
      space: media.space,
      storage,
      videoId
    })
    if (source == null) return
    await warmStills({
      ffmpegPath: media.ffmpegPath,
      source,
      space: media.space,
      videoId,
      seconds: highlights.map(highlight => highlight.playOffsetSec)
    })
  } catch {
    // A thumbnail that is not there is not worth reporting as an error.
  }
}
