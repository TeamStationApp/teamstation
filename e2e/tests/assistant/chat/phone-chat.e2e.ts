import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { type TessNative, withTessNative } from '../../../rigs/tessNativeRig'

/** Her chat on an iPhone, narrow: full screen, with the keyboard left up. */
async function onPhone(
  ctx: E2eContext,
  run: (native: TessNative) => Promise<void>
): Promise<void> {
  await withTessNative(ctx, { surface: 'ios-app', keepKeyboard: true }, run)
}

/**
 * Opens the chat. Opening it turns dictation on, which asks for the microphone the
 * first time.
 */
/**
 * She opens from the mark's menu. A phone header has no Tess button of its own.
 * Checkpoints stay off the pixels: a phone's status bar clock is not pinned.
 */
async function openChat(native: TessNative): Promise<void> {
  await native.tap('TeamStation menu')
  await native.tap('Ask Tess')
  await native.tapIfShown('Allow', 5000)
}

/** A link pushes past the tab root, and only that root has the mark. */
async function backToMark(native: TessNative): Promise<void> {
  for (let steps = 0; steps < 4; steps++) {
    if ((await native.find('TeamStation menu')) != null) return
    await native.tap('Back')
  }
  await native.show('TeamStation menu')
}

export default defineE2e({
  id: 'assistant/chat/phone-chat',
  title:
    'On a phone Tess is a full-screen chat, with her links, hold to confirm, sheet, microphone and live thinking',
  kind: 'e2e',
  covers: [
    'src/app/tess/**',
    'src/app/navigation/**',
    'src/server/routes/tess.ts'
  ],
  stack: 'isolated',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'user', needs: ['ios-phone'], hardware: 'none' }]
    }
  },
  services: ['web'],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: ['app-crash'],
  manual: false,
  scenarios: {
    'header-order': async ctx => {
      await onPhone(ctx, async native => {
        for (const label of ['Tess', 'Notifications'])
          expect(await native.find(label), label).equals(undefined)
        const mark = (await native.find('TeamStation menu'))!.bounds!
        const picture = (await native.nodes()).find(node =>
          (node.text ?? '').startsWith('Account, ')
        )
        if (picture?.bounds == null) throw new Error('No account picture')
        expect(mark.x).lessThan(picture.bounds.x)
        await native.tap('TeamStation menu')
        await native.show('About TeamStation')
        await native.show('Ask Tess')
        await ctx.checkpoint('header', {
          expect: [{ text: 'Ask Tess' }, { text: 'About TeamStation' }]
        })
      })
    },
    'full-screen-chat': async ctx => {
      await onPhone(ctx, async native => {
        const { exactly, find, screen, show } = native
        await openChat(native)
        for (const label of [
          'Close Tess',
          'Ask Tess',
          'Attach a file',
          'Dictate'
        ])
          await show(label)
        const size = await screen()
        const mic = (await find('Dictate'))!.bounds!
        const send = (await find('Send'))!.bounds!
        expect(mic.x, 'the mic right of Send').greaterThanOrEqual(
          send.x + send.width - 1
        )
        const plus = (await find('Attach a file'))!.bounds!
        const field = (await find('Tess field'))!.bounds!
        expect(plus.x).lessThan(field.x)
        // The title bar reads exactly "Ask Tess" at the top left, after her icon; the
        // empty chat's hint only begins with those words.
        const title = (await exactly('Ask Tess'))?.bounds
        if (title == null) throw new Error('No title reads exactly Ask Tess')
        const close = (await find('Close Tess'))!.bounds!
        expect(title.x, 'the title after the icon').greaterThan(16)
        expect(title.x).lessThan(size.width / 3)
        expect(
          Math.abs(title.y + title.height / 2 - (close.y + close.height / 2))
        ).lessThan(12)
        // The small +: 32 points square.
        expect(plus.width).within(28, 36)
        expect(plus.height).within(28, 36)
        // One line until it grows: no taller than the send button beside it.
        expect(field.height).lessThanOrEqual(send.height + 8)
        await ctx.checkpoint('chat', {
          expect: [{ text: 'Close Tess' }, { text: 'Ask Tess' }]
        })
      })
    },
    'bubble-closes-chat-and-opens-settings': async ctx => {
      await onPhone(ctx, async native => {
        await openChat(native)
        await native.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await native.tap('Go to Home, Demo Hawks, Settings')
        await native.hidden('Close Tess')
        await ctx.checkpoint('settings', {
          expect: [{ text: 'Team Settings' }]
        })
      })
    },
    'reopens-on-the-same-conversation': async ctx => {
      await onPhone(ctx, async native => {
        await openChat(native)
        await native.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await native.tap('Go to Home, Demo Hawks, Settings')
        await native.hidden('Close Tess')
        await backToMark(native)
        await openChat(native)
        await ctx.checkpoint('reopened', {
          expect: [{ text: 'Where are my team settings?' }]
        })
      })
    },
    'table-full-screen-loads-nothing-remote': async ctx => {
      await onPhone(ctx, async native => {
        const { m, t } = native
        await openChat(native)
        await native.say('Show our standings as a table', 'The standings')
        await native.tap('Open full screen')
        await native.show('Close')
        await m.swipe({ start: '80%,50%', end: '20%,50%', duration: 400 })
        await ctx.checkpoint('table-full-screen', {
          expect: [{ text: 'Close' }]
        })
        await native.tap('Close')
        await ctx.checkpoint('table-closed', {
          expect: [{ text: 'Ask Tess' }],
          readBack: async () => {
            expect(t.beaconHits(), 'a remote load').equals(0)
          }
        })
      })
    },
    'early-release-runs-nothing-and-a-hold-does': async ctx => {
      await onPhone(ctx, async native => {
        await openChat(native)
        const gamesBefore = await native.gamesOfTeam()
        // The list ends at the card, whose body pushes the reply above it off a phone's
        // screen, so the card's button is what shows the answer.
        await native.say(
          'Add a game against Demo Eagles Saturday at 10',
          'Hold to confirm'
        )
        await native.hold('Hold to confirm', 1000)
        await ctx.checkpoint('nothing-ran', {
          expect: [{ text: 'Hold to confirm' }],
          readBack: async () => {
            expect(await native.gamesOfTeam()).equals(gamesBefore)
          }
        })
        await native.hold('Hold to confirm', 3500)
        await ctx.checkpoint('change-done', {
          expect: [{ text: 'Done', timeout: 30000 }],
          readBack: async () => {
            expect(await native.gamesOfTeam()).equals(gamesBefore + 1)
          }
        })
      })
    },
    'attach-sheet-and-cancelled-picker': async ctx => {
      await onPhone(ctx, async native => {
        await openChat(native)
        await native.tap('Attach a file')
        await ctx.checkpoint('attach-sheet', {
          expect: [{ text: 'Photo' }, { text: 'File' }]
        })
        await native.tap('File')
        await native.show('Cancel', 30000)
        await native.tap('Cancel')
        await native.show('Ask Tess')
        expect(
          (await native.nodes()).some(node =>
            (node.text ?? '').startsWith('Remove ')
          )
        ).equals(false)
      })
    },
    'each-microphone-hold-becomes-a-message': async ctx => {
      await onPhone(ctx, async native => {
        const { m, t } = native
        await openChat(native)
        const heardBefore = t.dictation.heard.length
        // The first hold can be the microphone permission, which records nothing.
        // A hold that sent audio is heard as the fixture phrase; keep going until
        // two of those have landed.
        let nonempty = 0
        for (let tries = 0; nonempty < 2 && tries < 4; tries++) {
          const before = t.dictation.heard.length
          await native.hold('Dictate', 2500)
          await native.tapIfShown('Allow', 3000)
          // The words under the mic are labelled "Dictation status" for assistive
          // technology, so they are not in the phone's hierarchy; what the fixture heard
          // says the hold was transcribed, and Tess has answered once she stops thinking.
          await eventually(
            async () => {
              expect(t.dictation.heard.length).greaterThan(before)
            },
            30000,
            1000
          )
          await m.assertNotVisible({ id: 'Tess thinking', timeout: 60000 })
          nonempty = t.dictation.heard
            .slice(heardBefore)
            .filter(text => text !== '').length
        }
        expect(nonempty).greaterThanOrEqual(2)
        await ctx.checkpoint('messages-heard', {
          expect: [{ text: 'Close Tess' }]
        })
      })
    },
    'thinking-shows-before-the-answer': async ctx => {
      await onPhone(ctx, async native => {
        const { m } = native
        await openChat(native)
        // Her summary shows only while the row is open, as it is while she works; a
        // finished reply's row is closed. Her two reads take a few seconds, about as long
        // as the driver waits for the spinners to stop, so Send is tapped without that
        // wait and the screen is read until one reading shows the open row: that same
        // reading must not hold her answer yet.
        const texts = async (): Promise<string[]> =>
          (await native.nodes()).map(node => node.text ?? '')
        const count = (all: string[], part: string): number =>
          all.filter(text => text.includes(part)).length
        const summary = 'They want their last two'
        const answer = 'won the one before it 9 to 1'
        await native.typeIn('How did our last two games go?')
        await m.tapOn({ text: 'Send', timeout: 20000 })
        let early: string[] = []
        await eventually(
          async () => {
            early = await texts()
            expect(early).includes('Thinking')
            expect(count(early, summary)).greaterThan(0)
          },
          20000,
          50
        )
        expect(count(early, answer), 'the answer before her thinking').equals(0)
        await eventually(
          async () => {
            expect(count(await texts(), answer)).greaterThan(0)
          },
          60000,
          1000
        )
        await m.assertNotVisible({ id: 'Tess thinking', timeout: 60000 })
        await ctx.checkpoint('thought-left-above-the-answer', {
          expect: [{ text: 'Thought for .*s' }]
        })
      })
    },
    'sideways-stays-full-screen': async ctx => {
      await onPhone(ctx, async native => {
        const { m } = native
        await openChat(native)
        // An iPhone keeps the app's own screens upright (only the multi-camera view
        // turns), so the driver's rotation is refused and the chat stays as it was, full
        // screen.
        const upright = await native.screen()
        const turned: boolean = await m
          .setOrientation({ orientation: 'LANDSCAPE' })
          .then(
            () => true,
            (error: unknown) => {
              if (!String(error).includes('Unable To Rotate')) throw error
              return false
            }
          )
        await native.show('Close Tess')
        const sideways = await native.screen()
        const wideField = (await native.find('Tess field'))!.bounds!
        expect(wideField.x + wideField.width).greaterThan(sideways.width * 0.6)
        if (!turned) expect(sideways).deep.equals(upright)
        await m
          .setOrientation({ orientation: 'PORTRAIT' })
          .catch((error: unknown) => {
            if (turned) throw error
          })
        await ctx.checkpoint('still-full-screen', {
          expect: [{ text: 'Close Tess' }]
        })
      })
    }
  }
})
