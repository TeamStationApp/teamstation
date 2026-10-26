/**
 * The chat crypto bench's address on the web: in a bundle `src/build.mjs
 * --serve` makes, where esbuild defines `__DEV__` true, and in no other.
 *
 * Only the address, so the routes, which the server's Tess sitemap reads as
 * well, never import the bench itself (`chatBench.ts`). The phone's twin
 * (`chatBenchPath.native.ts`) takes it from the phone's bench.
 */
// esbuild's and React Native's name for it, which nothing defines on the
// server, so it is declared here rather than taken from the app's globals.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __DEV__: boolean | undefined

export const chatBenchPath: string | undefined =
  typeof __DEV__ !== 'undefined' && __DEV__ ? '/dev/chat-bench' : undefined
