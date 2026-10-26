import { readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'

import ts from 'typescript'

import { enUs } from '../../app/locales/en_US'
import { parseRoute, type Route, routePath } from '../../app/navigation/routes'

/**
 * The app's map, read from the code: every route's address, the screen it
 * opens, the tabs across that screen and, for a settings page, what it lets
 * somebody change. Tess hands it to the model so that "where do I change my
 * team's location" is answered with a link that works, not a guess.
 *
 * Everything is derived, so the map cannot drift from the app: a new route,
 * tab or setting changes `sitemap.generated.json`, and `sitemap.test.ts`
 * fails until it is regenerated with `npm run tess.sitemap`. Only the
 * command line and the test load this file; the server reads the JSON.
 */

export interface SitemapTab {
  /** The route property the tab is written to. */
  param: string
  id: string
  label: string
  path: string
}

export interface SitemapRoute {
  name: string
  /** `/teams/:teamId`, with a `:<property>` for each required value. */
  path: string
  title: string
  tabs: SitemapTab[]
  /** The English text of a settings page: its rows, labels and notes. */
  settings: string[]
}

export interface Sitemap {
  routes: SitemapRoute[]
}

export interface SitemapOptions {
  /** The repository root. */
  root?: string
  /** Replaces a source file's text, keyed by its path from the root. */
  sources?: Record<string, string>
  routePath?: (route: Route) => string
  parseRoute?: (path: string, search?: string) => Route
}

const ROUTES_FILE = 'src/app/navigation/routes.ts'
const SHELL_FILE = 'src/app/App.tsx'
const NAV_FILE = 'src/app/components/AppNav.tsx'

/**
 * A value `parseRoute` accepts for each parameter whose format it checks.
 * Every other parameter round-trips as `abc123`, so a route that starts
 * validating a new one fails the generator until it is given a sample here.
 */
export const ROUND_TRIP_SAMPLES: Record<string, string> = {
  userId: 'usr_1111111111111111111112',
  handle: 'h'.repeat(43)
}

/**
 * Routes only a development build has: the chat crypto bench, whose address
 * exists only in a served web bundle or a phone built with `TS_CHAT_BENCH=1`.
 * Nobody using the app can open them, so Tess is never given them.
 */
export const DEV_ONLY_ROUTES = new Set(['chatBench'])

/** The routes whose screens are settings, listed with their text. */
const SETTINGS_ROUTES = new Set([
  'account',
  'gameSettings',
  'groupAddPeople',
  'groupInvites',
  'groupLocation',
  'groupSettings',
  'leagueUmpires',
  'nodeAdministration',
  'seasonTimeFrame',
  'umpireLevels',
  'umpireNoteTypes',
  'umpireRequirementEdit',
  'umpireRequirements',
  'umpireTypes'
])

/**
 * Settings that live in a tab of a screen that is not itself settings: the
 * components the screen imports for them.
 */
const SETTINGS_TABS: Record<string, string[]> = {
  player: ['PlayerSettingsTab', 'WalkUpTab']
}

/** The directories a settings page's text is gathered from. */
const SETTINGS_DIRECTORIES = [
  'src/app/screens/',
  'src/app/umpires/',
  'src/app/player/',
  'src/app/components/'
]

/** JSX properties that carry text somebody reads. */
const TEXT_PROPS = new Set([
  'description',
  'detail',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'title'
])

/** The sitemap of the code under `options.root`. */
export function generateSitemap(options: SitemapOptions = {}): Sitemap {
  const root = options.root ?? resolve(__dirname, '../../..')
  const sources = new Sources(root, options.sources ?? {})
  const routing = {
    routePath: options.routePath ?? routePath,
    parseRoute: options.parseRoute ?? parseRoute
  }
  const shell = readShell(sources)

  const routes = routeMembers(sources)
    .filter(member => !DEV_ONLY_ROUTES.has(member.name))
    .map(member => {
      const build = (extra: Record<string, unknown> = {}): string => {
        let path: unknown
        try {
          path = routing.routePath({
            ...member.sample,
            ...extra
          } as unknown as Route)
        } catch (error) {
          throw new Error(
            `Route ${member.name}: routePath failed: ${String(error)}`
          )
        }
        if (typeof path !== 'string')
          throw new Error(`Route ${member.name}: routePath gave no address`)
        return member.tokens.reduce(
          (text, [token, name]) => text.split(token).join(`:${name}`),
          path
        )
      }
      const path = build()
      roundTrip(member.name, path, routing.parseRoute)

      const screen = shell.screens.get(member.name)
      const tabs: SitemapTab[] = []
      if (screen != null)
        for (const list of candidateLists(sources, screen)) {
          const param = homeOf(list, member.properties)
          if (param == null) continue
          for (const { id, label } of list) {
            if (tabs.some(tab => tab.param === param && tab.id === id)) continue
            tabs.push({ param, id, label, path: build({ [param]: id }) })
          }
        }

      const roots =
        screen == null
          ? []
          : SETTINGS_ROUTES.has(member.name)
            ? [screen]
            : (SETTINGS_TABS[member.name] ?? []).flatMap(component =>
                importedFile(sources, screen, component)
              )
      return {
        name: member.name,
        path,
        title: shell.titles.get(member.name) ?? humanize(member.name),
        tabs,
        settings: settingsText(sources, roots)
      }
    })
  routes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { routes }
}

/** The file's bytes: two-space JSON with a final newline. */
export function sitemapText(sitemap: Sitemap): string {
  return `${JSON.stringify(sitemap, null, 2)}\n`
}

/**
 * Why a checked-in sitemap is not `fresh`, naming the first route that
 * differs; nothing when they are the same.
 */
export function sitemapDifference(
  fresh: Sitemap,
  checkedIn: string
): string | undefined {
  if (checkedIn === sitemapText(fresh)) return undefined
  let stored: Sitemap
  try {
    stored = JSON.parse(checkedIn) as Sitemap
  } catch {
    return 'the checked-in sitemap is not JSON'
  }
  const old = new Map(
    (Array.isArray(stored?.routes) ? stored.routes : []).map(route => [
      route.name,
      route
    ])
  )
  const now = new Map(fresh.routes.map(route => [route.name, route]))
  for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    if (!now.has(name)) return `route ${name} is no longer in the app`
    if (!old.has(name)) return `route ${name} is missing`
    if (JSON.stringify(old.get(name)) !== JSON.stringify(now.get(name)))
      return `route ${name} differs`
  }
  return 'the routes match but the file is not formatted as generated'
}

