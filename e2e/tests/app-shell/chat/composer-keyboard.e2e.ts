import { setTimeout as delay } from 'node:timers/promises'

import { expect } from 'chai'

import type { MaestroDevice } from '../../../core/maestro'
import { defineE2e } from '../../../core/spec'
import {
  aboveKeyboard,
  type Box,
  boxOf,
  flatten,
  type Node,
  platformOf,
  typeKeys
} from '../../../rigs/app/keyboardDock'
import { measureComposerMotion } from '../../../rigs/chat/composerMotion'
import { fixtureFor, providerFor } from '../../../rigs/chat/messageLinkFixture'
import {
  chatLinkUi,
  clearChatComposer,
  readChatComposer
} from '../../../rigs/chat/messageLinkUi'

async function chatGeometry(device: MaestroDevice): Promise<{
  field: Box
  list: Box
  bubbles: Array<{ id: string; box: Box }>
}> {
  const nodes = flatten((await device.hierarchy()) as Node)
  const bounds = (id: string): Box | undefined =>
    boxOf(nodes.find(node => node.id === id))
  const field = bounds('chat-composer')
  const list = bounds('chat-message-history')
  if (field == null || list == null)
    throw new Error('Missing chat history or composer')
  const bubbles = nodes
    .flatMap(node => {
      const box = boxOf(node)
      if (
        node.id?.startsWith('chat-bubble-') !== true ||
        box == null ||
        box.y + box.height <= list.y ||
        box.y >= field.y
      )
        return []
      return [{ id: node.id, box }]
    })
    .sort((a, b) => a.box.y - b.box.y)
  return { field, list, bubbles }
}

/** Track the composer on the signed phone while reading a seeded conversation. */
export default defineE2e({
  id: 'app-shell/chat/composer-keyboard',
  title: 'A conversation’s composer rides the keyboard on a phone',
  kind: 'e2e',
  covers: [
    'src/app/chat/ChatHistoryList.native.tsx',
    'src/app/chat/ChatComposerBand.native.tsx',
    'src/app/components/keyboardControllerOwner.native.ts'
  ],
  stack: 'seat',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'required' }]
    },
    'android-app': {
      devices: [
        { role: 'phone', needs: ['android-phone'], hardware: 'required' }
      ]
    }
  },
  services: ['api'],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: ['chatLinkFixture'],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'rides-keyboard': async ctx => {
      const fixture = fixtureFor(ctx)
      const observer = await providerFor(fixture, fixture.observer)
      const platform = platformOf(ctx)
      const ios = platform === 'ios'
      let cleanup: (() => Promise<void>) | undefined
      try {
        const { m: device, enter } = await chatLinkUi(
          ctx,
          fixture,
          observer,
          platform
        )
        await enter()
        const draft = await readChatComposer(device, platform)
        expect(
          draft === '' || draft === 'Message',
          'an empty synthetic composer'
        ).equals(true)
        cleanup = async () => {
          const value = await readChatComposer(device, platform)
          if (value === 'keyboard') {
            await device.tapOn({ id: 'chat-composer' })
            await clearChatComposer(device, platform, value)
          }
        }
        const latest = (
          await observer.engine.open(fixture.conversationId)
        ).messages.at(-1)
        if (latest == null)
          throw new Error(
            'The keyboard fixture needs a conversation with history'
          )
        const newest = 'chat-bubble-' + latest.id
        const jump = 'chat-jump-latest'
        if (
          flatten((await device.hierarchy()) as Node).some(n => n.id === jump)
        )
          await device.tapOn({ id: jump })
        await device.scrollUntilVisible({
          element: { id: newest },
          direction: 'down',
          timeout: 12000
        })
        for (const position of ['follower', 'reader'] as const) {
          if (position === 'reader') {
            for (let n = 0; n < 5; n++) {
              const { list, field, bubbles } = await chatGeometry(device)
              if (!bubbles.some(b => b.id === newest)) break
              const x = Math.round(list.x + list.width * 0.04)
              const room = field.y - list.y
              await device.dragAndDrop({
                from: { point: x + ',' + Math.round(list.y + room * 0.35) },
                to: { point: x + ',' + Math.round(list.y + room * 0.8) },
                duration: 350,
                holdDuration: 15
              })
            }
          }
          const closed = await chatGeometry(device)
          expect(
            closed.bubbles.some(b => b.id === newest),
            'starting reading position'
          ).equals(position === 'follower')
          const top = closed.list.y + (closed.field.y - closed.list.y) * 0.23
          const anchor = closed.bubbles.find(b => b.box.y >= top)
          if (position === 'reader' && anchor == null)
            throw new Error('Missing stable reader row')
          const motion = await measureComposerMotion(
            ctx,
            device,
            async () => {
              await device.tapOn({ id: 'chat-composer' })
              if (position === 'follower')
                await typeKeys(device, ios, 'keyboard')
              await device.waitForAnimationToEnd()
              expect(await readChatComposer(device, platform)).equals(
                'keyboard'
              )
              const opened = await chatGeometry(device)
              expect(opened.field.y, 'the field rises').lessThan(
                closed.field.y - opened.field.height
              )
              const keyboard = await aboveKeyboard(device, opened.field)
              if (keyboard != null) expect(keyboard.above).equals(true)
              if (position === 'follower')
                expect(opened.bubbles.some(b => b.id === newest)).equals(true)
              else if (anchor != null) {
                const same = opened.bubbles.find(b => b.id === anchor.id)
                if (same == null)
                  throw new Error('Opening the keyboard displaced the read row')
                expect(same.box.y - opened.list.y).closeTo(
                  anchor.box.y - closed.list.y,
                  opened.field.height * 0.09
                )
              }
              const x = Math.round(opened.list.x + opened.list.width * 0.04)
              // Release a short drag before the commit threshold so the system can
              // reverse, then make a complete dismissal from the same lane.
              const from = {
                point:
                  x +
                  ',' +
                  Math.round(opened.field.y - opened.field.height * 0.2)
              }
              await device.dragAndDrop({
                from,
                to: {
                  point:
                    x +
                    ',' +
                    Math.round(opened.field.y + opened.field.height * 0.55)
                },
                duration: 330,
                holdDuration: 10
              })
              await delay(350)
              const partial = await chatGeometry(device)
              if (
                Math.abs(partial.field.y - opened.field.y) >
                opened.field.height * 0.15
              )
                throw new Error(
                  'The partial drag did not return to the open keyboard'
                )
              await device.dragAndDrop({
                from,
                to: { point: x + ',' + Math.round(closed.field.y) },
                duration: 450,
                holdDuration: 10
              })
            },
            'composer-motion-' + position
          )
          expect(
            await readChatComposer(device, platform),
            'draft after dismissal'
          ).equals('keyboard')
          await ctx.checkpoint('composer-over-keyboard-' + position, {
            expect: [{ id: 'chat-composer' }],
            readBack: async () => {
              expect(
                motion.up,
                'the composer rose through intermediate frames'
              ).equals(true)
              expect(
                motion.down,
                'the composer returned through intermediate frames'
              ).equals(true)
            }
          })
        }
      } finally {
        try {
          await cleanup?.()
        } finally {
          observer.engine.stop()
        }
      }
    }
  }
})
