import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TagIdentityRegistry, tagTargets } from '../../common/eventTags'
import { LocalEventTags } from './localEventTags'

describe('development account tags', () => {
  it('limits ordinary popularity while exposing the full retained catalog', () => {
    const tags = new LocalEventTags()
    for (let at = 0; at < 31; at++)
      tags.save('actor', 'game', `target-${at}`, `choice ${at}`)
    expect(tags.choices('actor').popular).has.length(30)
    expect(tags.choices('actor', true).popular).has.length(31)
    tags.save('actor', 'game', 'extra', 'choice 30')
    expect(tags.choices('actor').popular[0]).deep.equals({
      tag: 'choice 30',
      count: 2
    })
  })

  it('keeps distinct history across games and accounts with active assignment popularity', () => {
    const tags = new LocalEventTags()
    for (let at = 0; at < 11; at++)
      tags.save('actor', 'game-one', 'target', `Choice ${at}`)
    expect(tags.choices('actor').recent).has.length(10)
    expect(tags.choices('new-actor').recent).deep.equals([])
    tags.save('actor', 'game-two', 'other-target', 'choice 10')
    expect(tags.choices('actor').popular[0]).deep.equals({
      tag: 'choice 10',
      count: 2
    })
    tags.save('actor', 'game-two', 'other-target', 'CHOICE 10')
    expect(tags.choices('actor').popular[0].count).equals(2)
    tags.save('new-actor', 'game-two', 'other-target', 'choice 10')
    expect(tags.choices('new-actor').recent).deep.equals(['choice 10'])
    tags.save('actor', 'game-one', 'target', 'choice 0')
    expect(tags.choices('actor').recent[0]).equals('choice 0')
    tags.retain('game-one', [])
    expect(tags.choices('actor').popular).deep.equals([
      { tag: 'choice 10', count: 1 }
    ])
    tags.save('actor', 'game-two', 'other-target', null)
    expect(tags.choices('actor').popular).deep.equals([])
    expect(tags.choices('actor', true).popular).deep.includes({
      tag: 'choice 10',
      count: 0
    })
    expect(tags.choices('actor').recent[0]).equals('choice 0')
    expect(() => tags.save('actor', 'game', 'target', ' ')).throws()
  })

  it('decorates only the assigned target and retains a surviving assignment', () => {
    const tags = new LocalEventTags()
    const registry = new TagIdentityRegistry()
    const document = registry.decorate(
      {
        about: { atBatIndex: 0 },
        result: { eventType: 'single', description: 'Single.' }
      },
      true
    )
    const target = tagTargets(document)[0]
    tags.save('actor', 'game', target.id, 'great catch')
    tags.retain('game', [target.id])
    expect(tagTargets(tags.decorate('game', document))[0].tag).equals(
      'great catch'
    )
    expect(tagTargets(tags.decorate('other-game', document))[0].tag).equals(
      null
    )
  })
})