/** Source text, from disk unless the caller replaced it. */
class Sources {
  private readonly parsed = new Map<string, ts.SourceFile | undefined>()

  constructor(
    readonly root: string,
    readonly replaced: Record<string, string>
  ) {}

  text(path: string): string | undefined {
    if (path in this.replaced) return this.replaced[path]
    try {
      return readFileSync(join(this.root, path), 'utf8')
    } catch {
      return undefined
    }
  }

  /** The file parsed for its syntax alone; nothing here needs its types. */
  file(path: string): ts.SourceFile | undefined {
    if (!this.parsed.has(path)) {
      const text = this.text(path)
      this.parsed.set(
        path,
        text == null
          ? undefined
          : ts.createSourceFile(
              path,
              text,
              ts.ScriptTarget.ES2022,
              true,
              path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
            )
      )
    }
    return this.parsed.get(path)
  }

  /** A relative import from `from`, as the bundler finds it. */
  resolve(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined
    const base = posix.join(posix.dirname(from), specifier)
    return [
      `${base}.tsx`,
      `${base}.ts`,
      `${base}/index.tsx`,
      `${base}/index.ts`
    ].find(path => this.text(path) != null)
  }
}

interface RouteMember {
  name: string
  /** The route with every required property filled. */
  sample: Record<string, unknown>
  /** Each placeholder token and the parameter it stands for. */
  tokens: Array<[string, string]>
  /** The literals of each literal-union property; `null` for a free string. */
  properties: Map<string, string[] | null>
}

