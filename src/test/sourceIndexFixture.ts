import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildSourceIndex } from '../server/tess/sourceIndex/build'

/** A complete TS_BUILD_INFO, as deploy.sh writes it and `readBuildInfo` accepts. */
export function buildInfoJson(commit: string): string {
  return JSON.stringify({
    app: 'TeamStation',
    version: '1.0.0',
    buildNumber: '1',
    branch: 'fixture',
    commit,
    builtAt: '2026-11-18T00:00:00.000Z'
  })
}

export const FIXTURE_MAP =
  '# Source directory map\nAPI: `common/api.ts`; Tess: `server/tess/agent.ts`.\n'

/** A tracked source tree, never a copy of a developer's checkout or configuration. */
export function sourceIndexFixture(
  extra: Record<string, string | Buffer> = {},
  checkout = false
): {
  root: string
  index: string
  write: (path: string, text: string | Buffer) => void
  git: (...args: string[]) => string
  build: () => ReturnType<typeof buildSourceIndex>
  close: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'tess-source-index-'))
  const index = join(root, 'lib/server/tess/source.db')
  const write = (path: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  if (checkout) git('init', '-q')
  for (const [path, text] of Object.entries({
    '.gitignore': 'lib/\nsrc/serverConfig.json\n',
    '.gitattributes':
      'src/maestro export-ignore\nsrc/tools export-ignore\nsrc/omit.ts export-ignore\n',
    'src/DIRECTORY_MAP.md': FIXTURE_MAP,
    'src/common/api.ts':
      '/** Shared contract. */\nexport interface Api { value: string }\n',
    'src/server/tess/agent.ts':
      '/** How many tool rounds may execute. */\nexport const MAX_TOOL_ROUNDS = 20\nexport function contextLimits() { return 20 }\n',
    'src/server/tess/agent.test.ts':
      'export function contextLimits() { return 1 }\n',
    'src/test/data.ts': 'export function contextLimits() { return 2 }\n',
    ...extra
  }))
    write(path, text)
  if (checkout) git('add', '.')
  return {
    root,
    index,
    write,
    git,
    build: () =>
      buildSourceIndex({ root, out: index, commit: 'fixture-release' }),
    close: () => {
      rmSync(root, { recursive: true, force: true })
    }
  }
}
