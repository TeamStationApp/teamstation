import type { DatabaseSetup } from 'edge-server-tools'
import { makeMangoIndex, setupDatabase } from 'edge-server-tools'

import { serverConfig } from './serverConfig'
import { logger } from './util/utils'

const settingsDatabaseSetup: DatabaseSetup = {
  name: 'lwsbalancer_settings',

  templates: {
    apikeys: {
      apiKeys: {
        xxxApiKeyExample: {
          apiKey: 'xxxApiKeyExample',
          email: 'xxx@example.com',
          status: 'active',
          createdAt: new Date().toISOString()
        }
      }
    }
  }
}

const addressesDatabaseSetup: DatabaseSetup = {
  name: 'lwsbalancer_addresses',

  documents: {
    '_design/birthdayHeight': makeMangoIndex('birthdayHeight', [
      'birthdayHeight'
    ]),
    '_design/lastVisitedDate': makeMangoIndex('lastVisitedDate', [
      'lastVisitedDate'
    ])
  }
}

const databases = [settingsDatabaseSetup, addressesDatabaseSetup]

async function main(): Promise<void> {
  const { couchUri } = serverConfig
  await Promise.all(
    databases.map(async setup => await setupDatabase(couchUri, setup))
  ).catch((e: unknown) => {
    logger(e)
  })
}

main().catch((e: unknown) => {
  logger(e)
})
