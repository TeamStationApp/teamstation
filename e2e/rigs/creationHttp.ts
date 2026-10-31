import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_CREATION_ARTIFACTS for HTTP proving logs')
const groups: Array<[string, string[]]> = [
  [
    'parent-role-access.log',
    ['src/server/groups/relationships.test.ts', 'src/server/access.test.ts']
  ],
  [
    'invites-node-admin.log',
    [
      'src/server/invites/personRequests.test.ts',
      'src/server/admin/nodeAdministration.test.ts'
    ]
  ],
  [
    'notifications-inbox.log',
    [
      'src/server/groups/linkRequests.test.ts',
      'src/server/groups/authority.test.ts'
    ]
  ],
  ['parent-unlink.log', ['src/server/groups/relationships.test.ts']],
  [
    'game-schedule-projections.log',
    [
      'src/server/schedule/gameApprovals.test.ts',
      'src/server/schedule/batchApproval.test.ts'
    ]
  ],
  ['public-discovery.log', ['src/server/groups/publicSummary.test.ts']],
  [
    'request-lifecycle.log',
    [
      'src/server/groups/authority.test.ts',
      'src/server/groups/linkRequests.test.ts'
    ]
  ],
  ['withdrawal.log', ['src/server/schedule/gameApprovals.test.ts']],
  [
    'external-custody.log',
    [
      'src/server/groups/externalCustody.test.ts',
      'src/server/schedule/gameApprovals.test.ts'
    ]
  ]
]
for (const [filename, suites] of groups) {
  const log = join(artifacts, filename)
  const args = ['-r', 'sucrase/register', '--timeout', '60000', ...suites]
  const result = spawnSync('node_modules/.bin/mocha', args, {
    env: { ...process.env, TS_CREATION_HTTP_LOG: log },
    encoding: 'utf8'
  })
  // A successful command's proof has no diagnostics containing host paths.
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr)
    throw new Error(`${filename} proving tests failed`)
  }
  appendFileSync(
    log,
    `$ node_modules/.bin/mocha ${args.join(' ')}\n${result.stdout}\n`
  )
  process.stdout.write(`${filename}: actual PostgreSQL/HTTP vectors passed\n`)
}
