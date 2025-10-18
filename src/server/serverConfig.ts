import { makeConfig } from 'cleaner-config'
import { asArray, asNumber, asObject, asOptional, asString } from 'cleaners'
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
  // LWS server:
  lwsServers: asOptional(
    asArray(
      asObject({
        url: asString,
        shard: asNumber
      })
    ),
    [
      {
        url: 'https://monerolws-wusa1.edge.app',
        shard: 1
      },
      {
        url: 'https://monerolws-wusa2.edge.app',
        shard: 2
      },
      {
        url: 'https://monerolws-wusa3.edge.app',
        shard: 3
      },
      {
        url: 'https://monerolws-wusa4.edge.app',
        shard: 4
      }
    ]
  )
})

export type ServerConfig = ReturnType<typeof asServerConfig>
export const serverConfig: ServerConfig = makeConfig(asServerConfig, configPath)
