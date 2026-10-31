import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'

import { asHttpsUrl } from '../common/distribution'
import { asAppLinksConfig, asOrigin } from './appLinks/config'
import type { SpaceSettings } from './media/spacesHls'
import { asOAuthConfig } from './oauth/config'

export const asServerConfig = asObject({
  /** Separate restricted login; never substitute the application owner. */
  analyticsReaderUrl: asOptional(asString),
  logWriteToken: asOptional(asString),
  oauth: asOptional(asOAuthConfig),
  buildsUrl: asOptional(asHttpsUrl),
  /** Browser-restricted display key; never a server or Android credential. */
  googleMaps: asOptional(asObject({ webApiKey: asString })),
  googlePlaces: asOptional(
    asObject({
      apiKey: asString,
      baseUrl: asOptional(asString, 'https://places.googleapis.com')
    })
  ),
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

  /**
   * Whether this node's primary runs the purges, the key sweep, the reopening
   * of interrupted uploads, the chat reconciler and the stats builder (which
   * `statsBuilder` then still governs). True on exactly one node, false on the
   * others. The relay is not among them: each API primary is a candidate.
   *
   * These act on the disk of the node they run on, so a second API node needs
   * ownership first. A Director upload's parts are on the node that received
   * it, and reopening has no owner filter: a node with this off leaves its own
   * interrupted uploads `assembling`, and the jobs node's restart could reopen
   * another node's. Chat attachment and replaced-recording purges have the same
   * limit.
   */
  backgroundJobs: asOptional(asBoolean, true),

  /** Postgres for TeamStation's own data. */
  databaseUrl: asOptional(
    asString,
    'postgres://localhost:5432/teamstation_dev'
  ),

  /**
   * A transaction-mode connection pooler in front of the same database, which
   * request traffic goes through. Empty means `databaseUrl`, so a deployment
   * without a pooler connects directly. `LISTEN` and migrations never use it.
   */
  databasePoolUrl: asOptional(asString, ''),

  /**
   * How a process hears the server's notices. `postgres` holds a direct
   * connection in every process. `valkey` holds one, in one elected API
   * primary, which republishes to Valkey for the rest.
   */
  changeFeed: asOptional(asValue('postgres', 'valkey'), 'postgres'),

  /** How many connections each kind of process keeps in its pool. */
  databasePoolSizes: asOptional(
    asObject({
      worker: asOptional(asNumber, 10),
      primary: asOptional(asNumber, 3),
      statsBuilder: asOptional(asNumber, 3),
      ingest: asOptional(asNumber, 3)
    }),
    () => ({ worker: 10, primary: 3, statsBuilder: 3, ingest: 3 })
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
    asObject<SpaceSettings>({
      endpoint: asOptional(asString, 'https://sfo3.digitaloceanspaces.com'),
      region: asOptional(asString, 'sfo3'),
      bucket: asOptional(asString, 'media-bucket'),
      accessKeyId: asOptional(asString, ''),
      secretAccessKey: asOptional(asString, ''),
      pathStyle: asOptional(asBoolean, false),
      readOnlySource: asOptional(
        asObject({
          endpoint: asString,
          region: asString,
          bucket: asString,
          accessKeyId: asString,
          secretAccessKey: asString,
          pathStyle: asOptional(asBoolean, false),
          keys: asArray(asString)
        })
      )
    }),
    {
      endpoint: 'https://sfo3.digitaloceanspaces.com',
      region: 'sfo3',
      bucket: 'media-bucket',
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
      fromName: asOptional(asString, 'TeamStation')
    }),
    {
      host: '',
      port: 587,
      secure: false,
      user: '',
      password: '',
      fromAddress: '',
      fromName: 'TeamStation'
    }
  ),

  /** Signing key for session tokens. Generated on first run if left empty. */
  sessionSecret: asOptional(asString, ''),

  /** Signs `/media` playback tokens. The reverse proxy has them checked. */
  mediaSecret: asOptional(asString, ''),

  /**
   * Derives each account's key for device event control: the protocol a
   * Director uses to set the publishing event of nearby devices signed in to
   * the same account (`GET /api/v1/device-event-control/key`).
   *
   * Its own secret, and deliberately not `sessionSecret`, which also seals
   * live stream keys: this one can be rotated at any time, and the only cost
   * is that every device fetches its key again. Empty switches the feature
   * off; the route then answers 503 `deviceEventControlUnavailable`. Generate
   * one with 32 random bytes as hex. A secret shorter than 32 bytes is refused
   * the same way, and said at startup: its key ID, which every signed-in
   * device receives, would give it away.
   */
  deviceEventControlSecret: asOptional(asString, ''),

  /**
   * The issuer device event control derives each account's key from, where
   * that is not `publicUrl`.
   *
   * Devices cache their key per server and pair on the LAN only with peers
   * that name the same issuer, so the key must not change when the
   * deployment's public address does. A deployment that moves its address
   * names the old origin here and every key it ever handed out stays good.
   * Absent is `publicUrl`.
   */
  eventControlIssuer: asOptional(asOrigin),

  /**
   * The apps this server signs in through their own link hosts, and the other
   * servers those hosts may send a browser to (`src/server/appLinks/`).
   *
   * A sign-in request names its app's link host as `appOrigin`; one that is not
   * listed here is refused. The hosts listed here are answered with the app's
   * verification files and `GET /signin/:token`. Absent is no apps, which
   * refuses every `appOrigin` and leaves sign-in links on `publicUrl`.
   */
  appLinks: asOptional(asAppLinksConfig, () => ({
    knownServers: [],
    apps: []
  })),

  /**
   * What this deployment is called, where that is not `PRIMARY_HOST`.
   *
   * A **host**, with no scheme: `devhost2.example-ts.test`, `127.0.0.1:9100`.
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
   * Where this server reports crashes and unhandled errors: a Sentry DSN, and
   * the environment its events are filed under.
   *
   * An empty DSN reports nothing. An empty environment is worked out from
   * `primaryHost` — `production`, or a development seat's own name — so a
   * checkout without `primaryUrlOverride` would call itself production; one
   * that reports from a workstation says `development` here.
   */
  sentry: asOptional(
    asObject({
      dsn: asOptional(asString, ''),
      environment: asOptional(asString, '')
    }),
    { dsn: '', environment: '' }
  ),

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

  /**
   * Redis, which holds every game's scoreboard and carries its changes from
   * worker to worker. Empty `prefix` means `ts:<database name>`, so deployments
   * that share one Redis, each with its own database, never meet.
   *
   * `caFile` is the certificate authority to check TLS against, for a server
   * that signs with its own CA. Empty for a local Redis.
   */
  redis: asOptional(
    asObject({
      url: asOptional(asString, 'redis://127.0.0.1:6379'),
      prefix: asOptional(asString, ''),
      caFile: asOptional(asString, '')
    }),
    { url: 'redis://127.0.0.1:6379', prefix: '', caFile: '' }
  ),

  /**
   * Dictation on the scoring screen: xAI's dictation model for speech to text
   * and an LLM for the tool calls — xAI's by default, OpenAI's or Anthropic's
   * when their keys are here and the scorer picks one. Absent, the route is not mounted and
   * `/health` says so, which is how the client knows not to show the button.
   * `baseUrl` and `sttUrl` exist so a test can point either somewhere else.
   */
  dictation: asOptional(
    asObject({
      apiKey: asString,
      baseUrl: asOptional(asString, 'https://api.x.ai/v1'),
      sttUrl: asOptional(asString, 'wss://api.x.ai/v1/stt'),
      sttModel: asOptional(asString, 'grok-voice-transcribe-2.0'),
      model: asOptional(asString, 'grok-4.3'),
      /** Keys for the GPT and Claude models; without one, those are not offered. */
      openai: asOptional(
        asObject({
          apiKey: asString,
          baseUrl: asOptional(asString, 'https://api.openai.com/v1')
        })
      ),
      anthropic: asOptional(
        asObject({
          apiKey: asString,
          baseUrl: asOptional(asString, 'https://api.anthropic.com/v1')
        })
      )
    })
  ),

  /**
   * The replay's announcer: xAI's text to speech reads the sentences the
   * server writes from a game's own plays. `apiKey` falls back to
   * dictation's; with neither, narration is off and `/health` says so.
   * `baseUrl` exists so a test can point it somewhere else.
   */
  speech: asOptional(
    asObject({
      apiKey: asOptional(asString),
      baseUrl: asOptional(asString, 'https://api.x.ai/v1'),
      voice: asOptional(asString, 'rex'),
      speed: asOptional(asNumber, 1.1),
      bitRate: asOptional(asNumber, 64000)
    })
  ),

  /**
   * Tess, the assistant: Anthropic's Messages API. `apiKey` falls back to
   * dictation's Anthropic key; with neither, Tess is off and `/health` says
   * so. `baseUrl` exists so a test can point it somewhere else.
   */
  tess: asOptional(
    asObject({
      apiKey: asOptional(asString),
      baseUrl: asOptional(asString, 'https://api.anthropic.com/v1'),
      model: asOptional(asString, 'claude-sonnet-5-5')
    })
  ),

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
      /**
       * How much room must be left before a new stream is allowed to start.
       *
       * A game writes steadily for hours; a volume that fills mid-game kills
       * ffmpeg and looks to an operator like a stream that stopped for no
       * reason. Refusing to start costs a sentence, which is cheaper.
       */
      freeDiskFloorGb: asOptional(asNumber, 10),
      /**
       * Where the ingest process answers `GET /health`, on 127.0.0.1 only.
       *
       * Absent, it is `listenPort + 1000`: every deployment already has a
       * `listenPort` of its own, so every ingest gets a health port of its
       * own with nothing to set. 0 picks a free one, for tests.
       */
      healthPort: asOptional(asNumber)
    }),
    {
      enabled: true,
      bindHost: '0.0.0.0',
      port: 1936,
      app: 'live',
      segmentSeconds: 4,
      freeDiskFloorGb: 10,
      healthPort: undefined
    }
  )
})
export type ServerConfig = ReturnType<typeof asServerConfig>
export type SmtpSettings = ServerConfig['smtp']
/** `healthPort` is the ingest process's alone, and may be left out. */
export type LiveSettings = Omit<ServerConfig['live'], 'healthPort'> & {
  healthPort?: number
}
