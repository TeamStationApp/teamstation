import { makeConfig } from 'cleaner-config'
import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'
import { asCouchCredentials } from 'edge-server-tools'

const configPath = './serverConfig.json'

const asServerConfig = asObject({
  // HTTP server options:
  listenHost: asOptional(asString, 'localhost'),
  listenPort: asOptional(asNumber, 8008),

  /**
   * RTMP splitter ingress server. The RTMP splitter accepts incoming RTMP
   * publishes at `{splitterUrl}/split/{eventId}` and pass-through forwards
   * the encoded stream to two configured destinations (no transcoding).
   *
   * - `rtmpHost` is the local bind address for the RTMP socket.
   * - `rtmpPort` is the local listen port.
   * - `splitterUrl` is the publicly-reachable base URL (scheme + host +
   *   port) shown to operators in the UI and used as the publish target
   *   from OBS / encoders. It must NOT include a trailing slash or any
   *   path; the application appends `/split/{eventId}` automatically.
   *   Examples:
   *     "rtmp://app.gamestation.co:1935"
   *     "rtmps://app.gamestation.co:1935"   (if fronted by a TLS proxy)
   *   When empty, falls back to `rtmp://{listenHost}:{rtmpPort}` which
   *   is only useful in single-host dev setups. A server cannot reliably
   *   detect its own public DNS name (reverse-DNS PTRs frequently don't
   *   match the public name, and proxied / load-balanced deployments
   *   hide the real hostname entirely), so this MUST be configured
   *   explicitly in production.
   */
  rtmpHost: asOptional(asString, '0.0.0.0'),
  rtmpPort: asOptional(asNumber, 1935),
  splitterUrl: asOptional(asString, ''),

  // Databases:
  /**
   * Used by the primary app engine to connect to couchdb. In production this should
   * connect to the localhost caddy loadbalancer that routes to the different cluster
   * machines
   */
  couchUri: asOptional(asString, `http://admin:admin@localhost:5984`),


  apiServer: asOptional(asString, 'ws://localhost:8008'),
  eventId: asOptional(asString, ''),

  /**
   * The cluster defintions are used by setupDatabases to create the databases and setup
   * replications.
   */
  couchMainCluster: asOptional(asString, 'wusa'),
  couchUris: asOptional(asCouchCredentials, () => ({
    wusa: {
      url: 'https://lwsbalancerdb-wusa1.edge.app:6984',
      username: 'admin',
      password: 'admin'
    },
    eusa: {
      url: 'https://lwsbalancerdb-eusa1.edge.app:6984',
      username: 'admin',
      password: 'admin'
    }
  })),

  xaiApiKey: asOptional(asString, 'xxxxx'),
  nanogptApiKey: asOptional(asString, 'xxxxx'),
  minimaxApiKey: asOptional(asString, 'xxxxx'),

  /**
   * When true, only the pitcher and batter crops are uploaded for OCR
   * (pitcher name + pitch count, batter name + hits/at-bats).
   * All other image analysis (inning, scores, bases, count, etc.) is skipped.
   */
  rosterOnly: asOptional(asBoolean, false),

  scanMethod: asOptional(
    asValue('screenshot', 'viewHierarchy'),
    'viewHierarchy'
  ),

  /**
   * OCR models for image analysis. Can be a single string or an array.
   * Load is distributed round-robin across models, with failover to
   * the next model on error. Supported prefixes:
   * - "xai/" - XAI's Grok models
   * - "ollama/" - Local Ollama models
   * - "nanogpt/" - NanoGPT models
   * - "minimax/" - MiniMax direct API
   */
  ocrModels: asOptional(
    asEither(asArray(asString), (raw: any) => [asString(raw)]),
    ['nanogpt/minimax/minimax-01']
  )
}).withRest

export type ServerConfig = ReturnType<typeof asServerConfig>
export const serverConfig: ServerConfig = makeConfig(asServerConfig, configPath)
