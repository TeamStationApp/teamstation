// Coverage from different working trees cannot be combined by line number.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function coverageSource() {
  const hash = createHash('sha256')
  const git = args => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 })
  hash.update(git(['rev-parse', 'HEAD']))
  hash.update(git(['diff', '--binary', '--no-ext-diff', 'HEAD']))
  const files = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean)
  for (const file of files) {
    hash.update(file + '\0')
    hash.update(createHash('sha256').update(readFileSync(file)).digest())
  }
  return hash.digest('hex')
}
