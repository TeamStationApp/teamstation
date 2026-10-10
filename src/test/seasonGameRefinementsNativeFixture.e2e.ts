import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { refinementsFixture } from './seasonGameRefinementsFixture'

/** Fresh native scenarios use the same synthetic results before browser mutations. */
async function main(): Promise<void> {
  const artifacts = process.env.TS_REFINEMENTS_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_REFINEMENTS_ARTIFACTS')
  const seed = await refinementsFixture(
    resolve('dist'),
    process.env.TS_REFINEMENTS_NATIVE_BIND_HOST === '0.0.0.0'
      ? '0.0.0.0'
      : '127.0.0.1'
  )
  const apiHost = process.env.TS_REFINEMENTS_NATIVE_API_HOST ?? '10.0.2.2'
  await mkdir(join(artifacts, 'support'), { recursive: true })
  await writeFile(
    join(artifacts, 'support/refinements-native-manifest.json'),
    JSON.stringify(
      {
        origin: `http://127.0.0.1:${seed.nativePort}`,
        apiBaseUrl: `http://${apiHost}:${seed.nativePort}/api/v1`,
        season: seed.f.seasonA,
        league: seed.f.leagueA,
        teams: seed.teams,
        game: seed.gameId,
        managedGame: seed.managedGameId
      },
      null,
      2
    )
  )
  console.log('Owned native API fixture ready; private manifest saved.')
  try {
    for await (const line of createInterface({
      input: process.stdin,
      terminal: false
    }))
      if (line === 'quit') break
  } finally {
    await new Promise<void>(resolve =>
      seed.nativeProxy.close(() => {
        resolve()
      })
    )
    await seed.f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
