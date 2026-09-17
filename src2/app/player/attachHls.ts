import Hls from 'hls.js'

/**
 * Points a `<video>` at an HLS playlist, whichever way this browser needs.
 *
 * Safari plays HLS itself, and does it with hardware decoding on iOS and the
 * Mac, so it is given the URL directly. Chrome and Firefox play no HLS at all
 * without help; hls.js feeds them the same segments through Media Source
 * Extensions, which is also where Chrome's HEVC hardware decoding lives. One
 * playlist, one set of files, both paths.
 *
 * Returns the teardown, which the caller must run: hls.js holds a worker and
 * buffers ahead, and leaking one per visited game would eat the tab.
 */
export function attachHls(video: HTMLVideoElement, url: string): () => void {
  // Media Source first, which is the order hls.js itself recommends, and not
  // `canPlayType`: Chrome answers `maybe` for HLS whether or not it can
  // actually play it, so that answer decides nothing. Anything without Media
  // Source — iOS Safari — falls through to the native path below, which is
  // what it wants anyway.
  if (!Hls.isSupported()) {
    if (video.canPlayType('application/vnd.apple.mpegurl') === '') {
      // Neither MSE nor native HLS. The element is left alone rather than
      // handed a URL it cannot read.
      return () => undefined
    }
    video.src = url
    return () => {
      video.removeAttribute('src')
      video.load()
    }
  }

  const hls = new Hls({
    // A game is watched by seeking around it, not straight through, so there
    // is no point buffering minutes ahead of a position about to change.
    maxBufferLength: 30
  })
  hls.loadSource(url)
  hls.attachMedia(video)
  return () => {
    hls.destroy()
  }
}
