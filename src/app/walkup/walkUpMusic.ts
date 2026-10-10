import type { WalkUpMusic } from './walkUpMusicTypes'
export * from './walkUpMusicTypes'

async function unavailable(): Promise<never> {
  throw new Error('Walk-up music plays only in the phone app')
}

/**
 * The web's adapter: nothing to search and nothing to play, said once in
 * `available` so a screen can hide its buttons rather than offer ones that
 * fail. Walk-up songs are set and played from the phone app.
 */
const webMusic: WalkUpMusic = {
  available: false,
  djSupported: false,
  providerName: '',
  access: unavailable,
  search: unavailable,
  pickFile: unavailable,
  play: unavailable,
  stop: unavailable,
  onState: () => () => undefined
}
export default webMusic
