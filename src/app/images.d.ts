/**
 * esbuild inlines these as data URLs (`loader` in `build.mjs`), so an import
 * yields a string the `source` of an `Image` accepts. TypeScript has no idea
 * a bundler is involved, so it is told here.
 */
declare module '*.png' {
  const uri: string
  export default uri
}
declare module '*.jpg' {
  const uri: string
  export default uri
}
declare module '*.svg' {
  const uri: string
  export default uri
}
/**
 * A sound, a file beside the bundle (`'.m4a': 'file'`): its root-relative
 * address on the web. Metro hands React Native an asset id instead, which
 * `crowdPlayer.native.tsx` reads through `require`.
 */
declare module '*.m4a' {
  const uri: string
  export default uri
}