/**
 * Every member of the `Route` union, from the type checker, with a sample
 * that fills each required property with a token `encodeURIComponent` leaves
 * alone, so `routePath` writes it through and it can be named back.
 */
function routeMembers(sources: Sources): RouteMember[] {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2023.d.ts'],
    types: [],
    noEmit: true,
    noResolve: true
  }
  const host = ts.createCompilerHost(options)
  const routesPath = join(sources.root, ROUTES_FILE)
  const readFile = host.readFile.bind(host)
  host.readFile = path =>
    path === routesPath ? sources.text(ROUTES_FILE) : readFile(path)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (path, version, onError, create) =>
    path === routesPath
      ? ts.createSourceFile(path, sources.text(ROUTES_FILE) ?? '', version)
      : getSourceFile(path, version, onError, create)
  const program = ts.createProgram([routesPath], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(routesPath)
  const alias = file?.statements
    .filter(ts.isTypeAliasDeclaration)
    .find(statement => statement.name.text === 'Route')
  if (alias == null) throw new Error(`No Route type in ${ROUTES_FILE}`)

  const union = checker.getTypeAtLocation(alias.name)
  const members: RouteMember[] = []
  for (const type of union.isUnion() ? union.types : [union]) {
    const nameSymbol = type.getProperty('name')
    if (nameSymbol == null) throw new Error('A Route member has no name')
    for (const name of literalsOf(checker, nameSymbol) ?? []) {
      const tokens: Array<[string, string]> = []
      const properties = new Map<string, string[] | null>()
      const sample: Record<string, unknown> = { name }
      for (const property of checker.getPropertiesOfType(type)) {
        if (property.name === 'name') continue
        const literals = literalsOf(checker, property)
        if (literals != null) properties.set(property.name, literals)
        else if (isString(checker, property))
          properties.set(property.name, null)
        if ((property.flags & ts.SymbolFlags.Optional) === 0)
          sample[property.name] = fill(checker, property, property.name, {
            member: name,
            tokens
          })
      }
      // Longest first, so no token is replaced inside a longer one.
      tokens.sort((a, b) => b[0].length - a[0].length)
      members.push({ name, sample, tokens, properties })
    }
  }
  return members
}

function typeOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type {
  return checker.getNonNullableType(checker.getTypeOfSymbol(symbol))
}

function isString(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  return (typeOf(checker, symbol).flags & ts.TypeFlags.String) !== 0
}

/**
 * A property's string literals in the order the source writes them, which
 * the checker does not keep; `undefined` when it is not a union of them.
 */
function literalsOf(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): string[] | undefined {
  const type = typeOf(checker, symbol)
  const parts = type.isUnion() ? type.types : [type]
  if (!parts.every(part => part.isStringLiteral())) return undefined
  const values = parts.map(part => part.value)
  const declaration = symbol.valueDeclaration
  const written =
    declaration != null && ts.isPropertySignature(declaration)
      ? writtenLiterals(checker, declaration.type)
      : []
  return [
    ...new Set(written.filter(value => values.includes(value))),
    ...values.filter(value => !written.includes(value)).sort()
  ]
}

function writtenLiterals(
  checker: ts.TypeChecker,
  node: ts.TypeNode | undefined
): string[] {
  if (node == null) return []
  if (ts.isUnionTypeNode(node))
    return node.types.flatMap(part => writtenLiterals(checker, part))
  if (ts.isParenthesizedTypeNode(node))
    return writtenLiterals(checker, node.type)
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
    return [node.literal.text]
  if (ts.isTypeReferenceNode(node)) {
    const alias = checker
      .getSymbolAtLocation(node.typeName)
      ?.declarations?.find(ts.isTypeAliasDeclaration)
    return writtenLiterals(checker, alias?.type)
  }
  return []
}

