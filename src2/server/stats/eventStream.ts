/**
 * The stream of events a game really consists of, out of the stream that was
 * recorded.
 *
 * A scorer's phone does not append facts and stop. It undoes a pitch, redoes it,
 * deletes an at-bat, inserts one in the middle, and wraps a whole play up as a
 * transaction — and all of that is *in* the stream, in the order it was typed
 * rather than the order the game happened in. The scorer's own engines never
 * see it: a compactor turns the recorded stream into the settled one first, and
 * everything that scores a game reads the settled one.
 *
 * This is a port of that compactor, and it is not optional. Sixteen `redo`
 * events across our 95 archived games were enough on their own to leave a game
 * batting in the wrong half of the fifth, because a dropped redo means a pitch
 * that really was thrown never gets counted, and from there the count, the
 * batter and the pitcher are all somebody else's.
 *
 * Three streams, not one: an event may be tagged `head`, `main` or `tail`, and
 * the settled stream is the three laid end to end. Undo and redo count only
 * within their own stream.
 */
export interface StreamEvent {
  code: string
  id?: string
  _id?: string
  attributes?: Record<string, unknown>
  /** Meta events carry the events they are about. */
  events?: StreamEvent[]
  beforeId?: string
  afterId?: string
  deleteIds?: string[]
  compactorAttributes?: { stream?: string }
}

function idOf(event: StreamEvent | undefined): string | undefined {
  if (event == null) return undefined
  return event._id ?? event.id
}

/** Insert before or after the event named. */
const enum Placement {
  Before,
  After
}

interface Insertion {
  anchorId: string
  placement: Placement
  events: StreamEvent[]
}

/**
 * `insert`, `delete` and `replace` all say the same two things — take these
 * events out, put those ones in beside that one — so an `edit_group` of them is
 * flattened to one pair of lists before any of it is applied.
 */
function groupableEdits(events: StreamEvent[]): {
  deleteIds: string[]
  insertions: Insertion[]
} {
  const accumulated: { deleteIds: string[]; insertions: Insertion[] } = {
    deleteIds: [],
    insertions: []
  }
  const accumulate = (event: StreamEvent): void => {
    switch (event.code) {
      case 'insert':
        if (event.beforeId != null) {
          accumulated.insertions.push({
            anchorId: event.beforeId,
            placement: Placement.Before,
            events: event.events ?? []
          })
        } else if (event.afterId != null) {
          accumulated.insertions.push({
            anchorId: event.afterId,
            placement: Placement.After,
            events: event.events ?? []
          })
        }
        return
      case 'delete':
        accumulated.deleteIds.push(...(event.deleteIds ?? []))
        return
      case 'replace': {
        const deleteIds = event.deleteIds ?? []
        if (deleteIds.length === 0) return
        accumulated.deleteIds.push(...deleteIds)
        accumulated.insertions.push({
          anchorId: deleteIds[0],
          placement: Placement.After,
          events: event.events ?? []
        })
        return
      }
      case 'edit_group':
        for (const inner of event.events ?? []) accumulate(inner)
        break

      default:
        break
    }
  }
  for (const event of events) accumulate(event)
  return accumulated
}

/** What an event did to the settled stream, so that undoing it can be undone. */
type Edit =
  | { kind: 'removed'; at: number; events: StreamEvent[] }
  | { kind: 'inserted'; at: number; events: StreamEvent[] }

class ComponentStream {
  /** Everything pushed, including the undos — this is what undo counts over. */
  private readonly inStream: StreamEvent[] = []
  readonly outStream: StreamEvent[] = []
  /** What each meta event did, keyed by its own id, so undo can reverse it. */
  private readonly edits = new Map<string, Edit[]>()

  push(event: StreamEvent): void {
    this.inStream.push(event)
    this.apply(event)
  }

  private indexOf(id: string | undefined): number {
    if (id == null) return -1
    return this.outStream.findIndex(event => idOf(event) === id)
  }

  private apply(event: StreamEvent): void {
    switch (event.code) {
      case 'insert':
        this.insert(event)
        return
      case 'delete':
        this.delete(event)
        return
      case 'replace':
        this.replace(event)
        return
      case 'edit_group':
        this.editGroup(event)
        return
      case 'transaction':
        this.transaction(event)
        return
      case 'set_game_settings':
        this.setGameSettings(event)
        return
      case 'undo': {
        const target = this.targetOfUndo(event)
        if (target != null) this.undo(target)
        return
      }
      case 'redo': {
        const undone = this.targetOfRedo(event)
        if (undone == null) return
        const original = this.targetOfUndo(undone)
        // Re-applying it appends it at the end, which is where it was when it
        // was typed: undo and redo only ever happen at the live edge.
        if (original != null) this.apply(original)
        return
      }
      default:
        this.record(event, [
          { kind: 'inserted', at: this.outStream.length, events: [event] }
        ])
        this.outStream.push(event)
    }
  }

  private record(event: StreamEvent, edits: Edit[]): void {
    const id = idOf(event)
    if (id != null) this.edits.set(id, edits)
  }

  private insert(event: StreamEvent): void {
    const events = event.events ?? []
    let at: number
    if (event.beforeId != null) at = this.indexOf(event.beforeId)
    else if (event.afterId != null) at = this.indexOf(event.afterId) + 1
    else return
    if (at < 0) return
    this.outStream.splice(at, 0, ...events)
    this.record(event, [{ kind: 'inserted', at, events }])
  }

  private delete(event: StreamEvent): void {
    const removals = this.removalsFor(event.deleteIds ?? [])
    for (const removal of removals) {
      this.outStream.splice(removal.at, removal.events.length)
    }
    this.record(event, removals)
  }

