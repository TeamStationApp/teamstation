import { asAuthority, httpOrigin, PRIMARY_HOST } from '../../common/primaryUrl'
import { asServerConfig, type ServerConfig } from '../serverConfigSchema'
import { spaceConfigured } from './spacesHls'

/**
 * Every origin the web app loads media from, for its Content-Security-Policy
 * (`img-src`, `media-src` and `connect-src`; see `src/buildCsp.mjs`).
 *
 * - **The deployment's own origin**, always first. Playback playlists and
 *   posters are absolute URLs on it, and `'self'` misses them whenever the
 *   page and the API answer on different origins — as they do locally, with
 *   the app on :8080 and the API on :9100.
 * - **The Space**, when one is configured (its keys set): the bucket's own
 *   subdomain, or the endpoint itself for a path-style stand-in. Presigned
 *   video, image and chat attachment URLs point there.
 * - **Apple Music's artwork**, `https://*.mzstatic.com`, for walk-up songs.
 */
export function mediaOrigins(config: ServerConfig): string[] {
  const primary = httpOrigin(
    config.primaryUrlOverride === ''
      ? PRIMARY_HOST
      : asAuthority(config.primaryUrlOverride)
  )
  const origins = [primary]
  const space = config.space
  if (spaceConfigured(space)) {
    const endpoint = new URL(space.endpoint)
    origins.push(
      space.pathStyle
        ? endpoint.origin
        : `${endpoint.protocol}//${space.bucket}.${endpoint.host}`
    )
  }
  origins.push('https://*.mzstatic.com')
  return [...new Set(origins)]
}

/** `mediaOrigins` of a config as it is written in `serverConfig.json`. */
export function mediaOriginsOfJson(json: unknown): string[] {
  return mediaOrigins(asServerConfig(json))
}
