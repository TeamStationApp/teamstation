import type { DatabaseSetup } from 'edge-server-tools'
import { setupDatabase } from 'edge-server-tools'

import { serverConfig } from './serverConfig'

const settingsDatabaseSetup: DatabaseSetup = {
  name: 'lwsbalancer_settings',

  templates: {
    settings: {}
  }
}

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
