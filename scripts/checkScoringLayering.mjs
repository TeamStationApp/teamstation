import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Holds the scoring library to its layering. Nothing under src/common/scoring
 * imports the app or the server, and the app imports only the parts of the
 * library that describe a game and ask about it — never the parts that change
 * one or store one: `apply`, `gumbo`, and `document`, which alone writes a
 * stored play. `scoreboardOf` reads what a game's scoreboard shows, so the
 * scorer's field scoreboard and the public one agree; it changes nothing.
 * `startingSetup` makes the lineups a game starts from, `rosterCommands`
 * changes a draft of the lineups, never the game, and `playerTags` names a
 * player to a dictation model.
 */
export const APP_MAY_IMPORT = [
  'state',
  'actions',
  'transitions',
  'session',
  'rules',
  'scoreboardOf',
  'startingSetup',
  'rosterCommands',
  'playerTags'
]
const LIBRARY = 'src/common/scoring'

function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (
      /\.(ts|tsx|mjs|js)$/.test(name) &&
      !/\.(test|e2e|smoke)\./.test(name)
    )
      out.push(path)
  }
  return out
}

function imports(text) {
  const found = []
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  let match
  while ((match = pattern.exec(text)) != null) found.push(match[1])
  return found
}

/** Every import that breaks the layering, as `file: reason` lines. */
export function checkLayering(root) {
  const problems = []
  const library = resolve(root, LIBRARY)
  const app = resolve(root, 'src/app')
  const server = resolve(root, 'src/server')
  for (const file of sources(library)) {
    for (const spec of imports(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      if (target.startsWith(app + '/') || target.startsWith(server + '/'))
        problems.push(
          `${relative(root, file)}: the scoring library imports ${spec}`
        )
    }
  }
  for (const file of sources(app)) {
    for (const spec of imports(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      if (!target.startsWith(library + '/')) continue
      const module = relative(library, target).split('/')[0]
      if (!APP_MAY_IMPORT.includes(module))
        problems.push(
          `${relative(root, file)}: the app may not import scoring/${module}`
        )
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const problems = checkLayering(root)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log('Scoring layering holds.')
}
