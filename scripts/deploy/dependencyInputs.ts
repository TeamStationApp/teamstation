import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** The install marker is valid only for these inputs and this Node runtime. */
export function dependencyInputs(directory: string): string {
  const digest = createHash('sha256').update(process.version)
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) {
    const file = path.join(directory, name)
    digest.update(name).update(existsSync(file) ? readFileSync(file) : '')
  }
  return digest.digest('hex')
}
