import { makeConfig } from 'cleaner-config'
import { asArray, asNumber, asObject, asOptional, asString } from 'cleaners'

const configPath = './serverConfig.json'

// Customization:

const {
  COUCH_HOSTNAME = 'localhost',
  COUCH_USERNAME = 'username',
  COUCH_PASSWORD = 'password'
} = process.env

// Config:

const asServerConfig = asObject({
  // HTTP server options:
  listenHost: asOptional(asString, 'localhost'),
  listenPort: asOptional(asNumber, 8008),

  // Databases:
  couchUri: asOptional(
    asString,
    `http://${COUCH_USERNAME}:${COUCH_PASSWORD}@${COUCH_HOSTNAME}:5984`
  ),

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
