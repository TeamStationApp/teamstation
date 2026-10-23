import type { Theme } from '../theme/types'

/**
 * The policy every table and chart from Tess is drawn under. Nothing may be
 * fetched: no script, no frame, no remote image, stylesheet or font. Inline
 * styles and `data:` images and fonts are all a reply needs.
 */
export const RICH_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

export interface RichColors {
  text: string
  muted: string
  border: string
  background: string
}

/** The card's colours, so a table reads in either theme. */
export function richColorsOf(theme: Theme): RichColors {
  return {
    text: theme.primaryTextColor,
    muted: theme.secondaryTextColor,
    border: theme.defaultBorderColor,
    background: theme.cardBackgroundColor
  }
}

/**
 * Markup the policy does not govern: a `<meta>` refresh navigates the frame
 * itself, a `<link>` can resolve a host before any fetch, and a `<base>`
 * would redirect the frame's links.
 */
const UNGOVERNED = /<\/?(?:meta|link|base)\b[^>]*>/gi

/**
 * Wraps a reply's HTML into a document of its own, whose first element is the
 * policy. The reply goes in the body, after the head is closed, so markup
 * that opens another `<head>` lands later in the document, and a later policy
 * can only narrow this one, never loosen it. A link opens a new window, which
 * the frame's sandbox refuses, so it goes nowhere.
 */
export function richDocument(html: string, colors: RichColors): string {
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${RICH_POLICY}">`,
    '<base target="_blank">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${richStyle(colors)}</style>`,
    '</head><body>',
    html.replace(UNGOVERNED, ''),
    '</body></html>'
  ].join('')
}

/** System fonts only: a downloaded one would be a request the policy refuses. */
function richStyle(colors: RichColors): string {
  return [
    `html,body{margin:0;background:${colors.background};color:${colors.text}}`,
    'body{padding:12px;font:15px/1.4 -apple-system,system-ui,sans-serif}',
    'table{border-collapse:collapse;font-variant-numeric:tabular-nums}',
    `th,td{border-bottom:1px solid ${colors.border};padding:6px 10px;text-align:left;white-space:nowrap}`,
    `th{color:${colors.muted};font-weight:600}`,
    'svg{max-width:100%;height:auto}',
    `a{color:${colors.text};text-decoration:none}`
  ].join('')
}
