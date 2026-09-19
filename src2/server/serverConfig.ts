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
  /** Where the API listens. Caddy proxies gamestation.co to this. */
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
   * PeerTube's database, read-only, used only by the importer. Empty until
   * the `gamestation_peertube_ro` role exists on the production host.
   */
  peertubeDatabaseUrl: asOptional(asString, ''),

  /** Where uploads and live streams are remuxed before they go to the Space. */
  workDir: asOptional(asString, '/mnt/gamestation/work'),

  /** Finished HLS, served from here until it is verified in the Space. */
  mediaDir: asOptional(asString, '/mnt/gamestation/media'),

  /** PeerTube's HLS, mounted read-only and served in place until cutover. */
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
      secretAccessKey: asOptional(asString, ''),
      pathStyle: asOptional(asBoolean, false)
    }),
    {
      endpoint: 'https://sfo3.digitaloceanspaces.com',
      region: 'sfo3',
      bucket: 'gamestation',
      accessKeyId: '',
      secretAccessKey: '',
      pathStyle: false
    }
  ),

  /**
   * Where sign-in codes are sent from. Empty means nothing is sent, and the
   * code is only written to the log — which is fine in development and is a
   * locked door in production, since 34 of the migrated accounts have no
   * password and a code is their only way in.
   */
  smtp: asOptional(
    asObject({
      host: asOptional(asString, ''),
      port: asOptional(asNumber, 587),
      secure: asOptional(asBoolean, false),
      user: asOptional(asString, ''),
      password: asOptional(asString, ''),
      fromAddress: asOptional(asString, ''),
      fromName: asOptional(asString, 'GameStation')
    }),
    {
      host: '',
      port: 587,
      secure: false,
      user: '',
      password: '',
      fromAddress: '',
      fromName: 'GameStation'
    }
  ),

  /** Signing key for session tokens. Generated on first run if left empty. */
  sessionSecret: asOptional(asString, ''),

  /** Signs `/media` playback tokens. Caddy checks them through forward_auth. */
  mediaSecret: asOptional(asString, ''),

  /** The origin playback URLs are built against. */
  publicUrl: asOptional(asString, 'http://127.0.0.1:9100'),

  /**
   * Serve `/media` from Node. **Development only**: in production Caddy serves
   * those bytes, and turning this on would put every segment of every video
   * through the API.
   */
  serveMediaLocally: asOptional(asBoolean, false),

  /** Origins the app may call the API from. */
  corsOrigins: asOptional(asArray(asString), [
    'http://localhost:8080',
    'http://127.0.0.1:8080'
  ]),

  /** Log every request. Noisy, but useful while the server is still new. */
  logRequests: asOptional(asBoolean, true),

  /**
   * Live streaming in: the RTMP ingest, and the URL people are given for it.
   *
   * `publicUrl` is what a stream URL is printed as — scheme, host and port,
   * no path — because the server cannot work out what name an encoder on
   * somebody's laptop reaches it by. Empty falls back to the bind address,
   * which is only ever right in development.
   *
   * The port is 1936 while PeerTube still holds 1935. Moving it changes every
   * URL shown from then on; keys already issued keep working, since the key is
   * not tied to the port.
   */
  live: asOptional(
    asObject({
      enabled: asOptional(asBoolean, true),
      bindHost: asOptional(asString, '0.0.0.0'),
      port: asOptional(asNumber, 1936),
      publicUrl: asOptional(asString, ''),
      /** The RTMP application name: `rtmp://host:port/<app>/<key>`. */
      app: asOptional(asString, 'live'),
      /** Segment length. A multiple of the encoder's keyframe interval. */
      segmentSeconds: asOptional(asNumber, 4),
      /** How long after a game's start its key stops working. */
      /**
       * How much room must be left before a new stream is allowed to start.
       *
       * A game writes steadily for hours; a volume that fills mid-game kills
       * ffmpeg and looks to an operator like a stream that stopped for no
       * reason. Refusing to start costs a sentence, which is cheaper.
       */
      freeDiskFloorGb: asOptional(asNumber, 10)
    }),
    {
      enabled: true,
      bindHost: '0.0.0.0',
      port: 1936,
      publicUrl: '',
      app: 'live',
      segmentSeconds: 4,
      freeDiskFloorGb: 10
    }
  )
})
export type ServerConfig = ReturnType<typeof asServerConfig>
export type SmtpSettings = ServerConfig['smtp']
export type LiveSettings = ServerConfig['live']

export const serverConfig: ServerConfig = makeConfig(
  asServerConfig,
  './serverConfig.json'
)