/** The placeholder for a parameter: letters only, so encoding keeps it. */
function tokenFor(name: string): string {
  return `zzz${name.replace(/[^A-Za-z]/g, 'Q')}zzz`
}

function fill(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  name: string,
  context: { member: string; tokens: Array<[string, string]> }
): unknown {
  const type = typeOf(checker, symbol)
  const literals = literalsOf(checker, symbol)
  const token = (): string => {
    context.tokens.push([tokenFor(name), name])
    return tokenFor(name)
  }
  if (literals != null) return literals[0]
  if ((type.flags & ts.TypeFlags.String) !== 0) return token()
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return 0
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return false
  if (
    checker.isArrayType(type) &&
    (checker.getTypeArguments(type as ts.TypeReference)[0].flags &
      ts.TypeFlags.String) !==
      0
  )
    return [token()]
  if ((type.flags & ts.TypeFlags.Object) !== 0 && !checker.isArrayType(type))
    return Object.fromEntries(
      checker
        .getPropertiesOfType(type)
        .filter(field => (field.flags & ts.SymbolFlags.Optional) === 0)
        .map(field => [
          field.name,
          fill(checker, field, `${name}.${field.name}`, context)
        ])
    )
  throw new Error(
    `Route ${context.member}: cannot fill ${name} (${checker.typeToString(type)})`
  )
}

/** The address must open the same route when somebody follows it. */
function roundTrip(
  name: string,
  template: string,
  parse: (path: string, search?: string) => Route
): void {
  const concrete = template.replace(
    /:([A-Za-z][A-Za-z.]*)/g,
    (_, parameter: string) => ROUND_TRIP_SAMPLES[parameter] ?? 'abc123'
  )
  const [path, search = ''] = concrete.split('?')
  const parsed = parse(path, search).name
  if (parsed !== name)
    throw new Error(`Route ${name}: ${template} parses back as ${parsed}`)
}

interface Shell {
  /** Each route's screen file. */
  screens: Map<string, string>
  /** The header titles the Shell gives routes as text. */
  titles: Map<string, string>
}

/**
 * The Shell's `body` chain, `top.name === '<route>' ? <Screen …/>`, read for
 * which screen each route opens, and `titleFor` for the titles it gives.
 */
function readShell(sources: Sources): Shell {
  const app = sources.file(SHELL_FILE)
  if (app == null) throw new Error(`No ${SHELL_FILE}`)
  const imports = new Map<string, string>()
  for (const statement of app.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const bindings = statement.importClause?.namedBindings
    const from = sources.resolve(SHELL_FILE, statement.moduleSpecifier.text)
    if (from != null && bindings != null && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        imports.set(element.name.text, from)
  }

  const screens = new Map<string, string>()
  const conditional = new Map<string, string>()
  const navTabs = navTabIds(sources)
  const walk = (expression: ts.Expression): void => {
    const branches = chainOf(expression)
    const testedTabs: string[] = []
    for (const branch of branches) {
      const test =
        branch.condition == null ? undefined : namesIn(branch.condition)
      if (test?.tabs === true) testedTabs.push(...test.names)
      const value = unwrap(branch.value)
      if (ts.isConditionalExpression(value)) {
        walk(value)
        continue
      }
      const tag = tagOf(value)
      const file = tag == null ? undefined : imports.get(tag)
      if (file == null) continue
      const names =
        branch.condition != null
          ? (test?.names ?? [])
          : testedTabs.length > 0
            ? navTabs.filter(id => !testedTabs.includes(id))
            : []
      for (const name of names) {
        const into = test?.pure === false ? conditional : screens
        if (!into.has(name)) into.set(name, file)
      }
    }
  }
  const body = findVariable(app, 'body')
  if (body == null) throw new Error(`No body chain in ${SHELL_FILE}`)
  walk(body)
  // A screen shown only on a condition stands for the route when no other
  // does: the account screen needs a session, and that is the account page.
  for (const [name, file] of conditional)
    if (!screens.has(name)) screens.set(name, file)

  const titles = new Map<string, string>()
  const titleFor = app.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'titleFor'
  )
  const visit = (node: ts.Node): void => {
    const pair = ts.isIfStatement(node)
      ? { condition: node.expression, value: returned(node.thenStatement) }
      : ts.isConditionalExpression(node)
        ? { condition: node.condition, value: node.whenTrue }
        : undefined
    if (pair?.value != null) {
      const test = namesIn(pair.condition)
      const text = textOf(pair.value)
      if (test.pure && text != null)
        for (const name of test.names)
          if (!titles.has(name)) titles.set(name, text)
    }
    ts.forEachChild(node, visit)
  }
  if (titleFor != null) visit(titleFor)
  return { screens, titles }
}

