import { expect } from 'chai'
import { describe, it } from 'mocha'

import { compactEvents, type StreamEvent } from './eventStream'

let sequence = 0

function row(event: Partial<StreamEvent> & { code: string }): unknown {
  sequence += 1
  return {
    sequence_number: sequence,
    event_data: { id: `e${sequence}`, ...event }
  }
}

function codes(events: StreamEvent[]): string[] {
  return events.map(event => event.code)
}

describe('compacting a recorded game stream', function () {
  beforeEach(function () {
    sequence = 0
  })

  it('puts the events in the order they were recorded', function () {
    const rows = [row({ code: 'pitch' }), row({ code: 'base_running' })]
    expect(codes(compactEvents([rows[1], rows[0]]))).to.deep.equal([
      'pitch',
      'base_running'
    ])
  })

  it('unpacks a transaction into the events it holds', function () {
    const events = compactEvents([
      row({
        code: 'transaction',
        events: [
          { code: 'pitch', id: 'a' },
          { code: 'ball_in_play', id: 'b' }
        ]
      })
    ])
    expect(codes(events)).to.deep.equal(['pitch', 'ball_in_play'])
  })

  it('leaves out what an undo undid', function () {
    const events = compactEvents([
      row({ code: 'pitch' }),
      row({ code: 'base_running' }),
      row({ code: 'undo' })
    ])
    expect(codes(events)).to.deep.equal(['pitch'])
  })

  it('takes a whole transaction back out again', function () {
    const events = compactEvents([
      row({ code: 'pitch' }),
      row({
        code: 'transaction',
        events: [
          { code: 'pitch', id: 'a' },
          { code: 'ball_in_play', id: 'b' }
        ]
      }),
      row({ code: 'undo' })
    ])
    expect(codes(events)).to.deep.equal(['pitch'])
  })

  it('reaches one event further back for each undo in a row', function () {
    const events = compactEvents([
      row({ code: 'pitch' }),
      row({ code: 'base_running' }),
      row({ code: 'end_half' }),
      row({ code: 'undo' }),
      row({ code: 'undo' })
    ])
    expect(codes(events)).to.deep.equal(['pitch'])
  })

  it('brings back what a redo redid', function () {
    // Sixteen of these across 95 games, and dropping them was enough to leave
    // a game batting in the wrong half of the fifth: a pitch that really was
    // thrown goes uncounted, and from there the count, the batter and the
    // pitcher are all somebody else's.
    const events = compactEvents([
      row({ code: 'pitch' }),
      row({ code: 'base_running' }),
      row({ code: 'undo' }),
      row({ code: 'redo' })
    ])
    expect(codes(events)).to.deep.equal(['pitch', 'base_running'])
  })

  it('undoes a redo by undoing what it brought back', function () {
    const events = compactEvents([
      row({ code: 'pitch' }),
      row({ code: 'base_running' }),
      row({ code: 'undo' }),
      row({ code: 'redo' }),
      row({ code: 'undo' })
    ])
    expect(codes(events)).to.deep.equal(['pitch'])
  })

  it('deletes the event a delete names, wherever it sits', function () {
    const first = row({ code: 'pitch' }) as {
      event_data: { id: string }
    }
    const events = compactEvents([
      first,
      row({ code: 'base_running' }),
      row({ code: 'delete', deleteIds: [first.event_data.id] })
    ])
    expect(codes(events)).to.deep.equal(['base_running'])
  })

  it('lays the head stream before the main one', function () {
    const events = compactEvents([
      row({ code: 'pitch' }),
      row({ code: 'set_teams', compactorAttributes: { stream: 'head' } })
    ])
    expect(codes(events)).to.deep.equal(['set_teams', 'pitch'])
  })

  it('counts undo within its own stream only', function () {
    const events = compactEvents([
      row({ code: 'set_teams', compactorAttributes: { stream: 'head' } }),
      row({ code: 'pitch' }),
      row({ code: 'undo' })
    ])
    expect(codes(events)).to.deep.equal(['set_teams'])
  })
})
