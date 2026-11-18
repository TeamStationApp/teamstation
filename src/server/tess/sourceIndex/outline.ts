import ts from 'typescript'

export interface SourceSymbol {
  name: string
  kind: string
  line: number
  endLine: number
  signature: string
  doc: string | null
}

/** Parse declarations only; no module resolution, execution or type checking. */
export function sourceSymbols(path: string, content: string): SourceSymbol[] {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return []
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
  const namedExports = new Map<string, Set<string>>()
  for (const statement of file.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier != null ||
      statement.exportClause == null ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue
    for (const element of statement.exportClause.elements) {
      const local = (element.propertyName ?? element.name).text
      const names = namedExports.get(local) ?? new Set<string>()
      names.add(element.name.text)
      namedExports.set(local, names)
    }
  }
  // An overloaded function is listed once, by its implementation.
  const implemented = new Set(
    file.statements.flatMap(statement =>
      ts.isFunctionDeclaration(statement) &&
      statement.body != null &&
      statement.name != null
        ? [statement.name.text]
        : []
    )
  )
  const listed = new Set<string>()
  const symbols: SourceSymbol[] = []
  const compact = (text: string, max: number): string =>
    text.replace(/\s+/g, ' ').trim().slice(0, max)
  const names = (node: ts.BindingName): string[] => {
    if (ts.isIdentifier(node)) return [node.text]
    return node.elements.flatMap(element =>
      ts.isOmittedExpression(element) ? [] : names(element.name)
    )
  }
  for (const statement of file.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined
    const exported =
      modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) === true
    const add = (
      node: ts.Node,
      name: string,
      kind: string,
      end: number
    ): void => {
      const docs = (statement as ts.Node & { jsDoc?: ts.JSDoc[] }).jsDoc
      const doc = docs
        ?.map(doc => {
          const comment = doc.comment
          return typeof comment === 'string'
            ? comment
            : (comment?.map(part => part.text).join('') ?? '')
        })
        .join('\n')
      const publicNames = ts.isExportAssignment(statement)
        ? [name]
        : new Set([
            ...(exported ? [name] : []),
            ...(namedExports.get(name) ?? [])
          ])
      for (const publicName of publicNames)
        symbols.push({
          name: publicName,
          kind:
            /\.[jt]sx$/.test(path) &&
            /^[A-Z]/.test(publicName) &&
            ['function', 'const'].includes(kind)
              ? 'component'
              : kind,
          line:
            file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          endLine: file.getLineAndCharacterOfPosition(node.end).line + 1,
          signature: compact(content.slice(node.getStart(file), end), 300),
          doc: doc == null || doc === '' ? null : doc.slice(0, 500)
        })
    }
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals !== true)
        add(
          statement,
          'default',
          'default',
          statement.expression.getStart(file)
        )
      continue
    }
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags
      const kind =
        (flags & ts.NodeFlags.Const) !== 0
          ? 'const'
          : (flags & ts.NodeFlags.Let) !== 0
            ? 'let'
            : 'var'
      for (const declaration of statement.declarationList.declarations)
        for (const name of names(declaration.name))
          add(
            declaration,
            name,
            kind,
            // A short literal is the constant's meaning, so it stays in the signature.
            declaration.initializer != null &&
              !isShortLiteral(declaration.initializer, file)
              ? declaration.initializer.getStart(file)
              : declaration.end
          )
    } else if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'default'
      if ((statement.body == null && implemented.has(name)) || listed.has(name))
        continue
      listed.add(name)
      add(
        statement,
        statement.name?.text ?? 'default',
        'function',
        statement.body?.getStart(file) ?? statement.end
      )
    } else if (
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      const kind = ts.isClassDeclaration(statement)
        ? 'class'
        : ts.isInterfaceDeclaration(statement)
          ? 'interface'
          : 'enum'
      const body = statement
        .getChildren(file)
        .find(child => child.kind === ts.SyntaxKind.OpenBraceToken)
      add(
        statement,
        statement.name?.text ?? 'default',
        kind,
        body?.getStart(file) ?? statement.end
      )
    } else if (ts.isTypeAliasDeclaration(statement)) {
      add(statement, statement.name.text, 'type', statement.type.getStart(file))
    }
  }
  return symbols
}

function isShortLiteral(node: ts.Expression, file: ts.SourceFile): boolean {
  let value = node
  while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))
    value = value.expression
  if (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken
  )
    value = value.operand
  return (
    (ts.isStringLiteral(value) ||
      ts.isNumericLiteral(value) ||
      ts.isNoSubstitutionTemplateLiteral(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      value.kind === ts.SyntaxKind.NullKeyword) &&
    node.getText(file).length <= 80
  )
}
