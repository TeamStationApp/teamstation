/**
 * Reads back a PDF `planPdf` wrote, for its unit test and the Plan tab's
 * end-to-end Share and Print scenario.
 */

/** One string drawn on the page: where, how large, and in which font. */
export interface DrawnText {
  text: string
  x: number
  y: number
  size: number
  bold: boolean
}

/** One rule drawn on the page. */
export interface DrawnLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * A PDF `planPdf` wrote, read back: its pages' MediaBoxes, whether every
 * xref offset points at its object, and what its content stream draws.
 */
export function readPlanPdf(bytes: Uint8Array): {
  header: string
  ended: boolean
  pages: number
  mediaBox: number[]
  xrefSound: boolean
  texts: DrawnText[]
  lines: DrawnLine[]
} {
  const file = Array.from(bytes, byte => String.fromCharCode(byte)).join('')
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(file)?.[1] ?? -1)
  const entries = file
    .slice(start)
    .split('\n')
    .filter(line => line.endsWith(' 00000 n '))
    .map(line => Number(line.slice(0, 10)))
  const xrefSound =
    file.slice(start, start + 4) === 'xref' &&
    entries.length > 0 &&
    entries.every((offset, at) =>
      file.slice(offset).startsWith(`${at + 1} 0 obj\n`)
    )
  const stream = /stream\n([\s\S]*?)\nendstream/.exec(file)?.[1] ?? ''
  const length = Number(/\/Length (\d+)/.exec(file)?.[1] ?? -1)
  if (length !== stream.length) throw new Error('The stream length is wrong')
  const texts: DrawnText[] = []
  const lines: DrawnLine[] = []
  for (const op of stream.split('\n')) {
    const drawn =
      /^BT \/(F[12]) ([\d.]+) Tf ([\d.-]+) ([\d.-]+) Td \(((?:\\.|[^\\)])*)\) Tj ET$/.exec(
        op
      )
    if (drawn != null) {
      texts.push({
        // Octal escapes are WinAnsi codes, which match Latin-1.
        text: drawn[5].replace(/\\([0-7]{3}|.)/g, (_, code: string) =>
          code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : code
        ),
        x: Number(drawn[3]),
        y: Number(drawn[4]),
        size: Number(drawn[2]),
        bold: drawn[1] === 'F2'
      })
      continue
    }
    const rule = /^([\d.]+) ([\d.]+) m ([\d.]+) ([\d.]+) l S$/.exec(op)
    if (rule != null)
      lines.push({
        x1: Number(rule[1]),
        y1: Number(rule[2]),
        x2: Number(rule[3]),
        y2: Number(rule[4])
      })
  }
  return {
    header: file.slice(0, 9),
    ended: file.endsWith('%%EOF\n'),
    pages: (file.match(/\/Type \/Page\b(?!s)/g) ?? []).length,
    mediaBox: (/\/MediaBox \[([\d ]+)\]/.exec(file)?.[1] ?? '')
      .split(' ')
      .map(Number),
    xrefSound,
    texts,
    lines
  }
}
