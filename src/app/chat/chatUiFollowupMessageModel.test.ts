import { expect } from 'chai'
import { describe, it } from 'mocha'

import { menuPosition } from './chatInteractionModel'
import { actionsFor, QUICK_REACTIONS } from './chatModel'
import { chat, message, view } from './chatViews.test.helpers'
import {
  bindMessageHover,
  bindMessageTooltips,
  bindPopupKeys,
  bindUserScroll,
  immediatePressProps,
  isFinePointer,
  isRestoringPopupFocus,
  messageTooltipProps,
  watchMessageAnchor
} from './chatWebInteractions.native'

describe('chat follow-up message permissions', function () {
  it('offers the specified readable own, received and moderator actions in order', function () {
    expect(actionsFor(message({ mine: true }), view())).deep.equals([
      'reply',
      'react',
      'copy',
      'pin',
      'delete'
    ])
    expect(actionsFor(message(), view())).deep.equals([
      'reply',
      'react',
      'copy',
      'pin'
    ])
    expect(
      actionsFor(message(), view({ conversation: chat({ canModerate: true }) }))
    ).deep.equals(['reply', 'react', 'copy', 'pin', 'deleteForEveryone'])
    expect(QUICK_REACTIONS).deep.equals(['❤️', '👍', '👎', '😂', '😮', '😢'])
  })

  it('allows personal actions when posting is read-only, closed or locked', function () {
    expect(
      actionsFor(message({ mine: true }), view({ composer: 'readOnly' }))
    ).deep.equals(['react', 'copy', 'pin'])
    expect(
      actionsFor(message({ mine: true }), view({ composer: 'closed' }))
    ).deep.equals(['copy', 'pin'])
    expect(
      actionsFor(message({ mine: true }), view({ composer: 'locked' }))
    ).deep.equals(['copy', 'pin'])
    expect(actionsFor(message({ body: '' }), view())).deep.equals([
      'reply',
      'react',
      'pin'
    ])
    expect(
      actionsFor(
        message(),
        view({
          pins: [{ messageId: 'msg_1', pinnedAt: '2027-04-01T17:00:00Z' }]
        })
      )
    ).deep.equals(['reply', 'react', 'copy', 'unpin'])
  })

  it('never copies or replies to unreadable content and keeps unavailable personal unpin available', function () {
    for (const status of ['lost', 'invalid'] as const) {
      expect(actionsFor(message({ status, mine: true }), view())).deep.equals([
        'delete'
      ])
      expect(actionsFor(message({ status }), view())).deep.equals([])
      expect(
        actionsFor(
          message({ status }),
          view({ conversation: chat({ canModerate: true }) })
        )
      ).deep.equals(['deleteForEveryone'])
      expect(
        actionsFor(
          message({ status, mine: true }),
          view({ composer: 'locked' })
        )
      ).deep.equals([])
    }
    const pins = [{ messageId: 'msg_1', pinnedAt: '2027-04-01T17:00:00Z' }]
    expect(
      actionsFor(message({ status: 'removed', mine: true }), view({ pins }))
    ).deep.equals(['unpin'])
    expect(
      actionsFor(
        message({ status: 'locked' }),
        view({ pins, composer: 'closed' })
      )
    ).deep.equals(['unpin'])
    expect(actionsFor(message({ status: 'removed' }), view())).deep.equals([])
  })

  it('keeps a locked older-epoch placeholder Unpin-only when a newer readable epoch enables composing', function () {
    const older = message({
      status: 'locked',
      epoch: 1,
      senderName: 'Mookie Betts',
      mine: true
    })
    const current = view({
      composer: 'enabled',
      conversation: chat({ canModerate: true }),
      messages: [
        older,
        message({
          id: 'msg_latest',
          seq: 2,
          epoch: 2,
          senderName: 'Shohei Ohtani',
          body: 'Current epoch message'
        })
      ],
      pins: [{ messageId: older.id, pinnedAt: '2027-04-01T17:00:00Z' }]
    })
    for (const mine of [true, false]) {
      expect(actionsFor({ ...older, mine }, current)).deep.equals(['unpin'])
      expect(
        actionsFor({ ...older, mine }, { ...current, pins: [] })
      ).deep.equals([])
    }
  })
})

describe('chat follow-up menu placement', function () {
  it('places a panel below its trigger when there is room and flips it above at the bottom', function () {
    expect(
      menuPosition(
        { x: 300, y: 40, width: 24, height: 24 },
        { width: 224, height: 160 },
        { width: 640, height: 480 }
      )
    ).deep.equals({ left: 100, top: 72 })
    expect(
      menuPosition(
        { x: 300, y: 420, width: 24, height: 24 },
        { width: 224, height: 160 },
        { width: 640, height: 480 }
      )
    ).deep.equals({ left: 100, top: 252 })
  })

  it('keeps edge triggers and oversized panels within the safe viewport margin', function () {
    expect(
      menuPosition(
        { x: 0, y: 0, width: 12, height: 12 },
        { width: 224, height: 160 },
        { width: 320, height: 480 }
      )
    ).deep.equals({ left: 8, top: 20 })
    expect(
      menuPosition(
        { x: 650, y: 510, width: 30, height: 30 },
        { width: 224, height: 160 },
        { width: 640, height: 480 }
      )
    ).deep.equals({ left: 408, top: 312 })
    expect(
      menuPosition(
        { x: 0, y: 0, width: 0, height: 0 },
        { width: 224, height: 160 },
        { width: 120, height: 100 }
      )
    ).deep.equals({ left: 8, top: 8 })
  })
})

describe('chat follow-up native message adapters', function () {
  it('preserves native input with no browser tooltip, hover, anchor or keyboard work', function () {
    let called = 0
    expect(isFinePointer()).equals(false)
    expect(isRestoringPopupFocus()).equals(false)
    expect(immediatePressProps).deep.equals({})
    expect(messageTooltipProps('Reply')).deep.equals({})
    bindMessageHover(undefined, () => {
      called += 1
    })()
    bindMessageTooltips(undefined)()
    bindUserScroll(undefined, () => {
      called += 1
    })()
    bindPopupKeys(undefined, () => {
      called += 1
    })()
    watchMessageAnchor(
      undefined,
      () => {
        called += 1
      },
      () => {
        called += 1
      }
    )()
    expect(called).equals(0)
  })
})
