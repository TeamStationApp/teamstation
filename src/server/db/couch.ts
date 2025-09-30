import { syncedDocument } from 'edge-server-tools'
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

const dbSettings: nano.DocumentScope<any> = nano(couchUri).db.use(
  'lwsbalancer_settings'
)

const dbAddresses: nano.DocumentScope<LwsAddress> = nano(couchUri).db.use(
  'lwsbalancer_addresses'
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

export const apiKeysSyncDoc = syncedDocument('apikeys', asApiKeys)
createSyncInterval(apiKeysSyncDoc, dbSettings)
