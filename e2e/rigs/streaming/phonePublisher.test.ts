import { expect } from 'chai'

import { flatten, PhonePublisher } from './phonePublisher'
import { fakeDevice } from './surfaces/fakes.test'

const noSleep = async (): Promise<void> => undefined

const SLIDER = {
  children: [
    {
      id: 'slide-to-stop-knob',
      bounds: { x: 10, y: 100, width: 40, height: 40 }
    },
    {
      id: 'slide-to-stop-track',
      bounds: { x: 0, y: 100, width: 300, height: 40 }
    }
  ]
}

/** A phone whose screen shows `visible` texts and ids, and nothing else. */
function phone(visible: string[]): ReturnType<typeof fakeDevice> {
  return fakeDevice({
    assertVisible: (arg: unknown) => {
      const target = arg as { text?: string; id?: string }
      if (!visible.includes(target.text ?? target.id ?? '')) {
        throw new Error('not shown')
      }
    },
    hierarchy: visible.includes('Name this camera angle')
      ? { type: 'EditText', text: 'PhoneA' }
      : SLIDER
  })
}

function publisher(
  device: ReturnType<typeof fakeDevice>['device']
): PhonePublisher {
  return new PhonePublisher({
    device: device as never,
    appId: 'app.teamstation.develop',
    gameLink: 'teamstation://games/g1?tab=watch',
    angle: 'PhoneA',
    sleep: noSleep
  })
}

describe('a publishing phone', function () {
  it('names a new camera for its angle and starts the stream', async function () {
    const { device, calls } = phone([
      'Name this camera angle',
      '^PhoneA$',
      'broadcast-button'
    ])
    await publisher(device).start()
    const acts = calls.filter(
      call => !['assertVisible', 'hierarchy'].includes(call[0])
    )
    expect(acts).deep.equals([
      ['launchApp', { appId: 'app.teamstation.develop', stopApp: true }],
      ['openLink', { link: 'teamstation://games/g1?tab=watch' }],
      ['tapOn', { text: 'Record Video' }],
      ['inputText', { text: 'PhoneA' }],
      ['tapOn', { text: 'Record with this phone' }],
      ['tapOn', { id: 'broadcast-button' }]
    ])
  })

  it('retypes a truncated name and checks the value on the iOS input', async function () {
    let value = ''
    let retried = false
    const { device, calls } = fakeDevice({
      hierarchy: {
        type: 'TextField',
        id: 'Camera angle',
        text: 'Camera angle'
      },
      inputText: ({ text }: { text: string }) => {
        if (retried || text !== 'h') value += text
      },
      eraseText: () => {
        value = ''
        retried = true
      },
      assertVisible: ({ text, id }: { text?: string; id?: string }) => {
        if (
          ['Camera angle', 'camera-name'].includes(id ?? '') &&
          text === `^${value}$`
        )
          return
        if (text === 'Name this camera angle' || id === 'broadcast-button')
          return
        throw new Error('not shown')
      }
    })
    await publisher(device).start()
    expect(value).equals('PhoneA')
    expect(calls.filter(([name]) => name === 'eraseText')).length(1)
  })

  it('stops before recording when the field still has the wrong name', async function () {
    const { device, calls } = fakeDevice({
      hierarchy: { type: 'EditText', text: 'PneA' }
    })
    const failure = await publisher(device)
      .start()
      .catch((error: unknown) => (error as Error).message)
    expect(failure).equals(
      'PhoneA: the camera name field did not show the requested angle'
    )
    expect(calls.filter(([name]) => name === 'tapOn')).deep.equals([
      ['tapOn', { text: 'Record Video' }]
    ])
  })

  it('reopens a camera that already has its name', async function () {
    const { device, calls } = phone(['broadcast-button', '^PhoneA$'])
    await publisher(device).start()
    expect(calls.some(call => call[0] === 'inputText')).equals(false)
  })

  it('does not broadcast an already named camera under the wrong label', async function () {
    const { device, calls } = phone(['broadcast-button', '^PneA$'])
    const failure = await publisher(device)
      .start()
      .catch((error: unknown) => (error as Error).message)
    expect(failure).equals(
      'PhoneA: the camera preview showed a different angle'
    )
    expect(calls).not.deep.include(['tapOn', { id: 'broadcast-button' }])
  })

  it('says when the camera never opens, or the stream never starts', async function () {
    const closed = phone([])
    expect(
      await publisher(closed.device)
        .start()
        .catch((e: unknown) => (e as Error).message)
    ).equals('PhoneA: the camera screen did not open')
    const idle = phone([
      'broadcast-button',
      '^PhoneA$',
      'Press record to start stream'
    ])
    expect(
      await publisher(idle.device)
        .start()
        .catch((e: unknown) => (e as Error).message)
    ).equals('PhoneA: the broadcast button did not start the stream')
  })

  it('stops by sliding the knob to the end of its track, then closes', async function () {
    const { device, calls } = phone(['Press record to start stream'])
    await publisher(device).stop()
    expect(calls.find(call => call[0] === 'swipe')![1]).deep.equals({
      startX: 30,
      startY: 120,
      endX: 296,
      endY: 120,
      duration: 800
    })
    expect(calls.at(-1)).deep.equals(['tapOn', { id: 'camera-close' }])
    const stuck = phone([])
    expect(
      await publisher(stuck.device)
        .stop()
        .catch((e: unknown) => (e as Error).message)
    ).equals('PhoneA: Slide to Stop did not stop the stream')
  })

  it('walks a hierarchy depth first', function () {
    expect(flatten(SLIDER).map(node => node.id)).deep.equals([
      undefined,
      'slide-to-stop-knob',
      'slide-to-stop-track'
    ])
    expect(flatten(undefined)).deep.equals([])
  })
})
