import nano from 'nano'

import { serverConfig } from '../serverConfig'
import {
  asLwsAddressDoc,
  type LwsAddress,
  type LwsAddressDoc
} from '../types/types'
import { logger } from '../util/utils'

// Attach to the database:
const dbAddresses: nano.DocumentScope<LwsAddress> = nano(
  serverConfig.couchUri
).db.use('lwsbalancer_addresses')

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
