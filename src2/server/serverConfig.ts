import { makeConfig } from 'cleaner-config'
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'

export const asServerConfig = asObject({
  /** Where the API listens. */
  listenHost: asOptional(asString, '127.0.0.1'),
  listenPort: asOptional(asNumber, 9100),

  /**
   * How many worker processes to fork. Zero means one per CPU, which is what
   * production wants; set it to 1 when debugging so breakpoints behave.
   */
  clusterWorkers: asOptional(asNumber, 0),

  /** Postgres for GameStation's own data. */
  databaseUrl: asOptional(
    asString,
    'postgres://localhost:5432/gamestation_dev'
  ),

  /**
   * PeerTube's database, read-only, used only by the importer. Empty when
   * there is nothing to import.
   */
  peertubeDatabaseUrl: asOptional(asString, ''),

  /** Where uploads and live streams are remuxed before they go to the Space. */
  workDir: asOptional(asString, '/var/app/work'),

  /** Finished HLS, served from here until it is verified in the Space. */
  mediaDir: asOptional(asString, '/var/app/media'),

  /** PeerTube's HLS, read-only, for videos imported from it. */
  peertubeMediaDir: asOptional(asString, ''),

  /** The pinned build. The FFmpeg contract tests refuse to run on another. */
  ffmpegPath: asOptional(asString, '/opt/homebrew/bin/ffmpeg'),
  ffmpegVersion: asOptional(asString, '9.0.1'),

  /** DigitalOcean Space holding finished HLS. */
  space: asOptional(
    asObject({
      endpoint: asOptional(asString, 'https://sfo3.digitaloceanspaces.com'),
      region: asOptional(asString, 'sfo3'),
      bucket: asOptional(asString, 'gamestation'),
      accessKeyId: asOptional(asString, ''),
      secretAccessKey: asOptional(asString, '')
    }),
    {
      endpoint: 'https://sfo3.digitaloceanspaces.com',
      region: 'sfo3',
      bucket: 'gamestation',
      accessKeyId: '',
      secretAccessKey: ''
    }
  ),

  /** Signing key for session tokens. Generated on first run if left empty. */
  sessionSecret: asOptional(asString, ''),

  /** Origins the app may call the API from. */
  corsOrigins: asOptional(asArray(asString), ['http://localhost:8081']),

  /** Log every request. Noisy, but useful while tube2 is still new. */
  logRequests: asOptional(asBoolean, true)
})
export type ServerConfig = ReturnType<typeof asServerConfig>

export const serverConfig: ServerConfig = makeConfig(
  asServerConfig,
  './serverConfig.json'
)
