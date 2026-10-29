import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

/**
 * Holds the scoring library to its layering. Nothing under src/common/scoring
 * imports the app or the server, and the app imports only the parts of the
 * library that describe a game and ask about it — never the parts that change
 * one or store one: `apply`, `gumbo`, and `document`, which alone writes a
 * stored play. `scoreboardOf` reads what a game's scoreboard shows, so the
 * scorer's field scoreboard and the public one agree; it changes nothing.
 * `startingSetup` makes the lineups a game starts from, `rosterCommands`
 * changes a draft of the lineups, never the game, `playerTags` names a
 * player to a dictation model, `depth` names how far a ball went, and
 * `baseOutWords` reads the words that say a fielder took a base for an out.
 * `playsLost` counts what a reset of the game would delete, as the server
 * counts it; it changes nothing.
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
  'playerTags',
  'depth',
  'pitchType',
  'baseOutWords',
  'playsLost'
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

// These exports only inspect a game. Other exports in these modules mutate it.
// `storedNames` reads the names a document carries and names a copy of one,
// as a phone's copy of a game is named; making the stored form is the
// session's and the server's.
const READ_ONLY_EXPORTS = {
  lineup: ['ordinal', 'begun'],
  lineupHistory: ['revealedSides', 'confirmedSides'],
  storedNames: ['namesIn', 'withNames']
}

function imports(text) {
  const found = []
  const source = ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest)
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (spec != null && ts.isStringLiteral(spec)) {
        const clause = ts.isImportDeclaration(node)
          ? node.importClause
          : node.exportClause
        const bindings = ts.isImportDeclaration(node)
          ? clause?.namedBindings
          : clause
        const names =
          bindings != null &&
          (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
            ? bindings.elements
                .filter(item => !item.isTypeOnly)
                .map(item => (item.propertyName ?? item.name).text)
            : null
        found.push({
          spec: spec.text,
          typeOnly: node.isTypeOnly === true || clause?.isTypeOnly === true,
          names:
            ts.isImportDeclaration(node) && clause?.name != null ? null : names
        })
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ spec: node.arguments[0].text, typeOnly: false, names: null })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression != null &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push({
        spec: node.moduleReference.expression.text,
        typeOnly: node.isTypeOnly,
        names: null
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Every import that breaks the layering, as `file: reason` lines. */
export function checkLayering(root) {
  const problems = []
  const library = resolve(root, LIBRARY)
  const app = resolve(root, 'src/app')
  const server = resolve(root, 'src/server')
  for (const file of sources(library)) {
    for (const { spec } of imports(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      if (target.startsWith(app + '/') || target.startsWith(server + '/'))
        problems.push(
          `${relative(root, file)}: the scoring library imports ${spec}`
        )
    }
  }
  for (const file of sources(app)) {
    for (const { spec, typeOnly, names } of imports(
      readFileSync(file, 'utf8')
    )) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      if (!target.startsWith(library + '/')) continue
      const module = relative(library, target).split('/')[0]
      const allowed = READ_ONLY_EXPORTS[module] ?? []
      if (
        !APP_MAY_IMPORT.includes(module) &&
        !typeOnly &&
        !(names != null && names.every(name => allowed.includes(name)))
      )
        problems.push(
          `${relative(root, file)}: the app may not import scoring/${module}`
        )
    }
  }
  return problems
}

export function main(root) {
  const problems = checkLayering(root)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) return 1
  console.log('Scoring layering holds.')
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(
    resolve(dirname(fileURLToPath(import.meta.url)), '..')
  )
}
