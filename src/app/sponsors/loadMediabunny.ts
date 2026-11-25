// Mediabunny, which shrinks sponsor reels on the web, is a module of its own
// beside the bundle (`TS_MEDIABUNNY_URL`, src/build.mjs), imported only when
// a reel is picked. Its file makes no code URLs of its own: the page loads
// code only from its own origin, as `script-src 'self'` allows.
import { SponsorRuleError } from '../../common/sponsors/sponsorRules'
import type * as MediabunnyModule from './mediabunnyModule'
import { NO_WEBCODECS } from './noWebCodecs'

export type Mediabunny = typeof MediabunnyModule

declare const TS_MEDIABUNNY_URL: string | undefined

/** The module at the build's address; a build without one cannot shrink a reel. */
export async function loadMediabunny(): Promise<Mediabunny> {
  if (typeof TS_MEDIABUNNY_URL !== 'string')
    throw new SponsorRuleError(NO_WEBCODECS)
  // An address made at run time, so the bundler leaves the import to the
  // browser rather than folding the module into the bundle.
  const address = new URL(TS_MEDIABUNNY_URL, window.location.href).href
  return (await import(address)) as Mediabunny
}
