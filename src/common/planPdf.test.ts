import { expect } from 'chai'
import { describe, it } from 'mocha'

import { readPlanPdf } from '../test/planPdfReader'
import type { GamePlan, PlanCell } from './gamePlan'
import {
  PDF_MARGIN,
  PDF_MAX_TITLE_FONT,
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  pdfText,
  pdfTextWidth,
  planDocumentFileName,
  planDocumentInfo,
  planDocumentTitle,
  planPdf
} from './planPdf'

const POSITIONS: PlanCell[] = [
  'P',
  'C',
  '1B',
  '2B',
  '3B',
  'SS',
  'LF',
  'CF',
  'RF'
]
/** A plan of `count` rows and `innings` innings, row n at position n. */
function plan(count: number, innings: number): GamePlan {
  return {
    enabled: true,
    innings,
    rows: Array.from({ length: count }, (_, at) => ({
      player: { gumboId: null, fullName: `Player ${at + 1}`, jersey: '' },
      cells: Array.from({ length: innings }, (_, inning): PlanCell =>
        (at + inning) % 4 === 3 ? '' : POSITIONS[(at + inning) % 9]
      )
    }))
  }
}
const names = (count: number, name = 'Ruth'): string[] =>
  Array.from({ length: count }, (_, at) => `${name} #${at + 1}`)
const EDGE = { left: PDF_MARGIN, right: PDF_PAGE_WIDTH - PDF_MARGIN }
const TOP = PDF_PAGE_HEIGHT - PDF_MARGIN

/** Every mark inside the margins, text measured by its font. */
function expectInside(read: ReturnType<typeof readPlanPdf>): void {
  for (const line of read.lines)
    for (const [x, y] of [
      [line.x1, line.y1],
      [line.x2, line.y2]
    ]) {
      expect(x).within(EDGE.left - 0.01, EDGE.right + 0.01)
      expect(y).within(PDF_MARGIN - 0.01, TOP + 0.01)
    }
  for (const text of read.texts) {
    expect(text.x, text.text).at.least(EDGE.left - 0.01)
    expect(
      text.x + pdfTextWidth(text.text, text.bold, text.size),
      text.text
    ).at.most(EDGE.right + 0.02)
    expect(text.y - 0.207 * text.size, text.text).at.least(PDF_MARGIN - 0.01)
    expect(text.y + 0.718 * text.size, text.text).at.most(TOP + 0.01)
  }
}