function navTabIds(sources: Sources): string[] {
  const alias = sources
    .file(NAV_FILE)
    ?.statements.filter(ts.isTypeAliasDeclaration)
    .find(statement => statement.name.text === 'NavTabId')
  if (alias == null) return []
  const parts: readonly ts.TypeNode[] = ts.isUnionTypeNode(alias.type)
    ? alias.type.types
    : [alias.type]
  return parts
    .filter(ts.isLiteralTypeNode)
    .map(node => node.literal)
    .filter(ts.isStringLiteral)
    .map(literal => literal.text)
}

function findVariable(
  file: ts.SourceFile,
  name: string
): ts.Expression | undefined {
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (found != null) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer != null
    )
      found = node.initializer
    else ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** `a ? x : b ? y : z` as its branches, the last with no condition. */
function chainOf(
  expression: ts.Expression
): Array<{ condition?: ts.Expression; value: ts.Expression }> {
  const branches: Array<{ condition?: ts.Expression; value: ts.Expression }> =
    []
  let rest = unwrap(expression)
  while (ts.isConditionalExpression(rest)) {
    branches.push({ condition: rest.condition, value: rest.whenTrue })
    rest = unwrap(rest.whenFalse)
  }
  branches.push({ value: rest })
  return branches
}

/**
 * The routes a condition tests, `top.name === 'x'` or `tab === 'x'`. It is
 * pure when it tests nothing else, so the branch is the route's own.
 */
function namesIn(condition: ts.Expression): {
  names: string[]
  pure: boolean
  tabs: boolean
} {
  const node = unwrap(condition)
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const left = namesIn(node.left)
      const right = namesIn(node.right)
      return {
        names: [...left.names, ...right.names],
        pure: operator === ts.SyntaxKind.BarBarToken && left.pure && right.pure,
        tabs: left.tabs || right.tabs
      }
    }
    if (
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isStringLiteral(node.right)
    ) {
      const subject = node.left
      if (
        ts.isPropertyAccessExpression(subject) &&
        subject.name.text === 'name'
      )
        return { names: [node.right.text], pure: true, tabs: false }
      if (ts.isIdentifier(subject) && subject.text === 'tab')
        return { names: [node.right.text], pure: true, tabs: true }
    }
  }
  return { names: [], pure: false, tabs: false }
}

function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression
  return node
}

function tagOf(expression: ts.Expression): string | undefined {
  const element = ts.isJsxElement(expression)
    ? expression.openingElement
    : ts.isJsxSelfClosingElement(expression)
      ? expression
      : undefined
  return element != null && ts.isIdentifier(element.tagName)
    ? element.tagName.text
    : undefined
}

function returned(statement: ts.Statement): ts.Expression | undefined {
  if (ts.isReturnStatement(statement)) return statement.expression
  if (ts.isBlock(statement) && statement.statements.length === 1)
    return returned(statement.statements[0])
  return undefined
}

