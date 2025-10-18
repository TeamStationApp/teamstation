import {
  asReplicatorSetupDocument,
  type DatabaseSetup,
  makeMangoIndex,
  syncedDocument
} from 'edge-server-tools'
import nano from 'nano'

import { serverConfig } from '../serverConfig'
import { asApiKeys } from '../types/types'
import { createSyncInterval } from '../util/utils'

// Attach to the database:
const { couchUri } = serverConfig

export const apiKeysSyncDoc = syncedDocument('apikeys', asApiKeys)
export const settingsReplication = syncedDocument(
  'replication',
  asReplicatorSetupDocument
)

export const settingsDatabaseSetup: DatabaseSetup = {
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

export const addressesDatabaseSetup: DatabaseSetup = {
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

const dbSettings: nano.DocumentScope<any> = nano(couchUri).db.use(
  settingsDatabaseSetup.name
)

createSyncInterval(apiKeysSyncDoc, dbSettings)