describe('the game plan PDF', function () {
  it('writes one Letter portrait page that a reader can index', function () {
    const read = readPlanPdf(
      planPdf({ plan: plan(9, 5), rows: names(9), title: 'Hosts game plan' })
    )
    expect(read.header).equals('%PDF-1.4\n')
    expect(read.ended).equals(true)
    expect(read.pages).equals(1)
    expect(read.mediaBox).deep.equals([0, 0, 612, 792])
    expect(read.xrefSound).equals(true)
  })

  it('draws the title, every player and every position, the bench blank, all inside the 0.75 inch margins', function () {
    const shown = plan(9, 5)
    const read = readPlanPdf(
      planPdf({ plan: shown, rows: names(9), title: 'Hosts game plan' })
    )
    expectInside(read)
    const drawn = read.texts.map(text => text.text)
    expect(drawn[0]).equals('Hosts game plan')
    expect(read.texts[0].bold).equals(true)
    for (const name of names(9)) expect(drawn).includes(name)
    for (const header of ['#', 'Player', '1', '2', '3', '4', '5'])
      expect(drawn).includes(header)
    const cells = read.texts.filter(
      text => text.bold && POSITIONS.includes(text.text as PlanCell)
    )
    const held = shown.rows.flatMap(row =>
      row.cells.filter(cell => cell !== '')
    )
    expect(cells.map(text => text.text).sort()).deep.equals([...held].sort())
    // No text is written for a bench cell.
    expect(read.texts.some(text => text.text === '')).equals(false)
  })

  it('spans the table across the page between its margins, the rows of one height', function () {
    const read = readPlanPdf(
      planPdf({ plan: plan(9, 5), rows: names(9), title: 'Hosts game plan' })
    )
    const across = read.lines.filter(line => line.y1 === line.y2)
    expect(across).has.length(11)
    for (const line of across) {
      expect(line.x1).equals(EDGE.left)
      expect(line.x2).equals(EDGE.right)
    }
    const ys = across.map(line => line.y1)
    const heights = ys.slice(1).map((y, at) => ys[at] - y)
    for (const height of heights) expect(height).closeTo(heights[0], 0.02)
    // Slot, player and five innings: eight rules down.
    expect(read.lines.filter(line => line.x1 === line.x2)).has.length(8)
  })

  it('draws the table as large as the page holds, filling it to the bottom margin, always inside it', function () {
    const small = readPlanPdf(
      planPdf({ plan: plan(3, 1), rows: names(3), title: 'Hosts game plan' })
    )
    // Few rows and one inning: the width decides, and the font is large.
    expect(small.texts[1].size).greaterThan(40)
    expectInside(small)
    for (const read of [small]) {
      const across = read.lines.filter(line => line.y1 === line.y2)
      expect(Math.min(...across.map(line => line.y1))).closeTo(PDF_MARGIN, 0.02)
    }
    const long = readPlanPdf(
      planPdf({
        plan: plan(20, 12),
        rows: names(20, 'Christopher Bartholomew Montgomery-Wellington'),
        title: 'Hosts game plan'
      })
    )
    expect(long.texts[1].size).lessThan(14)
    expectInside(long)
    // Many rows and few innings: the height decides.
    const tall = readPlanPdf(
      planPdf({ plan: plan(30, 2), rows: names(30), title: 'Hosts game plan' })
    )
    expect(tall.texts[1].size).closeTo(
      (TOP - PDF_MARGIN - PDF_MAX_TITLE_FONT * 1.7) / (31 * 1.6),
      0.01
    )
    expectInside(tall)
  })

  it('shrinks a title too long for the page, draws Latin-1 names as they are, and writes ? for what Helvetica cannot draw', function () {
    const title = `${'Very long team name '.repeat(6)}game plan`
    const read = readPlanPdf(
      planPdf({
        plan: plan(3, 2),
        rows: ['Ichirō #51', 'Ruth #3', 'Peña #5'],
        title
      })
    )
    expect(read.texts[0].size).lessThan(PDF_MAX_TITLE_FONT)
    expect(
      read.texts[0].x + pdfTextWidth(title, true, read.texts[0].size)
    ).within(EDGE.right - 0.5, EDGE.right)
    // A letter beyond Latin-1 loses its accent; Latin-1 is drawn as it is.
    expect(read.texts.map(text => text.text)).includes('Ichiro #51')
    expect(read.texts.map(text => text.text)).includes('Peña #5')
    // As a WinAnsi octal code: the file itself stays ASCII.
    const bytes = planPdf({ plan: plan(1, 1), rows: ['Peña'], title: 'x' })
    expect(Array.from(bytes).every(byte => byte < 0x80)).equals(true)
    expect(String.fromCharCode(...bytes)).includes('(Pe\\361a) Tj')
    expect(pdfText('Peña – Müller, Łukasz Żółć ☃')).equals(
      'Peña – Müller, Lukasz Zólc ?'
    )
    expect(pdfText('Œuvre Ðorđe Yıldız')).equals('Œuvre Ðorde Yildiz')
    // Latin-1 is measured by its plain letter, or by its own width.
    expect(pdfTextWidth('é', false, 1000)).equals(
      pdfTextWidth('e', false, 1000)
    )
    expect(pdfTextWidth('ß', true, 1000)).equals(611)
    expect(pdfTextWidth('¿', false, 1000)).equals(611)
    expect(pdfTextWidth('©®', false, 1000)).equals(1474)
    expect(pdfTextWidth('¼', true, 1000)).equals(834)
    expect(pdfTextWidth('Œ', false, 1000)).equals(1000)
    // The rest of WinAnsi draws as itself, by its own width.
    expect(pdfText('Hawks™ ‹ƒ†‡‰› „‚ˆ˜')).equals('Hawks™ ‹ƒ†‡‰› „‚ˆ˜')
    expect(pdfTextWidth('™‰', false, 1000)).equals(2000)
    // A name typed decomposed is drawn composed, as WinAnsi's é.
    expect(pdfText('Jose\u0301')).equals('José')
    expect(pdfTextWidth('Jose\u0301', false, 1000)).equals(
      pdfTextWidth('Jose', false, 1000)
    )
    expect(pdfTextWidth('“”', true, 1000)).equals(1000)
    // WinAnsi past Latin-1 is written by its own code: Œ is 214 in octal.
    expect(
      String.fromCharCode(
        ...planPdf({ plan: plan(1, 1), rows: ['Œuvre'], title: 'x' })
      )
    ).includes('(\\214uvre) Tj')
    expectInside(read)
  })

  it('keeps a label of wide signs inside the player column', function () {
    const label = '¿Señor? ©®µ¼ #15'
    const read = readPlanPdf(
      planPdf({ plan: plan(1, 9), rows: [label], title: 'Hosts game plan' })
    )
    const drawn = read.texts.find(text => text.text === label)!
    const rules = [
      ...new Set(
        read.lines.filter(line => line.x1 === line.x2).map(line => line.x1)
      )
    ].sort((a, b) => a - b)
    // The slot's rule, then the player column's right rule.
    expect(drawn.x + pdfTextWidth(label, drawn.bold, drawn.size)).at.most(
      rules[2]
    )
  })

  it('escapes parentheses and backslashes in what it writes', function () {
    const read = readPlanPdf(
      planPdf({
        plan: plan(1, 1),
        rows: ['Smith (Jr.) \\ #9'],
        title: 'Hosts (A) game plan'
      })
    )
    expect(read.texts.map(text => text.text)).includes('Smith (Jr.) \\ #9')
    expect(read.texts[0].text).equals('Hosts (A) game plan')
  })

  it('reads a row shorter than the plan as the bench, and a plan with no innings as one', function () {
    const short: GamePlan = {
      enabled: true,
      innings: 0,
      rows: [
        {
          player: { gumboId: null, fullName: 'Ruth', jersey: '' },
          cells: []
        }
      ]
    }
    const read = readPlanPdf(
      planPdf({ plan: short, rows: ['Ruth', 'Gehrig'], title: '' })
    )
    expect(read.texts.map(text => text.text)).deep.equals([
      '#',
      'Player',
      '1',
      '1',
      'Ruth',
      '2',
      'Gehrig'
    ])
    expectInside(read)
  })

  it('names the PDF for its team, opponent and date, or as a game plan', function () {
    const info = { team: 'Demo Hawks', opponent: 'Owls', date: '2027-04-11' }
    expect(planDocumentTitle(info)).equals(
      'Demo Hawks game plan - Owls - 2027-04-11'
    )
    expect(planDocumentTitle()).equals('Game plan')
    // A game with no start time has no date to name.
    expect(planDocumentTitle({ ...info, date: '' })).equals(
      'Demo Hawks game plan - Owls'
    )
    expect(planDocumentFileName(info)).equals(
      'Demo-Hawks-game-plan-2027-04-11.pdf'
    )
    expect(
      planDocumentFileName({ ...info, team: '  Peña / “Ñ” Club!' })
    ).equals('Pena-N-Club-game-plan-2027-04-11.pdf')
    expect(planDocumentFileName({ ...info, team: '', date: '' })).equals(
      'game-plan.pdf'
    )
    expect(planDocumentFileName()).equals('game-plan.pdf')
    for (const [team, file] of [
      ['Straße', 'Strasse'],
      ['Ærø', 'AEro'],
      ['Ørsted', 'Orsted'],
      ['Łódź', 'Lodz'],
      ['Œuvre', 'OEuvre']
    ])
      expect(planDocumentFileName({ ...info, team })).equals(
        `${file}-game-plan-2027-04-11.pdf`
      )
  })

  it('names a side’s plan from its game, dated where it is played', function () {
    const game = {
      homeTeamName: 'Hosts',
      awayTeamName: 'Visitors',
      // 9 p.m. on the 11th in Los Angeles is the 12th in UTC.
      startAt: '2027-04-12T04:00:00Z',
      timezone: 'America/Los_Angeles'
    }
    expect(planDocumentInfo(game, 'home')).deep.equals({
      team: 'Hosts',
      opponent: 'Visitors',
      date: '2027-04-11'
    })
    expect(planDocumentInfo(game, 'away')).deep.include({
      team: 'Visitors',
      opponent: 'Hosts'
    })
    expect(
      planDocumentInfo({ ...game, timezone: 'Not/AZone' }, 'home').date
    ).equals('2027-04-12')
    expect(planDocumentInfo({ ...game, startAt: null }, 'home').date).equals('')
    expect(planDocumentInfo({ ...game, startAt: 'never' }, 'home').date).equals(
      ''
    )
  })
})
