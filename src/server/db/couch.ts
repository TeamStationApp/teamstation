import {
  asReplicatorSetupDocument,
  type DatabaseSetup,
  makeMangoIndex,
  syncedDocument
} from 'edge-server-tools'
import nano from 'nano'

import { serverConfig } from '../serverConfig'
import {
  asApiKeys,
  asLwsAddressDoc,
  type LwsAddress,
  type LwsAddressDoc
} from '../types/types'
import { createSyncInterval, logger } from '../util/utils'

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

const dbAddresses: nano.DocumentScope<LwsAddress> = nano(couchUri).db.use(
  addressesDatabaseSetup.name
)

export const getAddress = async (
  address: string
): Promise<LwsAddressDoc | undefined> => {
  try {
    const addressDoc = await dbAddresses.get(address)
    return asLwsAddressDoc(addressDoc)
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      typeof e.message === 'string' &&
      (e.message.includes('missing') || e.message.includes('deleted'))
    ) {
      return
    }
    logger('Error getting address from database:', address, e)
  }
}

export const updateAddress = async (address: LwsAddress): Promise<void> => {
  await dbAddresses.insert(address)
}

createSyncInterval(apiKeysSyncDoc, dbSettings)
