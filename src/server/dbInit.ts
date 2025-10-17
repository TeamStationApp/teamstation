import type { SetupDatabaseOptions } from 'edge-server-tools'
import { connectCouch, setupDatabase } from 'edge-server-tools'

import {
  addressesDatabaseSetup,
  settingsDatabaseSetup,
  settingsReplication
} from './db/couch'
import { serverConfig } from './serverConfig'
import { logger } from './util/utils'

const databases = [settingsDatabaseSetup, addressesDatabaseSetup]

const options: SetupDatabaseOptions = {
  replicatorSetup: settingsReplication
}

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
