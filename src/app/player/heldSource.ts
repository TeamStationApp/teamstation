/**
 * What the game screen's own player is given while the angles are up: nothing,
 * on a phone, and its address in a browser.
 *
 * A browser's detach destroys hls.js and its buffers, so the page can keep its
 * address. A phone's detach only drops its listeners: ExoPlayer and AVPlayer
 * would go on holding a live stream, its decoders and a playlist refreshed
 * every few seconds, a fifth player nobody sees under the four tiles. With no
 * source the player is released, and the resume brings the moment back when
 * the angles close.
 */
export function heldSource(
  url: string | null,
  options: { anglesUp: boolean; platform: string }
): string | null {
  return options.anglesUp && options.platform !== 'web' ? null : url
}
