import type { GamePlan } from './gamePlan'

/**
 * A coach's game plan as a one-page PDF, for Share and Print: US Letter in
 * portrait, 0.75 inch margins, a title line and then the whole table, slot,
 * player and every inning, drawn as large as the page holds. It needs no
 * font file: the text is in the standard Helvetica and Helvetica-Bold every
 * PDF reader carries, measured by their published widths.
 */

/** 8.5 by 11 inches, in points. */
export const PDF_PAGE_WIDTH = 612
export const PDF_PAGE_HEIGHT = 792
/** 0.75 inch on every side. */
export const PDF_MARGIN = 54
/** The largest the title's text grows. */
export const PDF_MAX_TITLE_FONT = 18
/** A table row's least height, in its font's size. */
const ROW_HEIGHT = 1.6
/** The room a column leaves around its widest text, in its font's size. */
const PADDING = 0.6
/** Helvetica's ascender and descender, per thousand of the font's size. */
const ASCENT = 718
const DESCENT = -207

/**
 * Advance widths per thousand of the font's size, of the printable ASCII
 * characters from space (32) to tilde (126): Adobe's Helvetica and
 * Helvetica-Bold metrics, as WinAnsiEncoding places them.
 */
const REGULAR_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584
]
const BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584
]

/**
 * Latin-1's signs and its letters with no plain letter under an accent, by
 * their width per thousand in Helvetica and Helvetica-Bold (Adobe's
 * metrics). An accented letter is as wide as its plain one.
 */
const LATIN1_WIDTHS: Readonly<Record<string, readonly [number, number]>> = {
  '\u00a0': [278, 278],
  '¡': [333, 333],
  '¢': [556, 556],
  '£': [556, 556],
  '¤': [556, 556],
  '¥': [556, 556],
  '¦': [260, 280],
  '§': [556, 556],
  '¨': [333, 333],
  '©': [737, 737],
  ª: [370, 370],
  '«': [556, 556],
  '¬': [584, 584],
  '\u00ad': [333, 333],
  '®': [737, 737],
  '¯': [333, 333],
  '°': [400, 400],
  '±': [584, 584],
  '²': [333, 333],
  '³': [333, 333],
  '´': [333, 333],
  µ: [556, 611],
  '¶': [537, 556],
  '·': [278, 278],
  '¸': [333, 333],
  '¹': [333, 333],
  º: [365, 365],
  '»': [556, 556],
  '¼': [834, 834],
  '½': [834, 834],
  '¾': [834, 834],
  '¿': [611, 611],
  ß: [611, 611],
  æ: [889, 889],
  Æ: [1000, 1000],
  ø: [611, 611],
  Ø: [778, 778],
  ð: [556, 611],
  Ð: [722, 722],
  þ: [556, 611],
  Þ: [667, 667],
  '×': [584, 584],
  '÷': [584, 584]
}

/**
 * What WinAnsiEncoding draws past Latin-1, by its code and its widths in
 * Helvetica and Helvetica-Bold.
 */
const WINANSI_EXTRA: Readonly<
  Record<string, readonly [number, number, number]>
> = {
  '€': [0x80, 556, 556],
  '‚': [0x82, 222, 278],
  ƒ: [0x83, 556, 556],
  '„': [0x84, 333, 500],
  '…': [0x85, 1000, 1000],
  '†': [0x86, 556, 556],
  '‡': [0x87, 556, 556],
  ˆ: [0x88, 333, 333],
  '‰': [0x89, 1000, 1000],
  '‹': [0x8b, 333, 333],
  Š: [0x8a, 667, 667],
  Œ: [0x8c, 1000, 1000],
  Ž: [0x8e, 611, 611],
  '‘': [0x91, 222, 278],
  '’': [0x92, 222, 278],
  '“': [0x93, 333, 500],
  '”': [0x94, 333, 500],
  '•': [0x95, 350, 350],
  '–': [0x96, 556, 556],
  '—': [0x97, 1000, 1000],
  '˜': [0x98, 333, 333],
  '™': [0x99, 1000, 1000],
  š: [0x9a, 500, 556],
  '›': [0x9b, 333, 333],
  œ: [0x9c, 944, 944],
  ž: [0x9e, 500, 500],
  Ÿ: [0x9f, 667, 667]
}

/** Letters no accent comes off, and the plain letter each is read as. */
const PLAIN_LETTERS: Readonly<Record<string, string>> = {
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  ı: 'i',
  Ħ: 'H',
  ħ: 'h',
  Ŧ: 'T',
  ŧ: 't',
  Ŀ: 'L',
  ŀ: 'l',
  ĸ: 'k'
}

const PRINTABLE = /^[\x20-\x7e]$/

/**
 * Text as the page can draw it: printable ASCII, Latin-1 and the rest of
 * WinAnsiEncoding drawn as themselves ("Peña", "Müller", "Œuvre"), any other
 * letter as its plain letter where it has one ("Ichirō" is "Ichiro",
 * "Łukasz" is "Lukasz"), and anything else as `?`.
 */
