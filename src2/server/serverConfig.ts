import { makeConfig } from 'cleaner-config'
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'

import {
  asAuthority,
  type Authority,
  hostOf,
  httpOrigin,
  PRIMARY_HOST
} from '../common/primaryUrl'

export const asServerConfig = asObject({
  /** Where the API listens. */
  listenHost: asOptional(asString, '127.0.0.1'),
  listenPort: asOptional(asNumber, 9100),

  /**
   * How many worker processes to fork. Zero means one per CPU, which is what
   * production wants; set it to 1 when debugging so breakpoints behave.
   */
  clusterWorkers: asOptional(asNumber, 0),

  /**
   * Whether this process forks and supervises the stats builder.
   *
   * On by default. Only for debugging: switch it off to run `stats-builder`
   * by hand beside the server.
   */
  statsBuilder: asOptional(asBoolean, true),

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
  /**
   * Where a Director's upload waits while its parts arrive.
   *
   * Its own setting rather than a corner of `mediaDir`, because the two are
   * different kinds of thing: media is what the site serves and may be
   * read-only, while this is scratch — gigabytes of parts that exist for an
   * hour and are deleted.
   *
   * Empty means `<mediaDir>/uploads`.
   */
  uploadsDir: asOptional(asString, ''),

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
   * locked door in production, since many of the migrated accounts have no
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

  /** Signs `/media` playback tokens. The reverse proxy has them checked. */
  mediaSecret: asOptional(asString, ''),

  /**
   * What this deployment is called, where that is not `PRIMARY_HOST`.
   *
   * A **host**, with no scheme: `devhost2.examplegs.test`, `127.0.0.1:9100`.
   * `https` is implied, except for an IP address or `localhost`, which imply
   * `http`; the stream URL is built from the same name. Every link this
   * server hands out — playback, invites, sign-in, RTMP — is built from it.
   *
   * Empty is production, which is the whole point of it being empty: the one
   * deployment that runs at the address in the source says nothing, and the
   * development clones each say their own name once, here, instead of a
   * branch editing a tracked file it must then remember not to land.
   */
  primaryUrlOverride: asOptional(asString, ''),

  /**
   * Serve `/media` from Node. **Development only**: in production a proxy serves
   * those bytes, and turning this on would put every segment of every video
   * through the API.
   */
  serveMediaLocally: asOptional(asBoolean, false),

  /**
   * Whether this deployment deletes recordings an upload replaced, once their
   * month is up.
   *
   * **Off by default, and it has to be, because a bucket may be shared.**
   * Another deployment may hold rows naming the same objects, and one that
   * swept would delete bytes the other is serving. The deletion is real and
   * irreversible, so it is opt-in per deployment rather than something a
   * branch can switch on by being deployed.
   */
  purgeReplacedRecordings: asOptional(asBoolean, false),

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
   * `bindHost` is what the ingest listens on; what a stream URL is *printed*
   * as comes from `primaryUrlOverride` above, because the name an encoder on
   * somebody's laptop reaches this machine by is the same name a browser
   * reaches it by, and there is no reason for a deployment to say it twice.
   *
   * Moving the port changes every URL shown from then on; keys already issued keep working, since the key is
   * not tied to the port.
   */
  live: asOptional(
    asObject({
      enabled: asOptional(asBoolean, true),
      bindHost: asOptional(asString, '0.0.0.0'),
      port: asOptional(asNumber, 1936),
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

/**
 * What this server is called: a host, with a port only where it has one.
 *
 * The override when a deployment sets one, and otherwise the name in the
 * source, which is what production runs on. Resolved once, here, so no caller
 * has to remember which of the two it is.
 */
export const primaryAuthority: Authority =
  serverConfig.primaryUrlOverride === ''
    ? PRIMARY_HOST
    : asAuthority(serverConfig.primaryUrlOverride)

/** The same name with the scheme it implies: the origin links are built on. */
export const publicUrl: string = httpOrigin(primaryAuthority)

/** The same name again with no port, which is what a stream URL names. */
export const primaryHost: string = hostOf(primaryAuthority)
