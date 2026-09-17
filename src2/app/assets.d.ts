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
