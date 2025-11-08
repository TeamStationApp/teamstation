import { makeConfig } from 'cleaner-config'
import { asNumber, asObject, asOptional, asString } from 'cleaners'
import { asCouchCredentials } from 'edge-server-tools'

const configPath = './serverConfig.json'

const asServerConfig = asObject({
  // HTTP server options:
  listenHost: asOptional(asString, 'localhost'),
  listenPort: asOptional(asNumber, 8008),

  // Databases:
  /**
   * Used by the primary app engine to connect to couchdb. In production this should
   * connect to the localhost caddy loadbalancer that routes to the different cluster
   * machines
   */
  couchUri: asOptional(asString, `http://admin:admin@localhost:5984`),


  apiServer: asOptional(asString, 'ws://localhost:8008'),
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

  xaiApiKey: asOptional(asString, 'xxxxx')
}).withRest

export type ServerConfig = ReturnType<typeof asServerConfig>
export const serverConfig: ServerConfig = makeConfig(asServerConfig, configPath)