export function pdfText(text: string): string {
  // A name typed decomposed ("e" and a combining accent) is drawn composed.
  return Array.from(text.normalize('NFC'), char => {
    const code = char.charCodeAt(0)
    if (
      char.length === 1 &&
      ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff))
    )
      return char
    if (WINANSI_EXTRA[char] != null) return char
    const plain = PLAIN_LETTERS[char] ?? char.normalize('NFD')[0]
    return PRINTABLE.test(plain) ? plain : '?'
  }).join('')
}

/** One drawable character's width per thousand of the font's size. */
function charWidth(char: string, bold: boolean): number {
  const widths = bold ? BOLD_WIDTHS : REGULAR_WIDTHS
  const code = char.charCodeAt(0)
  if (code <= 0x7e) return widths[code - 32]
  const own = LATIN1_WIDTHS[char] ?? WINANSI_EXTRA[char]?.slice(1)
  if (own != null) return own[bold ? 1 : 0]
  // An accented letter of Latin-1 is as wide as its plain one.
  return widths[char.normalize('NFD').charCodeAt(0) - 32]
}

/** How wide `text` is drawn at `size` points, bold or not. */
export function pdfTextWidth(
  text: string,
  bold: boolean,
  size: number
): number {
  let units = 0
  for (const char of pdfText(text)) units += charWidth(char, bold)
  return (units * size) / 1000
}

/** A number as the page writes it: at most two decimals. */
const num = (value: number): string => String(Math.round(value * 100) / 100)

/**
 * A font size as the page writes it, rounded down so text measured at it
 * never runs past where it was fitted.
 */
const fontSize = (value: number): number => Math.floor(value * 100) / 100

/**
 * A string literal's text: its parentheses and backslashes escaped, and
 * everything past ASCII as its WinAnsi code in octal, so the file stays
 * ASCII.
 */
const literal = (text: string): string =>
  `(${pdfText(text).replace(/[^\x20-\x7e]|[\\()]/g, char => {
    const code = WINANSI_EXTRA[char]?.[0] ?? char.charCodeAt(0)
    return code > 0x7e ? `\\${code.toString(8)}` : `\\${char}`
  })})`

export interface PlanPdfInput {
  plan: Pick<GamePlan, 'innings' | 'rows'>
  /** Each row's player as the Plan tab names him, in batting order. */
  rows: readonly string[]
  title: string
}

/**
 * The plan's PDF. The title is bold and at most 18 points, shrunk to fit the
 * page's width. The table fills the rest of the page between its margins:
 * its font size `s` is the largest for which the slot, player and inning
 * columns, each its widest text and 0.6 `s`, fit across and every row, the
 * header included, has at least 1.6 `s`; the rows share the height, and the
 * inning columns share what the slot and player columns leave across.
 */
