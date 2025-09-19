import { makeConfig } from 'cleaner-config'
import { asNumber, asObject, asOptional, asString } from 'cleaners'

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
  )
})

export type ServerConfig = ReturnType<typeof asServerConfig>
export const serverConfig: ServerConfig = makeConfig(asServerConfig, configPath)
