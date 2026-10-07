import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Explicit roots keep agent evidence with its run. Ordinary test commands own
// short-lived scratch directories and remove only the directories they create.
for (const name of ['TS_BUILDS_TEST_ROOT', 'DEPLOY_TEST_ROOT']) {
  if (process.env[name] != null && process.env[name] !== '') continue
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), 'teamstation-fixture-')
  )
  process.env[name] = root
  process.once('exit', () => {
    rmSync(root, { recursive: true, force: true })
  })
}
