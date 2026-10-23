import { marked, type Token, type Tokens } from 'marked'
import React, { type ReactNode, useMemo } from 'react'
import { Linking, Platform, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { RichBlock } from './RichBlock'
import { WayBubble } from './WayBubble'

export type LinkTarget =
  { kind: 'app'; path: string } | { kind: 'web'; url: string } | null

/**
 * Where a link in a reply may go: an app path is navigated to, an `https:`
 * address opens outside the app, and anything else (`javascript:`, `http:`,
 * `mailto:`, a protocol-relative `//host`) is not a link at all.
 */
export function linkTarget(href: string): LinkTarget {
  if (href.startsWith('/') && !href.startsWith('//'))
    return { kind: 'app', path: href }
  if (/^https:\/\//i.test(href)) return { kind: 'web', url: href }
  return null
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** Text as written: the lexer keeps the source's character references. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, decimal?: string, hex?: string, name?: string) => {
      const code =
        decimal != null
          ? Number(decimal)
          : hex != null
            ? parseInt(hex, 16)
            : undefined
      if (code != null)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
      return ENTITIES[name!.toLowerCase()] ?? match
    }
  )
}

const MONOSPACE = Platform.OS === 'ios' ? 'ui-monospace' : 'monospace'

/** A paragraph that is really a chart or table written inline. */
function isRichParagraph(token: Tokens.Paragraph | Tokens.Text): boolean {
  return (token.tokens ?? []).some(
    inline => inline.type === 'html' && /^<(svg|table)\b/i.test(inline.raw)
  )
}

/** A link titled `path`, to a place in the app: a way bubble. */
function isWay(token: Token): token is Tokens.Link {
  return (
    token.type === 'link' &&
    token.title === 'path' &&
    linkTarget(token.href)?.kind === 'app'
  )
}

/** A block's element; never a promise, which `ReactNode` would allow. */
type Block = React.ReactElement | null

interface Renderer {
  styles: ReturnType<typeof getStyles>
  onNavigate: (path: string) => void
}

/**
 * A reply in chat Markdown, drawn with the app's own text: headings,
 * paragraphs, emphasis, code, lists, quotes, rules and links. Tables and
 * HTML (Tess's charts) are cards that open full size.
 */
