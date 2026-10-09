import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  completedPlayTag,
  eventSignature,
  historyTargets,
  normalizeTag,
  TagIdentityRegistry,
  tagMetadata,
  tagTargets,
  withPreviousTagIdentities,
  withTargetTags
} from './eventTags'

const pitch = (code = 'B', description = 'Ball'): Record<string, unknown> => ({
  type: 'pitch',
  isPitch: true,
  details: { code, description },
  player: { id: 1 }
})
const play = (): {
  about: { atBatIndex: number }
  result: Record<string, string>
  playEvents: Array<Record<string, unknown>>
} => ({
  about: { atBatIndex: 0 },
  result: { eventType: 'single', description: 'Single to center.' },
  playEvents: [pitch(), pitch('C', 'Called Strike')]
})

describe('event tag identity and labels', () => {
  it('shows six logical Undo events without duplicating the terminal strikeout pitch', () => {
    const registry = new TagIdentityRegistry()
    const names: Record<string, string> = {
      B: 'Ball',
      C: 'Called Strike',
      F: 'Foul',
      S: 'Swinging Strike'
    }
    const document = registry.decorate(
      {
        about: { atBatIndex: 0 },
        result: { eventType: 'strikeout', description: 'Strikeout' },
        playEvents: ['B', 'C', 'F', 'B', 'F', 'S'].map(code =>
          pitch(code, names[code])
        )
      },
      true
    )
    expect(tagTargets(document)).has.length(7)
    expect(tagTargets(document)[0].completed).equals(undefined)
    expect(tagTargets(document).at(-1)?.completed).equals(true)
    expect(historyTargets(document).map(target => target.title)).deep.equals([
      'Ball',
      'Called Strike',
      'Foul',
      'Ball',
      'Foul',
      'Strikeout'
    ])
    const terminal = tagTargets(document).at(-2)!
    const tagged = withTargetTags(
      document,
      new Map([[terminal.id, 'great finish']])
    )
    expect(historyTargets(tagged).at(-1)?.id).equals(terminal.id)
    expect(historyTargets(tagged).at(-1)?.completed).equals(true)
    expect(completedPlayTag(tagged)).equals('great finish')
    const completed = tagTargets(document).at(-1)!
    const explicit = withTargetTags(
      document,
      new Map([
        [terminal.id, 'great finish'],
        [completed.id, 'great catch']
      ])
    )
    expect(historyTargets(explicit).at(-1)?.id).equals(completed.id)
    expect(completedPlayTag(explicit)).equals('great catch')
  })

  it('coalesces only a terminal in-play pitch, award or matching action', () => {
    const registry = new TagIdentityRegistry()
    for (const [type, event] of [
      ['single', { ...pitch('D'), details: { code: 'D', isInPlay: true } }],
      ['walk', { ...pitch('B'), count: { balls: 4 } }],
      ['intent_walk', { ...pitch('B'), details: { call: { code: 'B' } } }],
      [
        'hit_by_pitch',
        { type: 'action', details: { eventType: 'hit_by_pitch' } }
      ],
      ['strikeout', { ...pitch('unknown'), count: { strikes: 3 } }]
    ] as const) {
      const document = registry.decorate(
        {
          about: { atBatIndex: 0 },
          result: { eventType: type },
          playEvents: [event]
        },
        true
      )
      expect(historyTargets(document)).has.length(1)
    }
    const unrelated = registry.decorate(
      {
        about: { atBatIndex: 1 },
        result: { eventType: 'single' },
        playEvents: [pitch('B')]
      },
      true
    )
    expect(historyTargets(unrelated)).has.length(2)
    const lineup = registry.decorate(
      {
        about: { atBatIndex: 2 },
        result: { eventType: 'walk' },
        playEvents: [{ isSubstitution: true, details: { eventType: 'walk' } }]
      },
      true
    )
    expect(historyTargets(lineup)).has.length(2)
    const current = registry.decorate(
      { about: { atBatIndex: 3 }, playEvents: [pitch()] },
      false
    )
    expect(historyTargets(current)).has.length(1)
    expect(completedPlayTag(current)).equals(null)
    expect(
      historyTargets(registry.decorate({ about: { atBatIndex: 4 } }, true))
    ).has.length(1)
  })

  it('coalesces an imported terminal pitch and displays its tag past an unflagged substitution', () => {
    const registry = new TagIdentityRegistry()
    const document = registry.decorate(
      {
        about: { atBatIndex: 0 },
        result: { eventType: 'walk', description: 'Walk' },
        playEvents: [
          { ...pitch('B'), count: { balls: 4 } },
          {
            type: 'action',
            details: { eventType: 'pitching_substitution' },
            player: { id: 2 },
            position: { code: '1' }
          }
        ]
      },
      true
    )
    const terminal = tagTargets(document)[0]
    const tagged = withTargetTags(
      document,
      new Map([[terminal.id, 'great finish']])
    )
    expect(completedPlayTag(tagged)).equals('great finish')
    const history = historyTargets(tagged)
    expect(history).has.length(2)
    expect(history.at(-1)).deep.includes({
      id: terminal.id,
      completed: true,
      tag: 'great finish'
    })
  })

  it('coalesces a tagged imported hit-by-pitch identified by type without the optional pitch flag', () => {
    const registry = new TagIdentityRegistry()
    const document = registry.decorate(
      {
        about: { atBatIndex: 0 },
        result: { eventType: 'hit_by_pitch' },
        playEvents: [{ type: 'pitch', details: { code: 'H' } }]
      },
      true
    )
    const target = tagTargets(document)[0]
    const tagged = withTargetTags(
      document,
      new Map([[target.id, 'great patience']])
    )
    expect(historyTargets(tagged)).has.length(1)
    expect(historyTargets(tagged)[0].id).equals(target.id)
    expect(completedPlayTag(tagged)).equals('great patience')
  })

  it('refuses ambiguous unnumbered pitch edits while preserving proven timestamp/count append and tail Undo', () => {
    const registry = new TagIdentityRegistry()
    const pitches = [1, 2].map(second => ({
      ...pitch(),
      startTime: `2026-10-08T20:00:0${second}Z`
    }))
    const first = registry.decorate({ ...play(), playEvents: pitches }, true)
    registry.setTag(tagTargets(first)[0].id, 'great pitch')
    const tagged = registry.decorate(first, true)
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [pitches[1]] },
        tagged,
        true
      )
    ).throws('pitch history changed')
    expect(() =>
      withPreviousTagIdentities(
        {
          ...play(),
          playEvents: [
            { ...pitch(), startTime: '2026-10-08T20:00:00Z' },
            ...pitches
          ]
        },
        tagged,
        true
      )
    ).throws('pitch history changed')
    expect(
      tagTargets(
        withPreviousTagIdentities(
          { ...play(), playEvents: [pitches[0]] },
          tagged,
          true
        )
      )[0].id
    ).equals(tagTargets(tagged)[0].id)
    const counted = [1, 2].map(balls => ({
      ...pitch(),
      count: { balls, strikes: 0, outs: 0 }
    }))
    const other = registry.decorate(
      { ...play(), about: { atBatIndex: 2 }, playEvents: counted },
      true
    )
    registry.setTag(tagTargets(other)[0].id, 'great pitch')
    const saved = registry.decorate(other, true)
    expect(
      tagTargets(
        withPreviousTagIdentities(
          { ...play(), about: { atBatIndex: 2 }, playEvents: [counted[0]] },
          saved,
          true
        )
      )[0].id
    ).equals(tagTargets(saved)[0].id)
  })

  it('rejects replacement of a unique timestamped substitution with the same actor and position', () => {
    const event = (n: number, code: number): Record<string, unknown> => ({
      type: 'action',
      details: { eventType: 'defensive_switch' },
      position: { code },
      startTime: `2026-10-08T20:00:0${n}Z`
    })
    const events = [event(0, 8), event(1, 7)]
    const registry = new TagIdentityRegistry()
    const original = registry.decorate({ ...play(), playEvents: events }, true)
    registry.setTag(tagTargets(original)[0].id, 'original switch')
    const assigned = registry.decorate(original, true)
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [events[1], event(2, 8)] },
        assigned,
        true
      )
    ).throws('action history changed')
  })

  it('rejects numbered renumbering and equal-count repeated substitution provenance changes', () => {
    for (const substitutions of [false, true]) {
      const event = (n: number, code: number): Record<string, unknown> =>
        substitutions
          ? {
              type: 'action',
              details: { eventType: 'defensive_switch' },
              position: { code },
              startTime: `2026-10-08T20:00:0${n}Z`
            }
          : {
              ...pitch(),
              pitchNumber: n + 1,
              startTime: `2026-10-08T20:00:0${n}Z`
            }
      const events = substitutions
        ? [event(0, 8), event(1, 7), event(2, 8)]
        : [event(0, 0), event(1, 0)]
      const registry = new TagIdentityRegistry()
      const original = registry.decorate(
        { ...play(), playEvents: events },
        true
      )
      registry.setTag(tagTargets(original)[0].id, 'specific event')
      const assigned = registry.decorate(original, true)
      const changed = substitutions
        ? [events[1], events[2], event(3, 7), event(4, 8)]
        : [{ ...events[1], pitchNumber: 1 }]
      expect(() =>
        withPreviousTagIdentities(
          { ...play(), playEvents: changed },
          assigned,
          true
        )
      ).throws('history changed')
    }
  })

  it('rejects numbered count-only renumbering instead of transferring a removed pitch tag', () => {
    const pitches = [1, 2].map(balls => ({
      ...pitch(),
      pitchNumber: balls,
      count: { balls, strikes: 0, outs: 0 }
    }))
    const registry = new TagIdentityRegistry()
    const original = registry.decorate({ ...play(), playEvents: pitches }, true)
    registry.setTag(tagTargets(original)[0].id, 'first ball')
    const assigned = registry.decorate(original, true)
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [{ ...pitches[1], pitchNumber: 1 }] },
        assigned,
        true
      )
    ).throws('pitch history changed')
  })

  it('rejects count-only mixed-call shifts and pitch numbering mode changes', () => {
    for (const mode of [false, true]) {
      const pitches = [1, 2].map(balls => ({
        ...pitch(),
        count: { balls, strikes: 0, outs: 0 },
        ...(mode ? { startTime: `2026-10-08T20:00:0${balls}Z` } : {})
      }))
      const events = mode
        ? pitches
        : [
            ...pitches,
            {
              ...pitch(),
              details: { code: 'C' },
              count: { balls: 2, strikes: 1, outs: 0 }
            }
          ]
      const registry = new TagIdentityRegistry()
      const original = registry.decorate(
        { ...play(), playEvents: events },
        true
      )
      registry.setTag(tagTargets(original)[0].id, 'specific pitch')
      const assigned = registry.decorate(original, true)
      const changed = mode
        ? events.map((event, index) => ({ ...event, pitchNumber: index + 2 }))
        : [
            events[1],
            events[2],
            { ...events[0], count: { balls: 3, strikes: 1, outs: 0 } }
          ]
      expect(() =>
        withPreviousTagIdentities(
          { ...play(), playEvents: changed },
          assigned,
          true
        )
      ).throws('changed')
    }
  })

  it('preserves imported pitch identities across redundant flag changes including legacy signatures', () => {
    const registry = new TagIdentityRegistry()
    const original = registry.decorate(
      { ...play(), playEvents: [{ type: 'pitch', details: { code: 'B' } }] },
      true
    )
    registry.setTag(tagTargets(original)[0].id, 'imported pitch')
    const assigned = registry.decorate(original, true)
    const legacy = {
      ...structuredClone(assigned),
      tagTargets: structuredClone(tagMetadata(assigned))
    }
    const signature = JSON.parse(legacy.tagTargets.events[0].signature)
    signature[1] = false
    legacy.tagTargets.events[0].signature = JSON.stringify(signature)
    const saved = withPreviousTagIdentities(
      {
        ...play(),
        playEvents: [{ type: 'pitch', isPitch: true, details: { code: 'B' } }]
      },
      legacy,
      true
    )
    expect(tagTargets(saved)[0]).deep.includes({
      id: tagTargets(assigned)[0].id,
      tag: 'imported pitch'
    })
    expect(eventSignature({ type: 'pitch' })).equals(
      eventSignature({ type: 'pitch', isPitch: true })
    )
  })

  it('checks numbered mixed-call counts while allowing proven timestamp corrections and unrelated unique substitutions', () => {
    const events = ['B', 'C', 'B'].map((code, index) => ({
      ...pitch(code),
      pitchNumber: index + 1,
      count: {
        balls: index === 0 ? 1 : index === 1 ? 1 : 2,
        strikes: index === 0 ? 0 : 1,
        outs: 0
      }
    }))
    const registry = new TagIdentityRegistry()
    const original = registry.decorate({ ...play(), playEvents: events }, true)
    registry.setTag(tagTargets(original)[1].id, 'specific strike')
    const assigned = registry.decorate(original, true)
    expect(() =>
      withPreviousTagIdentities(
        {
          ...play(),
          playEvents: [
            events[1],
            events[2],
            { ...events[1], count: { balls: 2, strikes: 2, outs: 0 } }
          ].map((event, index) => ({ ...event, pitchNumber: index + 1 }))
        },
        assigned,
        true
      )
    ).throws('pitch history changed')
    for (const numbered of [false, true]) {
      const timed = events.slice(0, 2).map((event, index) => ({
        ...event,
        pitchNumber: numbered ? event.pitchNumber : undefined,
        startTime: `2026-10-08T20:00:0${index + 1}Z`
      }))
      const identities = new TagIdentityRegistry()
      const old = identities.decorate({ ...play(), playEvents: timed }, true)
      identities.setTag(tagTargets(old)[1].id, 'specific strike')
      const saved = withPreviousTagIdentities(
        {
          ...play(),
          playEvents: timed.map((event, index) => ({
            ...event,
            details: { code: 'C' },
            count: { balls: 0, strikes: index + 1, outs: 0 }
          }))
        },
        identities.decorate(old, true),
        true
      )
      expect(tagTargets(saved)[1]).deep.includes({
        id: tagTargets(old)[1].id,
        tag: 'specific strike'
      })
    }
    const switchA = {
      type: 'action',
      details: { eventType: 'pitching_substitution' },
      player: { id: 1 },
      position: { code: 1 }
    }
    const switches = new TagIdentityRegistry()
    const old = switches.decorate({ ...play(), playEvents: [switchA] }, true)
    switches.setTag(tagTargets(old)[0].id, 'great relief')
    const saved = withPreviousTagIdentities(
      { ...play(), playEvents: [switchA, { ...switchA, player: { id: 2 } }] },
      switches.decorate(old, true),
      true
    )
    expect(tagTargets(saved)[0]).deep.includes({
      id: tagTargets(old)[0].id,
      tag: 'great relief'
    })
    expect(tagTargets(saved)[1].tag).equals(null)
  })

  it('retains a proven numbered pitch after an earlier pitch is removed without renumbering', () => {
    const events = [1, 2].map(pitchNumber => ({
      ...pitch(),
      pitchNumber,
      startTime: `2026-10-08T20:00:0${pitchNumber}Z`
    }))
    const registry = new TagIdentityRegistry()
    const original = registry.decorate({ ...play(), playEvents: events }, true)
    registry.setTag(tagTargets(original)[1].id, 'surviving pitch')
    const saved = withPreviousTagIdentities(
      { ...play(), playEvents: [events[1]] },
      registry.decorate(original, true),
      true
    )
    expect(tagTargets(saved)[0]).deep.includes({
      id: tagTargets(original)[1].id,
      tag: 'surviving pitch'
    })
  })

  it('rejects moving known numbered pitch owners into unused number slots', () => {
    const events = [1, 2].map(pitchNumber => ({
      ...pitch(),
      pitchNumber,
      startTime: `2026-10-08T20:00:0${pitchNumber}Z`,
      count: { balls: pitchNumber, strikes: 0, outs: 0 }
    }))
    const registry = new TagIdentityRegistry()
    const original = registry.decorate({ ...play(), playEvents: events }, true)
    registry.setTag(tagTargets(original)[0].id, 'specific pitch')
    expect(() =>
      withPreviousTagIdentities(
        {
          ...play(),
          playEvents: events.map(event => ({
            ...event,
            pitchNumber: event.pitchNumber + 2
          }))
        },
        registry.decorate(original, true),
        true
      )
    ).throws('pitch history changed')
  })

  it('retains unrelated post-pitch advisories and uses the actual terminal pitch tag', () => {
    const registry = new TagIdentityRegistry()
    const original = registry.decorate(
      {
        ...play(),
        result: { eventType: 'walk' },
        playEvents: [
          {
            ...pitch(),
            pitchNumber: 4,
            count: { balls: 4, strikes: 0, outs: 0 }
          },
          {
            type: 'action',
            details: { eventType: 'game_advisory' },
            count: { balls: 4, strikes: 0, outs: 0 }
          }
        ]
      },
      true
    )
    registry.setTag(tagTargets(original)[0].id, 'terminal pitch')
    registry.setTag(tagTargets(original)[1].id, 'unrelated advisory')
    const assigned = registry.decorate(original, true)
    expect(completedPlayTag(assigned)).equals('terminal pitch')
    expect(historyTargets(assigned).map(target => target.id)).deep.equals([
      tagTargets(assigned)[1].id,
      tagTargets(assigned)[0].id
    ])
  })

  it('rejects equal-length legacy pitch reorders with partial timestamp provenance', () => {
    const registry = new TagIdentityRegistry()
    const pitches = [
      { ...pitch(), startTime: '2026-10-08T20:00:01Z' },
      pitch(),
      { ...pitch(), startTime: '2026-10-08T20:00:03Z' }
    ]
    const original = registry.decorate({ ...play(), playEvents: pitches }, true)
    registry.setTag(tagTargets(original)[0].id, 'great pitch')
    const tagged = registry.decorate(original, true)
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [pitches[2], pitches[1], pitches[0]] },
        tagged,
        true
      )
    ).throws('pitch history changed')
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [pitch(), pitches[1], pitches[2]] },
        tagged,
        true
      )
    ).throws('pitch history changed')
    const counted = [
      { ...pitch(), count: { balls: 1, strikes: 0, outs: 0 } },
      pitch(),
      { ...pitch(), count: { balls: 2, strikes: 0, outs: 0 } }
    ]
    const byCount = new TagIdentityRegistry()
    const countOriginal = byCount.decorate(
      { ...play(), about: { atBatIndex: 2 }, playEvents: counted },
      true
    )
    byCount.setTag(tagTargets(countOriginal)[0].id, 'great pitch')
    const assigned = byCount.decorate(countOriginal, true)
    expect(() =>
      withPreviousTagIdentities(
        {
          ...play(),
          about: { atBatIndex: 2 },
          playEvents: [counted[2], counted[1], counted[0]]
        },
        assigned,
        true
      )
    ).throws('pitch history changed')

    expect(
      tagTargets(
        withPreviousTagIdentities(
          { ...play(), playEvents: pitches },
          tagged,
          true
        )
      )[0].id
    ).equals(tagTargets(tagged)[0].id)
  })

  it('normalizes casing and whitespace with Unicode code point boundaries', () => {
    expect(normalizeTag('  GREAT  \nCatch  ')).equals('great catch')
    expect(normalizeTag('😀'.repeat(64))).equals('😀'.repeat(64))
    for (const input of [null, 1, '', ' \n ', '😀'.repeat(65)])
      expect(() => normalizeTag(input)).throws(TypeError)
  })

  it('keeps reordered substitution position identity and normalizes legacy object signatures', () => {
    const position = {
      code: '1',
      name: 'Pitcher',
      type: 'Pitcher',
      abbreviation: 'P'
    }
    const action = {
      type: 'action',
      isPitch: false,
      details: { eventType: 'pitching_substitution' },
      position,
      player: { id: 1 }
    }
    const reordered = {
      ...action,
      position: {
        abbreviation: 'P',
        type: 'Pitcher',
        name: 'Pitcher',
        code: '1'
      }
    }
    expect(eventSignature(action)).equals(eventSignature(reordered))
    const registry = new TagIdentityRegistry()
    const original = registry.decorate(
      { ...play(), playEvents: [action] },
      true
    )
    const target = tagTargets(original)[0]
    registry.setTag(target.id, 'great relief')
    const tagged = registry.decorate(original, true)
    const legacy = tagMetadata(tagged)
    const values = JSON.parse(legacy.events[0].signature) as unknown[]
    values[6] = position
    legacy.events[0].signature = JSON.stringify(values)
    const restored = new TagIdentityRegistry()
    restored.restore({ ...tagged, tagTargets: legacy })
    expect(
      tagTargets(
        restored.decorate({ ...play(), playEvents: [reordered] }, true)
      )[0]
    ).deep.includes({ id: target.id, tag: 'great relief' })
  })

  it('anchors substitutions by stable actor and position apart from repeatable activities', () => {
    const substitution = {
      type: 'action',
      details: { eventType: 'pitching_substitution' },
      player: { id: 1 },
      position: { code: '1', name: 'Pitcher' }
    }
    const pickoff = { type: 'action', details: { eventType: 'pickoff' } }
    const registry = new TagIdentityRegistry()
    const original = tagTargets(
      registry.decorate(
        { ...play(), playEvents: [substitution, pickoff] },
        true
      )
    )
    registry.setTag(original[0].id, 'great relief')
    registry.setTag(original[1].id, 'quick throw')
    const changed = {
      ...substitution,
      position: { code: '1', name: 'Localized pitcher', type: 'Localized role' }
    }
    const after = tagTargets(
      registry.decorate({ ...play(), playEvents: [pickoff, changed] }, true)
    )
    expect(after[0]).deep.includes({ id: original[1].id, tag: 'quick throw' })
    expect(after[1]).deep.includes({ id: original[0].id, tag: 'great relief' })
    const removed = tagTargets(
      registry.decorate({ ...play(), playEvents: [changed] }, true)
    )
    expect(removed[0]).deep.includes({
      id: original[0].id,
      tag: 'great relief'
    })
    expect(eventSignature({ ...substitution, position: 'P' })).equals(
      eventSignature(substitution)
    )
    expect(eventSignature({ ...substitution, position: 1 })).equals(
      eventSignature(substitution)
    )
    expect(
      eventSignature({ ...substitution, position: { abbreviation: 'P' } })
    ).equals(eventSignature(substitution))
    expect(eventSignature({ ...substitution, position: 'unknown' })).not.equals(
      eventSignature(substitution)
    )
  })

  it('refuses ambiguous tagged legacy activity edits and duplicate substitution changes', () => {
    const pickoff = { type: 'action', details: { eventType: 'pickoff' } }
    const steal = { type: 'action', details: { eventType: 'stolen_base' } }
    const registry = new TagIdentityRegistry()
    const first = registry.decorate(
      { ...play(), playEvents: [pickoff, pickoff] },
      true
    )
    registry.setTag(tagTargets(first)[0].id, 'quick throw')
    const tagged = registry.decorate(first, true)
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [steal, pickoff, pickoff] },
        tagged,
        true
      )
    ).throws('action history changed')
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [pickoff, pickoff, steal] },
        tagged,
        true
      )
    ).throws('action history changed')
    const timed = new TagIdentityRegistry()
    const events = [1, 2].map(second => ({
      ...pickoff,
      startTime: `2026-10-08T20:00:0${second}Z`
    }))
    const initial = timed.decorate({ ...play(), playEvents: events }, true)
    timed.setTag(tagTargets(initial)[0].id, 'quick throw')
    const saved = timed.decorate(initial, true)
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), playEvents: [events[1]] },
        saved,
        true
      )
    ).throws('action history changed')
    expect(
      tagTargets(
        withPreviousTagIdentities(
          { ...play(), playEvents: [events[0]] },
          saved,
          true
        )
      )[0].id
    ).equals(tagTargets(saved)[0].id)
    expect(
      tagTargets(
        withPreviousTagIdentities(
          {
            ...play(),
            playEvents: [
              ...events,
              { ...pickoff, startTime: '2026-10-08T20:00:03Z' }
            ]
          },
          saved,
          true
        )
      )
        .slice(0, 2)
        .map(target => target.id)
    ).deep.equals(
      tagTargets(saved)
        .slice(0, 2)
        .map(target => target.id)
    )
    const substitution = {
      type: 'action',
      isSubstitution: true,
      details: { eventType: 'custom_substitution' },
      player: { id: 1 }
    }
    const subs = registry.decorate(
      {
        ...play(),
        about: { atBatIndex: 2 },
        playEvents: [substitution, substitution]
      },
      true
    )
    registry.setTag(tagTargets(subs)[0].id, 'great relief')
    const assigned = registry.decorate(subs, true)
    expect(() =>
      withPreviousTagIdentities(
        { ...play(), about: { atBatIndex: 2 }, playEvents: [substitution] },
        assigned,
        true
      )
    ).throws('repeated action history changed')
    expect(
      tagTargets(
        withPreviousTagIdentities(
          { ...play(), about: { atBatIndex: 2 }, playEvents: [] },
          assigned,
          true
        )
      )
    ).has.length(1)
  })

  it('keeps pitch identity across completion, wording changes and reload', () => {
    const registry = new TagIdentityRegistry()
    const current = registry.decorate(play(), false)
    const first = tagTargets(current)[0]
    expect(registry.setTag(first.id, 'great catch')).equals(true)
    const completed = registry.decorate(
      { ...play(), playEvents: [pitch('B', 'Rewritten sentence'), pitch('C')] },
      true
    )
    expect(tagTargets(completed)[0].id).equals(first.id)
    expect(tagTargets(completed)[0].tag).equals('great catch')
    expect(tagTargets(completed).at(-1)?.eventIndex).equals(null)
    const reopened = new TagIdentityRegistry()
    reopened.restore(completed)
    const next = reopened.decorate(completed, true)
    expect(tagMetadata(next)).deep.equals(tagMetadata(completed))
    expect(registry.setTag('missing_target', null)).equals(false)
  })

  it('keeps specific later pitch identities when an earlier call is corrected among repeated calls', () => {
    const registry = new TagIdentityRegistry()
    const original = registry.decorate(
      { ...play(), playEvents: [pitch('B'), pitch('C'), pitch('B')] },
      true
    )
    const before = tagTargets(original)
    before
      .slice(0, 3)
      .forEach((target, index) => registry.setTag(target.id, `pitch ${index}`))
    const corrected = tagTargets(
      registry.decorate(
        { ...play(), playEvents: [pitch('C'), pitch('C'), pitch('B')] },
        true
      )
    )
    expect(corrected[0].id).not.equals(before[0].id)
    expect(corrected[0].tag).equals(null)
    expect(corrected[1]).deep.includes({ id: before[1].id, tag: 'pitch 1' })
    expect(corrected[2]).deep.includes({ id: before[2].id, tag: 'pitch 2' })
  })

  it('never moves tags into appended pitches when an earlier call is corrected', () => {
    const registry = new TagIdentityRegistry()
    const before = tagTargets(
      registry.decorate(
        { ...play(), playEvents: [pitch('B'), pitch('F'), pitch('B')] },
        false
      )
    )
    before.forEach((target, index) =>
      registry.setTag(target.id, `pitch ${index}`)
    )
    const after = tagTargets(
      registry.decorate(
        {
          ...play(),
          playEvents: [
            pitch('F'),
            pitch('F'),
            pitch('B'),
            pitch('F'),
            pitch('B')
          ]
        },
        false
      )
    )
    expect(after[1]).deep.includes({ id: before[1].id, tag: 'pitch 1' })
    expect(after[2]).deep.includes({ id: before[2].id, tag: 'pitch 2' })
    for (const index of [0, 3, 4]) {
      expect(before.map(target => target.id)).not.includes(after[index].id)
      expect(after[index].tag).equals(null)
    }
  })

  it('uses explicit pitch numbers and falls back to distinct slots for malformed duplicate numbers', () => {
    const registry = new TagIdentityRegistry()
    const numbered = [
      { ...pitch('B'), pitchNumber: 4 },
      { ...pitch('C'), pitchNumber: 5 }
    ]
    const before = tagTargets(
      registry.decorate({ ...play(), playEvents: numbered }, false)
    )
    const after = tagTargets(
      registry.decorate(
        { ...play(), playEvents: [{ type: 'action' }, ...numbered] },
        false
      )
    )
    expect(after.slice(1).map(target => target.id)).deep.equals(
      before.map(target => target.id)
    )
    const malformed = registry.decorate(
      {
        ...play(),
        about: { atBatIndex: 2 },
        playEvents: [
          { ...pitch('B'), pitchNumber: 1 },
          { ...pitch('B'), pitchNumber: 1 }
        ]
      },
      false
    )
    expect(new Set(tagTargets(malformed).map(target => target.id)).size).equals(
      2
    )
    expect(
      tagTargets(
        registry.decorate(
          {
            ...play(),
            about: { atBatIndex: 2 },
            playEvents: [{ ...pitch('B'), pitchNumber: 0 }, pitch('B')]
          },
          false
        )
      ).map(target => target.id)
    ).deep.equals(tagTargets(malformed).map(target => target.id))
  })

  it('aligns surviving repeated pitches around inserted or removed actions', () => {
    const registry = new TagIdentityRegistry()
    const original = tagTargets(
      registry.decorate(
        { ...play(), playEvents: [pitch('B'), pitch('B')] },
        false
      )
    )
    const inserted = tagTargets(
      registry.decorate(
        {
          ...play(),
          playEvents: [
            { type: 'action', details: { eventType: 'pitching_substitution' } },
            pitch('B'),
            pitch('B')
          ]
        },
        false
      )
    )
    expect(inserted.slice(1).map(target => target.id)).deep.equals(
      original.map(target => target.id)
    )
    const removed = tagTargets(
      registry.decorate(
        { ...play(), playEvents: [pitch('B'), pitch('B')] },
        false
      )
    )
    expect(removed.map(target => target.id)).deep.equals(
      original.map(target => target.id)
    )
  })

  it('forgets removed events before an identical pitch replaces them', () => {
    const registry = new TagIdentityRegistry()
    const before = registry.decorate(play(), true)
    const removed = tagTargets(before)[1].id
    registry.decorate({ ...play(), playEvents: [pitch()] }, false)
    const after = registry.decorate(play(), true)
    expect(tagTargets(after)[0].id).equals(tagTargets(before)[0].id)
    expect(tagTargets(after)[1].id).not.equals(removed)
    expect(tagTargets(after).at(-1)?.id).not.equals(
      tagTargets(before).at(-1)?.id
    )
    registry.retain([])
    expect(registry.setTag(tagTargets(after)[0].id, 'test')).equals(false)
  })

  it('preserves legacy metadata from original raw events before decorating shifted indexes', () => {
    const registry = new TagIdentityRegistry()
    const original = registry.decorate(play(), true)
    const shifted = {
      ...play(),
      playEvents: [{ type: 'action' }, ...play().playEvents]
    }
    const preserved = tagTargets(
      withPreviousTagIdentities(shifted, original, true)
    )
    expect(preserved.slice(1).map(target => target.id)).deep.equals(
      tagTargets(original).map(target => target.id)
    )
    expect(withPreviousTagIdentities(shifted, null, true)).equals(shifted)
    expect(
      withPreviousTagIdentities(
        shifted,
        { about: { atBatIndex: 4 }, tagTargets: tagMetadata(original) },
        true
      )
    ).equals(shifted)
    expect(withPreviousTagIdentities(original, shifted, true)).equals(original)
    const duplicate = tagMetadata(original)
    duplicate.events[1].id = duplicate.events[0].id
    expect(
      tagTargets(
        withPreviousTagIdentities(
          { ...original, tagTargets: duplicate },
          original,
          true
        )
      ).map(target => target.id)
    ).deep.equals(tagTargets(original).map(target => target.id))
    const malformed = {
      ...shifted,
      tagTargets: { version: 1, play: null, events: [] }
    }
    expect(
      tagTargets(withPreviousTagIdentities(malformed, original, true))
        .slice(1)
        .map(target => target.id)
    ).deep.equals(tagTargets(original).map(target => target.id))
  })

  it('overlays labels independently without changing original descriptions', () => {
    const registry = new TagIdentityRegistry()
    const before = registry.decorate(play(), true)
    const targets = tagTargets(before)
    const after = withTargetTags(
      before,
      new Map([[targets[0].id, 'great pitch']])
    )
    expect(after.result).deep.equals(before.result)
    expect(after.playEvents).deep.equals(before.playEvents)
    expect(tagTargets(after)[0].tag).equals('great pitch')
    expect(tagTargets(after).at(-1)?.tag).equals(null)
  })

  it('reads malformed and imported metadata safely and names undescribed events', () => {
    for (const raw of [
      null,
      [],
      2,
      { version: 2 },
      { version: 1, events: [null, { id: 'x', index: 0 }] }
    ])
      expect(
        tagMetadata({ about: { atBatIndex: 0 }, tagTargets: raw }).events
      ).deep.equals([])
    const registry = new TagIdentityRegistry()
    const imported = registry.decorate(
      {
        about: { atBatIndex: 2 },
        playEvents: [{ type: 'action', details: { eventType: 'balk' } }]
      },
      true
    )
    expect(tagTargets(imported)[0].title).equals('balk')
    expect(tagTargets(imported).at(-1)?.title).equals('Play')
    const empty = registry.decorate(
      { about: { atBatIndex: 3 }, playEvents: null },
      false
    )
    expect(tagTargets(empty)).deep.equals([])
    expect(eventSignature(null)).equals(eventSignature({}))
    const action = registry.decorate(
      {
        about: { atBatIndex: 4 },
        playEvents: [{}, { details: { code: 'WP' } }]
      },
      false
    )
    expect(tagTargets(action).map(row => row.title)).deep.equals([
      'Action',
      'WP'
    ])
  })
})