/** A string literal or `lstrings.<key>`, as English. */
function textOf(expression: ts.Expression): string | undefined {
  const node = unwrap(expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'lstrings'
  )
    return (enUs as Record<string, string>)[node.name.text]
  return undefined
}

interface Candidate {
  id: string
  label: string
}

/** `{id: '<literal>', label: <text>}`, or nothing. */
function candidateOf(expression: ts.Expression): Candidate | undefined {
  const node = unwrap(expression)
  if (!ts.isObjectLiteralExpression(node)) return undefined
  const value = (key: string): ts.Expression | undefined =>
    node.properties
      .filter(ts.isPropertyAssignment)
      .find(property => property.name.getText() === key)?.initializer
  const id = value('id')
  const label = value('label')
  if (id == null || label == null) return undefined
  const literal = unwrap(id)
  const text = textOf(label)
  return ts.isStringLiteral(literal) && text != null
    ? { id: literal.text, label: text }
    : undefined
}

/**
 * The tab and filter lists a screen draws, from its file and the files it
 * imports from its own directory: each array literal of `{id, label}`
 * objects, each module-level `*_TAB` object, and each `Record<…, string>`
 * literal. An object built anywhere else, a function's local or an argument,
 * is an action or a one-off rather than a tab.
 */
function candidateLists(sources: Sources, screen: string): Candidate[][] {
  const files = [screen, ...sameDirectoryImports(sources, screen)]
  const lists: Candidate[][] = []
  for (const path of files) {
    const file = sources.file(path)!
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.endsWith('_TAB') &&
        node.initializer != null &&
        node.parent.parent.parent === file
      ) {
        const candidate = candidateOf(node.initializer)
        if (candidate != null) lists.push([candidate])
      }
      if (ts.isArrayLiteralExpression(node)) {
        const list = node.elements.flatMap(element => {
          const candidate = candidateOf(element)
          return candidate == null ? [] : [candidate]
        })
        if (list.length > 0) lists.push(list)
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.type != null &&
        isStringRecord(node.type) &&
        node.initializer != null &&
        ts.isObjectLiteralExpression(unwrap(node.initializer))
      ) {
        const object = unwrap(node.initializer) as ts.ObjectLiteralExpression
        const list = object.properties
          .filter(ts.isPropertyAssignment)
          .flatMap(property => {
            const label = textOf(property.initializer)
            const id =
              ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name)
                ? property.name.text
                : undefined
            return id == null || label == null ? [] : [{ id, label }]
          })
        if (list.length > 0) lists.push(list)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return lists
}

function isStringRecord(node: ts.TypeNode): boolean {
  return (
    ts.isTypeReferenceNode(node) &&
    node.typeName.getText() === 'Record' &&
    node.typeArguments?.length === 2 &&
    node.typeArguments[1].kind === ts.SyntaxKind.StringKeyword
  )
}

/**
 * The property a list belongs under: the literal-union property whose
 * literals take every id, or else a free `tab` string. A list that only some
 * of a property's literals match is a filter, and has no home.
 */
function homeOf(
  list: Candidate[],
  properties: Map<string, string[] | null>
): string | undefined {
  let partial = false
  for (const [name, literals] of properties) {
    if (literals == null) continue
    const matched = list.filter(item => literals.includes(item.id)).length
    if (matched === list.length) return name
    if (matched > 0) partial = true
  }
  if (partial) return undefined
  return properties.has('tab') && properties.get('tab') === null
    ? 'tab'
    : undefined
}

/** The file a screen imports a component from, through any index. */
function importedFile(
  sources: Sources,
  from: string,
  component: string
): string[] {
  return importsOf(sources, from)
    .filter(item => item.names.includes(component))
    .map(item => item.path)
}

interface Import {
  path: string
  /** The names imported, when the import names them. */
  names: string[]
}

/**
 * A file's runtime imports, `export … from` included. An import through an
 * index that only re-exports is followed to the file each name comes from.
 */
