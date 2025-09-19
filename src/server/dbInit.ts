import { setupDatabase } from 'edge-server-tools'

import { settingsDatabaseSetup } from './db/settingsDb'
import { serverConfig } from './serverConfig'

const databases = [settingsDatabaseSetup]

async function main(): Promise<void> {
  const { couchUri } = serverConfig
  await Promise.all(
    databases.map(async setup => await setupDatabase(couchUri, setup))
  ).catch((e: unknown) => {
    console.log(e)
  })
}

main().catch((e: unknown) => {
  console.log(e)
})
