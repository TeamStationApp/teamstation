import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { main } from './cli'
import { readLegacy } from './legacy'
import { ROOT } from './manifest'
import { moduleOf, moduleProblems, MODULES } from './modules'

async function capture(run: () => Promise<number>): Promise<string[]> {
  const lines: string[] = []
  const write = console.log
  console.log = (line?: unknown) => {
    lines.push(String(line))
  }
  try {
    expect(await run()).equals(0)
  } finally {
    console.log = write
  }
  return lines
}

describe('moduleOf', function () {
  const assigned: Array<[string, string]> = [
    ['src/app/passwordForm.e2e.ts', 'account'],
    ['src/app/uiTweaks.e2e.ts', 'app-shell'],
    ['src/app/tess/tess.e2e.ts', 'assistant'],
    ['src/server/tess/tess.integration.ts', 'assistant'],
    ['src/app/chat/chat.e2e.ts', 'messaging'],
    ['src/app/playerNamePrivacy.e2e.ts', 'people'],
    ['src/app/screens/expandedStats.e2e.ts', 'people'],
    ['src/app/screens/teamPlayers.e2e.ts', 'people'],
    ['mobile/test/offlineSync.e2e.ts', 'platform'],
    ['scripts/e2e/playerLayouts/capture.ts', 'playback'],
    ['src/app/autoScheduler.e2e.ts', 'schedule'],
    ['src/app/field/defensivePositionFontFit.e2e.ts', 'scoring'],
    ['src/app/quietStreamNative.e2e.ts', 'streaming'],
    ['src/app/stream/streamSettings.e2e.ts', 'streaming'],
    ['src/test/gameHeroActions.e2e.ts', 'app-shell'],
    ['src/app/umpireManagement.e2e.ts', 'umpires']
  ]

  for (const [file, named] of assigned) {
    it(`${file} is ${named}`, function () {
      expect(moduleOf(file)).equals(named)
    })
  }

  const unassigned = [
    'tsconfig.e2e.json',
    'mobile/apps/tsCameraman/e2e/sentry.e2e.ts',
    'mobile/apps/tsDirector/e2e/programmeCut.e2e.ts',
    'appletv/e2e/auth.e2e.ts',
    'src/test/longListsFixture.e2e.ts',
    'src/app/oauth/oauthWeb.e2e.ts'
  ]

  for (const file of unassigned) {
    it(`${file} has no module`, function () {
      expect(moduleOf(file)).equals(undefined)
    })
  }

  it('a missing chat path is still messaging', function () {
    expect(moduleOf('src/app/chat/missing.e2e.ts')).equals('messaging')
  })

  it('a path that is not a suite has no module', function () {
    expect(moduleOf('README.md')).equals(undefined)
  })

  it('a comment that calls the file a fixture has no module', function () {
    const root = mkdtempSync(join(tmpdir(), 'e2e-modules-'))
    try {
      writeFileSync(
        join(root, 'visual.e2e.ts'),
        '/** Browser-only visual fixture for a control. */\nexport const page = 1\n'
      )
      expect(moduleOf('visual.e2e.ts', root)).equals(undefined)
    } finally {
      rmSync(root, { recursive: true })
    }
  })

  it('every runnable tests entry matches modules', function () {
    expect(moduleProblems(readLegacy(ROOT))).deep.equals([])
  })

  it('a disagreement fails validate', function () {
    const problems = moduleProblems({
      tests: ['src/app/chat/chat.e2e.ts'],
      helpers: ['src/app/oauth/oauthWeb.e2e.ts'],
      parked: ['appletv/e2e/auth.e2e.ts'],
      modules: {
        'src/app/chat/chat.e2e.ts': 'scoring',
        'src/app/oauth/oauthWeb.e2e.ts': 'account',
        'appletv/e2e/auth.e2e.ts': 'platform',
        'notes.txt': 'not-a-module'
      },
      pendingCategories: ['account']
    })
    const text = problems.join('\n')
    expect(text).includes('pendingCategories must be the module list')
    expect(text).includes('moduleOf says messaging')
    expect(text).includes('a helper or a parked path is in modules')
    expect(text).includes('unknown module "not-a-module"')
    // That the live repository has none of these is the integration tier's
    // check: `validate()` lists files with git (core.integration.test.ts).
  })

  it('a category list is the unfiltered ids for that module, then its legacy paths', async function () {
    const all = await capture(async () => await main(['list']))
    const account = await capture(
      async () => await main(['list', '--category', 'account'])
    )
    const ids = all.filter(line => !line.startsWith('legacy '))
    const accountIds = account.filter(line => !line.startsWith('legacy '))
    expect(accountIds.length).is.greaterThan(0)
    for (const id of accountIds) {
      expect(ids).includes(id)
      expect(id.startsWith('account/')).equals(true)
    }
    const legacy = account.filter(line => line.startsWith('legacy '))
    expect(legacy.length).is.greaterThan(0)
    const scoring = await capture(
      async () => await main(['list', '--category', 'scoring'])
    )
    expect(scoring.some(line => line.startsWith('legacy '))).equals(true)
    const json = await capture(async () => await main(['list', '--json']))
    expect(json.some(line => line.includes('legacy '))).equals(false)
    expect(MODULES).includes('scoring')
  })
})