export function planPdf({ plan, rows, title }: PlanPdfInput): Uint8Array {
  const left = PDF_MARGIN
  const right = PDF_PAGE_WIDTH - PDF_MARGIN
  const top = PDF_PAGE_HEIGHT - PDF_MARGIN
  const bottom = PDF_MARGIN
  const width = right - left
  const ops: string[] = []
  const text = (
    value: string,
    x: number,
    baseline: number,
    size: number,
    bold: boolean
  ): void => {
    if (value === '') return
    ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${literal(value)} Tj ET`
    )
  }
  /** The baseline that centres a line of `size` text on `middle`. */
  const centred = (middle: number, size: number): number =>
    middle - ((ASCENT + DESCENT) / 2000) * size

  const titleSize = fontSize(
    Math.min(
      PDF_MAX_TITLE_FONT,
      width / Math.max(pdfTextWidth(title, true, 1), 0.001)
    )
  )
  const titleHeight = titleSize * 1.2
  text(title, left, centred(top - titleHeight / 2, titleSize), titleSize, true)
  const tableTop = top - titleHeight - titleSize / 2

  const innings = Math.max(1, plan.innings)
  const slots = rows.map((_, at) => String(at + 1))
  const widest = (values: readonly string[], bold: boolean): number =>
    Math.max(0, ...values.map(value => pdfTextWidth(value, bold, 1)))
  const slotUnits = widest(['#', ...slots], false) + PADDING
  const playerUnits = widest(['Player', ...rows], false) + PADDING
  const inningUnits = pdfTextWidth('WW', true, 1) + PADDING
  const lines = rows.length + 1
  const size = fontSize(
    Math.min(
      (tableTop - bottom) / (lines * ROW_HEIGHT),
      width / (slotUnits + playerUnits + innings * inningUnits)
    )
  )
  // The rows share the page's height under the title, at least 1.6 `s`
  // each, so the table fills the page down to its bottom margin.
  const rowHeight = (tableTop - bottom) / lines
  const slotWidth = slotUnits * size
  const playerWidth = playerUnits * size
  const inningWidth = (width - slotWidth - playerWidth) / innings
  const tableBottom = tableTop - lines * rowHeight
  const columns = [
    left,
    left + slotWidth,
    ...Array.from(
      { length: innings + 1 },
      (_, at) => left + slotWidth + playerWidth + at * inningWidth
    )
  ]

  // The grid: a rule above and under every row, and between the columns.
  ops.push('0.5 w 0 G')
  for (let line = 0; line <= lines; line++) {
    const y = tableTop - line * rowHeight
    ops.push(`${num(left)} ${num(y)} m ${num(right)} ${num(y)} l S`)
  }
  for (const x of columns)
    ops.push(`${num(x)} ${num(tableTop)} m ${num(x)} ${num(tableBottom)} l S`)

  const centre = (
    value: string,
    from: number,
    to: number,
    middle: number,
    bold: boolean
  ): void => {
    text(
      value,
      (from + to - pdfTextWidth(value, bold, size)) / 2,
      centred(middle, size),
      size,
      bold
    )
  }
  const pad = (PADDING / 2) * size
  const header = tableTop - rowHeight / 2
  centre('#', columns[0], columns[1], header, true)
  text('Player', columns[1] + pad, centred(header, size), size, true)
  for (let inning = 0; inning < innings; inning++)
    centre(
      String(inning + 1),
      columns[inning + 2],
      columns[inning + 3],
      header,
      true
    )
  rows.forEach((player, at) => {
    const middle = tableTop - (at + 1.5) * rowHeight
    centre(slots[at], columns[0], columns[1], middle, false)
    text(player, columns[1] + pad, centred(middle, size), size, false)
    const cells = plan.rows[at]?.cells ?? []
    for (let inning = 0; inning < innings; inning++)
      centre(
        cells[inning] ?? '',
        columns[inning + 2],
        columns[inning + 3],
        middle,
        true
      )
  })

  const content = ops.join('\n')
  const font = (name: string): string =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    font('Helvetica'),
    font('Helvetica-Bold')
  ]
  let file = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, at) => {
    offsets.push(file.length)
    file += `${at + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = file.length
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    file += `${String(offset).padStart(10, '0')} 00000 n \n`
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(file.length)
  for (let at = 0; at < file.length; at++) bytes[at] = file.charCodeAt(at)
  return bytes
}

/** The game a plan is for, as its PDF names it. */
export interface PlanDocumentInfo {
  /** The team the plan is for. */
  team: string
  opponent: string
  /** The game's local date, `yyyy-mm-dd`. */
  date: string
}

/**
 * The PDF's title: "Hawks game plan - Owls - 2027-04-11", with no date for
 * a game with no start, or "Game plan" when the game is not known.
 */
export function planDocumentTitle(info?: PlanDocumentInfo): string {
  if (info == null) return 'Game plan'
  const title = `${info.team} game plan - ${info.opponent}`
  return info.date === '' ? title : `${title} - ${info.date}`
}

/** Letters a file name spells out in plain letters. */
const FILE_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  Æ: 'AE',
  æ: 'ae',
  Ø: 'O',
  ø: 'o',
  Œ: 'OE',
  œ: 'oe',
  Þ: 'Th',
  þ: 'th',
  Ð: 'D',
  ð: 'd'
}

/**
 * The PDF's file name: "Hawks-game-plan-2027-04-11.pdf", only plain letters,
 * digits and single dashes; "game-plan.pdf" when the game is not known.
 */
export function planDocumentFileName(info?: PlanDocumentInfo): string {
  const name =
    info == null ? 'game plan' : `${info.team} game plan ${info.date}`
  // "Équipe" is "Equipe" and "Straße" "Strasse": accents go, letters stay.
  const safe = Array.from(
    name,
    char => FILE_LETTERS[char] ?? PLAIN_LETTERS[char] ?? char
  )
    .join('')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${safe === '' ? 'game-plan' : safe}.pdf`
}

/**
 * What names a side's plan PDF, from its game: the side's team, the other
 * team, and the date the game starts on where it is played (or its UTC
 * date, where the zone is not known; '' with no start).
 */
export function planDocumentInfo(
  game: {
    homeTeamName: string
    awayTeamName: string
    startAt: string | null
    timezone: string
  },
  side: 'away' | 'home'
): PlanDocumentInfo {
  const home = side === 'home'
  return {
    team: home ? game.homeTeamName : game.awayTeamName,
    opponent: home ? game.awayTeamName : game.homeTeamName,
    date: localGameDate(game.startAt, game.timezone)
  }
}

function localGameDate(startAt: string | null, timezone: string): string {
  if (startAt == null) return ''
  const at = new Date(startAt)
  if (Number.isNaN(at.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(at)
    const part = (type: string): string =>
      parts.find(each => each.type === type)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')}`
  } catch {
    return at.toISOString().slice(0, 10)
  }
}