export function TessMarkdown({
  text,
  onNavigate
}: {
  text: string
  onNavigate: (path: string) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const tokens = useMemo(() => marked.lexer(text), [text])
  return (
    <View testID="Tess markdown" style={styles.blocks}>
      {blocks(tokens, { styles, onNavigate })}
    </View>
  )
}

function blocks(tokens: Token[], renderer: Renderer): Block[] {
  return tokens.map((token, index) => block(token, index, renderer))
}

function block(token: Token, key: number, renderer: Renderer): Block {
  const { styles } = renderer
  switch (token.type) {
    case 'space':
      return null
    case 'heading':
      return (
        <Text
          key={key}
          accessibilityRole="header"
          style={[
            styles.text,
            styles.heading,
            token.depth <= 1
              ? styles.h1
              : token.depth === 2
                ? styles.h2
                : styles.h3
          ]}
        >
          {inline(token.tokens ?? [], renderer)}
        </Text>
      )
    case 'paragraph':
    case 'text':
      return paragraph(token as Tokens.Paragraph | Tokens.Text, key, renderer)
    case 'code':
      return (
        <View key={key} style={styles.codeBlock}>
          <Text selectable style={styles.code}>
            {token.text}
          </Text>
        </View>
      )
    case 'blockquote':
      return (
        <View key={key} style={styles.quote}>
          {blocks(token.tokens ?? [], renderer)}
        </View>
      )
    case 'list':
      return list(token as Tokens.List, key, renderer)
    case 'hr':
      return <View key={key} style={styles.rule} />
    case 'table':
      return <RichBlock key={key} html={marked.parser([token])} />
    case 'html':
      // A comment is the author's note, not something to show.
      if (/^\s*<!--/.test(token.raw)) return null
      return <RichBlock key={key} html={token.raw} />
    default:
      return (
        <Text key={key} style={styles.text}>
          {decodeEntities(token.raw)}
        </Text>
      )
  }
}

/**
 * Inline text, with a way bubble on a line of its own where the reply has
 * one: a bubble is a button, not a word in the sentence.
 */
function paragraph(
  token: Tokens.Paragraph | Tokens.Text,
  key: number,
  renderer: Renderer
): Block {
  const { styles, onNavigate } = renderer
  if (isRichParagraph(token)) return <RichBlock key={key} html={token.raw} />
  const inlines = token.tokens ?? [
    { type: 'text', raw: token.text, text: token.text }
  ]
  const runs: Array<Token[] | Tokens.Link> = []
  for (const inlineToken of inlines) {
    if (isWay(inlineToken)) runs.push(inlineToken)
    else {
      const last = runs.at(-1)
      if (Array.isArray(last)) last.push(inlineToken)
      else runs.push([inlineToken])
    }
  }
  const parts = runs
    .filter(
      run => !Array.isArray(run) || run.some(part => part.raw.trim() !== '')
    )
    .map((run, index) =>
      Array.isArray(run) ? (
        <Text key={index} style={styles.text}>
          {inline(trimmed(run), renderer)}
        </Text>
      ) : (
        <WayBubble
          key={index}
          label={decodeEntities(run.text)}
          path={run.href}
          onNavigate={onNavigate}
        />
      )
    )
  if (parts.length === 1) return React.cloneElement(parts[0], { key })
  return (
    <View key={key} style={styles.blocks}>
      {parts}
    </View>
  )
}

/** A run of text without the line breaks that led to or from a bubble. */
function trimmed(run: Token[]): Token[] {
  return run.map((part, index) => {
    if (part.type !== 'text') return part
    let text: string = part.text
    if (index === 0) text = text.trimStart()
    if (index === run.length - 1) text = text.trimEnd()
    return { ...part, text }
  })
}

function list(token: Tokens.List, key: number, renderer: Renderer): Block {
  const { styles } = renderer
  const start = typeof token.start === 'number' ? token.start : 1
  return (
    <View key={key} style={styles.list}>
      {token.items.map((item, index) => (
        <View key={index} style={styles.item}>
          <Text style={[styles.text, styles.marker]}>
            {token.ordered ? `${start + index}.` : '•'}
          </Text>
          <View style={styles.itemBody}>{blocks(item.tokens, renderer)}</View>
        </View>
      ))}
    </View>
  )
}

function inline(tokens: Token[], renderer: Renderer): ReactNode[] {
  const { styles, onNavigate } = renderer
  return tokens.map((token, key) => {
    switch (token.type) {
      case 'text':
        return 'tokens' in token && token.tokens != null ? (
          <React.Fragment key={key}>
            {inline(token.tokens, renderer)}
          </React.Fragment>
        ) : (
          decodeEntities(token.text)
        )
      case 'escape':
        return token.text
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            {inline(token.tokens ?? [], renderer)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} style={styles.em}>
            {inline(token.tokens ?? [], renderer)}
          </Text>
        )
      case 'del':
        return (
          <Text key={key} style={styles.del}>
            {inline(token.tokens ?? [], renderer)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={key} style={styles.codespan}>
            {decodeEntities(token.text)}
          </Text>
        )
      case 'br':
        return '\n'
      case 'link': {
        const target = linkTarget(token.href)
        const label = inline(token.tokens ?? [], renderer)
        if (target == null)
          return <React.Fragment key={key}>{label}</React.Fragment>
        return (
          <Text
            key={key}
            accessibilityRole="link"
            style={styles.link}
            onPress={() => {
              if (target.kind === 'app') onNavigate(target.path)
              else Linking.openURL(target.url).catch(() => undefined)
            }}
          >
            {label}
          </Text>
        )
      }
      case 'image':
        // A reply's image would be a request; its words stand in for it.
        return decodeEntities(token.text)
      case 'html':
        return /^<br\s*\/?>$/i.test(token.raw) ? '\n' : null
      default:
        return decodeEntities(token.raw)
    }
  })
}

const getStyles = cacheStyles((theme: Theme) => ({
  blocks: { gap: theme.rem(theme.spaceSmRem) },
  text: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    lineHeight: theme.rem(1.375),
    color: theme.primaryTextColor
  },
  heading: { fontFamily: theme.boldTextFont, fontWeight: '700' },
  h1: { fontSize: theme.rem(1.25), lineHeight: theme.rem(1.75) },
  h2: { fontSize: theme.rem(1.125), lineHeight: theme.rem(1.5) },
  h3: { fontSize: theme.rem(1), lineHeight: theme.rem(1.375) },
  strong: { fontFamily: theme.boldTextFont, fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  codespan: {
    fontFamily: MONOSPACE,
    fontSize: theme.rem(0.875),
    backgroundColor: theme.inactiveBackgroundColor
  },
  codeBlock: {
    padding: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusSmallRem),
    backgroundColor: theme.inactiveBackgroundColor
  },
  code: {
    fontFamily: MONOSPACE,
    fontSize: theme.rem(0.8125),
    lineHeight: theme.rem(1.125),
    color: theme.primaryTextColor
  },
  quote: {
    gap: theme.rem(theme.spaceSmRem),
    borderLeftWidth: 3,
    borderLeftColor: theme.defaultBorderColor,
    paddingLeft: theme.rem(theme.spaceMdRem)
  },
  list: { gap: theme.rem(theme.spaceXsRem) },
  item: { flexDirection: 'row', gap: theme.rem(theme.spaceSmRem) },
  marker: { minWidth: theme.rem(1.25), textAlign: 'right' },
  itemBody: { flex: 1, gap: theme.rem(theme.spaceXsRem) },
  rule: {
    height: 1,
    backgroundColor: theme.defaultBorderColor,
    marginVertical: theme.rem(theme.spaceXsRem)
  },
  link: { color: theme.linkTextColor, textDecorationLine: 'underline' }
}))
