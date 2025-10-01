import type { DatabaseSetup, SetupDatabaseOptions } from 'edge-server-tools'
import {
  asReplicatorSetupDocument,
  connectCouch,
  makeMangoIndex,
  setupDatabase,
  syncedDocument
} from 'edge-server-tools'

import { serverConfig } from './serverConfig'
import { logger } from './util/utils'

export const settingsReplication = syncedDocument(
  'replication',
  asReplicatorSetupDocument
)

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
    },
    replication: {
      clusters: {
        wusa: {
          url: '',
          exclude: [],
          pullFrom: ['eusa'],
          pushTo: []
        },
        eusa: {
          url: '',
          exclude: [],
          pullFrom: ['wusa'],
          pushTo: []
        }
      }
    }
  },
  syncedDocuments: [settingsReplication]
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

const options: SetupDatabaseOptions = {
  replicatorSetup: settingsReplication
}

const databases = [settingsDatabaseSetup, addressesDatabaseSetup]

async function main(): Promise<void> {
  const { couchMainCluster, couchUris } = serverConfig
  const pool = connectCouch(couchMainCluster, couchUris)
  await Promise.all(
    databases.map(async setup => await setupDatabase(pool, setup, options))
  ).catch((e: unknown) => {
    logger(e)
  })
}

main().catch((e: unknown) => {
  logger(e)
})
