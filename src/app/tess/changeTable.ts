import { lstrings } from '../locales/strings'
import type { TessChange, TessChangeStatus, TessMessage } from './tessTypes'

/**
 * How a reply's changes are laid out, apart from how they are drawn: the
 * chat's table (`ChangeBatch`) and the page that expands it over the pane
 * (`changeTableHtml`) both read them from here.
 *
 * The changes of one turn of the person's (every reply from their message to
 * the next) are one batch, held once. A batch is shown as tables, one per run
 * of changes that give the same details, label for label in the same order:
 * those labels are its columns and each change a row. Tess is asked to give
 * the changes of one kind the same labels, so a reply scheduling three games
 * is one table of three rows. A change without details is a row of its
 * summary, under a "Change" column. Once any change of the batch has ended,
 * every table gains a Status column.
 */

/** One table of a batch: its columns, and a row for each change. */
export interface ChangeTable {
  /** The labels each change's details give, or none: a column of summaries. */
  labels: string[]
  changes: TessChange[]
}

/** The labels a change's details give, in order. */
function labelsOf(change: TessChange): string[] {
  return (change.details ?? []).map(detail => detail.label)
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, at) => label === b[at])
}

/** A batch's tables: a run of changes with the same labels shares one. */
export function changeTables(changes: readonly TessChange[]): ChangeTable[] {
  const tables: ChangeTable[] = []
  for (const change of changes) {
    const labels = labelsOf(change)
    const last = tables.at(-1)
    if (last != null && sameLabels(last.labels, labels))
      last.changes.push(change)
    else tables.push({ labels, changes: [change] })
  }
  return tables
}

/** The headings of a table's columns, Status last once it is shown. */
export function columnsOf(table: ChangeTable, withStatus: boolean): string[] {
  return [
    ...(table.labels.length === 0
      ? [lstrings.tess_change_column]
      : table.labels),
    ...(withStatus ? [lstrings.tess_change_status] : [])
  ]
}

/** A change's cells under `columnsOf`'s headings, before its status. */
export function cellsOf(change: TessChange): string[] {
  return change.details == null || change.details.length === 0
    ? [change.summary]
    : change.details.map(detail => detail.value)
}

/**
 * How wide each column of plain words is, relative to the others, so every
 * row lays its cells out alike and the columns line up: as wide as the
 * longest word in it, or half its longest text, whichever is more, since a
 * cell wraps onto two lines. In characters.
 */
export function columnWeights(table: ChangeTable): number[] {
  const rows = table.changes.map(cellsOf)
  const heads = columnsOf(table, false)
  return heads.map((head, at) =>
    Math.max(
      1,
      ...[head, ...rows.map(row => row[at] ?? '')].map(text =>
        Math.max(
          ...text.split(/\s+/).map(word => word.length),
          Math.ceil(text.length / 2)
        )
      )
    )
  )
}

/** What became of a change, or nothing while it waits or runs. */
export function outcomeOf(status: TessChangeStatus): string | undefined {
  if (status === 'done') return lstrings.tess_change_done
  if (status === 'failed') return lstrings.tess_change_failed
  if (status === 'expired') return lstrings.tess_change_expired
  if (status === 'unknown') return lstrings.tess_change_check
}

/** Whether a batch shows its Status column: once any change has ended. */
export function showsStatus(changes: readonly TessChange[]): boolean {
  return changes.some(change => outcomeOf(change.status) != null)
}

/**
 * The batches of a conversation, each under the last reply of its turn, by
 * that reply's id: the changes of every reply from one message of the
 * person's to the next, in order. A turn that proposed nothing has none.
 * The note of a confirmed change is never one of the messages shown, so the
 * report on a batch is in the batch's turn, and the batch moves under it.
 */
export function changeBatches(
  messages: readonly TessMessage[]
): Map<string, TessChange[]> {
  const batches = new Map<string, TessChange[]>()
  let changes: TessChange[] = []
  let last: string | undefined
  const close = (): void => {
    if (last != null && changes.length > 0) batches.set(last, changes)
    changes = []
    last = undefined
  }
  for (const message of messages) {
    if (message.role === 'user') {
      close()
      continue
    }
    last = message.id
    changes.push(...message.changes)
  }
  close()
  return batches
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

/** Text as HTML that says it and nothing more. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char])
}

/**
 * A batch's tables as HTML, to expand over the pane (`RichViewer`). Every
 * word is escaped: the labels, values and summaries are Tess's. The frame
 * styles the cells in the app's colours, so the page needs no colour of its
 * own and reads in either theme.
 */
export function changeTableHtml(changes: readonly TessChange[]): string {
  const withStatus = showsStatus(changes)
  return changeTables(changes)
    .map(table => {
      const head = columnsOf(table, withStatus)
        .map(column => `<th>${escapeHtml(column)}</th>`)
        .join('')
      const rows = table.changes
        .map(change => {
          const cells = [
            ...cellsOf(change),
            ...(withStatus ? [outcomeOf(change.status) ?? ''] : [])
          ]
          return `<tr>${cells.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
        })
        .join('')
      return `<table style="margin:0 0 16px"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
    })
    .join('')
}