  private replace(event: StreamEvent): void {
    const deleteIds = event.deleteIds ?? []
    if (deleteIds.length === 0) return
    let at = this.indexOf(deleteIds[0])
    const removals = this.removalsFor(deleteIds)
    for (const removal of removals) {
      this.outStream.splice(removal.at, removal.events.length)
      if (removal.at < at) at -= 1
    }
    const events = event.events ?? []
    this.outStream.splice(at, 0, ...events)
    this.record(event, [...removals, { kind: 'inserted', at, events }])
  }

  private editGroup(event: StreamEvent): void {
    const { deleteIds, insertions } = groupableEdits(event.events ?? [])
    const edits: Edit[] = this.removalsFor(deleteIds)
    for (const insertion of insertions) {
      const anchor = this.indexOf(insertion.anchorId)
      if (anchor < 0) continue
      edits.push({
        kind: 'inserted',
        at: insertion.placement === Placement.Before ? anchor : anchor + 1,
        events: insertion.events
      })
    }
    // Highest index first, so every index stays the one it was measured at.
    edits.sort((a, b) => b.at - a.at)
    for (const edit of edits) {
      if (edit.kind === 'removed') {
        this.outStream.splice(edit.at, edit.events.length)
      } else this.outStream.splice(edit.at, 0, ...edit.events)
    }
    this.record(event, edits)
  }

  private removalsFor(deleteIds: string[]): Edit[] {
    const removals: Edit[] = []
    for (const id of deleteIds) {
      const at = this.indexOf(id)
      if (at < 0) continue
      removals.push({ kind: 'removed', at, events: [this.outStream[at]] })
    }
    return removals.sort((a, b) => b.at - a.at)
  }

  private transaction(event: StreamEvent): void {
    const events = event.events ?? []
    const at = this.outStream.length
    this.outStream.push(...events)
    this.record(event, [{ kind: 'inserted', at, events }])
  }

  private setGameSettings(event: StreamEvent): void {
    const at = this.outStream.findIndex(
      held => held.code === 'set_game_settings'
    )
    if (at === -1) {
      this.outStream.push(event)
      this.record(event, [
        { kind: 'inserted', at: this.outStream.length - 1, events: [event] }
      ])
      return
    }
    this.record(event, [
      { kind: 'inserted', at, events: [event] },
      { kind: 'removed', at, events: [this.outStream[at]] }
    ])
    this.outStream[at] = event
  }

  /**
   * The event an undo undoes: walk back over what was typed, where each further
   * undo reaches one event deeper.
   */
  private targetOfUndo(undoEvent: StreamEvent): StreamEvent | undefined {
    let left = 1
    const from = this.inStream.indexOf(undoEvent) - 1
    for (let i = from; i >= 0; i -= 1) {
      if (this.inStream[i].code === 'undo') left += 1
      else {
        left -= 1
        if (left === 0) return this.inStream[i]
      }
    }
    return undefined
  }

  /** And the undo a redo cancels, which must be the last thing that happened. */
  private targetOfRedo(redoEvent: StreamEvent): StreamEvent | undefined {
    let left = 1
    const from = this.inStream.indexOf(redoEvent) - 1
    for (let i = from; i >= 0; i -= 1) {
      if (this.inStream[i].code === 'redo') left += 1
      else if (this.inStream[i].code === 'undo') {
        left -= 1
        if (left === 0) return this.inStream[i]
      } else return undefined
    }
    return undefined
  }

  private undo(target: StreamEvent): void {
    // Undoing a redo is undoing what the redo brought back, which is the undo
    // it cancelled — so run that undo again.
    if (target.code === 'redo') {
      const undone = this.targetOfRedo(target)
      if (undone != null) this.apply(undone)
      return
    }
    const id = idOf(target)
    const edits = id == null ? undefined : this.edits.get(id)
    if (edits == null) {
      const at = this.indexOf(id)
      if (at >= 0) this.outStream.splice(at, 1)
      return
    }
    // Reverse every edit it made, lowest index last for the same reason.
    for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
      if (edit.kind === 'inserted') {
        this.outStream.splice(edit.at, edit.events.length)
      } else this.outStream.splice(edit.at, 0, ...edit.events)
    }
  }
}

/**
 * The settled stream: the events of a game in the order it happened, with what
 * was undone taken out, what was redone put back, and transactions unpacked.
 */
export function compactEvents(latestEvents: unknown): StreamEvent[] {
  if (!Array.isArray(latestEvents)) return []
  const ordered = [...latestEvents].sort(
    (a, b) => Number(a.sequence_number ?? 0) - Number(b.sequence_number ?? 0)
  )

  const streams = new Map<string, ComponentStream>([
    ['head', new ComponentStream()],
    ['main', new ComponentStream()],
    ['tail', new ComponentStream()]
  ])

  for (const row of ordered) {
    const raw = (row as { event_data?: unknown }).event_data
    let event: StreamEvent
    try {
      event = (typeof raw === 'string' ? JSON.parse(raw) : raw) as StreamEvent
    } catch {
      continue
    }
    if (event?.code == null) continue
    const name = event.compactorAttributes?.stream ?? 'main'
    const stream = streams.get(name) ?? streams.get('main')
    stream?.push(event)
  }

  const settled: StreamEvent[] = []
  for (const name of ['head', 'main', 'tail']) {
    const stream = streams.get(name)
    if (stream == null) continue
    for (const event of stream.outStream) settled.push(event)
  }
  return settled
}
