/**
 * The loaders every esbuild bundle of the app's code takes, the web build's
 * and each test, fixture and coverage bundler's alike: pictures inline, and
 * the crowd's sounds as files beside the bundle. One map, so a bundle that
 * reaches a new kind of asset never fails for want of its loader. It sits
 * beside build.mjs because a server build ships `src`, not `scripts`.
 */
export const ASSET_LOADER = Object.freeze({
  '.png': 'dataurl',
  '.jpg': 'dataurl',
  '.svg': 'dataurl',
  '.m4a': 'file'
})