function importsOf(sources: Sources, from: string): Import[] {
  const file = sources.file(from)
  if (file == null) return []
  const found: Import[] = []
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      continue
    const specifier = statement.moduleSpecifier
    if (specifier == null || !ts.isStringLiteral(specifier)) continue
    const clause = ts.isImportDeclaration(statement)
      ? statement.importClause
      : undefined
    if (
      clause?.isTypeOnly === true ||
      (ts.isExportDeclaration(statement) && statement.isTypeOnly)
    )
      continue
    const bindings = ts.isImportDeclaration(statement)
      ? clause?.namedBindings
      : statement.exportClause
    const elements =
      bindings != null &&
      (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
        ? bindings.elements.filter(element => !element.isTypeOnly)
        : undefined
    if (elements?.length === 0) continue
    // What the target exports under: the name an import asks for, or the
    // name an index gives what it passes on.
    const names = [
      ...(elements ?? []).map(element =>
        ts.isExportSpecifier(element)
          ? element.name.text
          : (element.propertyName ?? element.name).text
      ),
      ...(clause?.name == null ? [] : [clause.name.text])
    ]
    const path = sources.resolve(from, specifier.text)
    if (path == null) continue
    const target = sources.file(path)!
    if (
      target.statements.length > 0 &&
      target.statements.every(ts.isExportDeclaration)
    ) {
      for (const item of importsOf(sources, path))
        if (item.names.some(name => names.includes(name)))
          found.push({
            path: item.path,
            names: item.names.filter(name => names.includes(name))
          })
    } else found.push({ path, names })
  }
  return found
}

function sameDirectoryImports(sources: Sources, from: string): string[] {
  return importsOf(sources, from)
    .map(item => item.path)
    .filter(path => dirname(path) === dirname(from))
}

/**
 * The English a settings page shows: its `lstrings`, its JSX text and its
 * text properties, from the page and what it imports from the app's screen
 * and component directories, two levels down.
 */
function settingsText(sources: Sources, roots: string[]): string[] {
  const files: string[] = []
  let level = roots
  for (let depth = 0; depth <= 2 && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const path of level) {
      if (files.includes(path)) continue
      files.push(path)
      next.push(
        ...importsOf(sources, path)
          .map(item => item.path)
          .filter(child =>
            SETTINGS_DIRECTORIES.some(directory => child.startsWith(directory))
          )
      )
    }
    level = next
  }

  const text = new Set<string>()
  const add = (value: string | undefined): void => {
    const clean = value?.replace(/\s+/g, ' ').replace(/…+/g, '…').trim()
    if (clean != null && /[A-Za-z]/.test(clean)) text.add(clean)
  }
  const spoken = (expression: ts.Expression): void => {
    const node = unwrap(expression)
    if (ts.isTemplateExpression(node))
      add(
        node.head.text +
          node.templateSpans.map(span => `…${span.literal.text}`).join('')
      )
    else if (ts.isConditionalExpression(node)) {
      spoken(node.whenTrue)
      spoken(node.whenFalse)
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      spoken(node.left)
      spoken(node.right)
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'sprintf' &&
      node.arguments.length > 0
    )
      spoken(node.arguments[0])
    else add(textOf(node))
  }
  for (const path of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node)) add(node.text)
      else if (
        ts.isJsxAttribute(node) &&
        TEXT_PROPS.has(node.name.getText()) &&
        node.initializer != null
      ) {
        if (ts.isStringLiteral(node.initializer)) add(node.initializer.text)
        else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression != null
        )
          spoken(node.initializer.expression)
      } else if (ts.isPropertyAccessExpression(node)) add(textOf(node))
      ts.forEachChild(node, visit)
    }
    visit(sources.file(path)!)
  }
  return [...text]
}

/** `umpireRequirementEdit` → `Umpire requirement edit`. */
function humanize(name: string): string {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase()
  return words[0].toUpperCase() + words.slice(1)
}
