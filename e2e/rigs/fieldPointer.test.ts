import { expect } from 'chai'
import { describe, it } from 'mocha'

import { runnerTargets } from '../../src/app/scoring/runnerDrag'
import {
  aimLanding,
  aimLandingAt,
  dropOfferedRunner,
  dropRunner,
  type FieldDriver,
  groundPoint,
  installSceneProbe,
  maestroDriver,
  placeFielder,
  placeOffered,
  playerAt,
  pointOf,
  runnerTargetPoint,
  setTrajectory,
  shownAngle,
  tapFielder,
  tapOffered
} from './fieldPointer'

type Point = [number, number]

/** The field box the fake page draws in, and the canvas inside it. */
const BOX = { x: 10, y: 20, width: 400, height: 600 }

/**
 * A page that answers each of the rig's probes by what it asks for, and
 * records every press and drag.
 */
function fakeField(
  answers: Partial<{
    offered: string[]
    angle: string
    nearestBase: number
    plateVisible: boolean
    point: Point | string | null
  }> = {}
): FieldDriver & { taps: Point[]; drags: Array<[Point, Point]> } {
  const taps: Point[] = []
  const drags: Array<[Point, Point]> = []
  const evaluate = async <T>(expression: string): Promise<T> => {
    const answer = (): unknown => {
      if (expression.includes("getAttribute('data-moving')")) return true
      if (
        expression.includes('Drag where the ball was hit') &&
        !expression.includes('getBoundingClientRect')
      )
        return true
      if (expression.includes('Drag up and down for ball trajectory'))
        return true
      if (expression.includes('[aria-live]')) return answers.angle ?? 'Fly 30°'
      if (expression.includes('props.interaction.selectableIds'))
        return answers.offered ?? ['offense-r1']
      if (expression.includes('bases.forEach')) return answers.nearestBase ?? 1
      if (expression.includes('const box = three.gl.domElement'))
        return [200, 300, BOX.x, BOX.y, BOX.width, BOX.height]
      if (expression.includes('data-nameplate][data-position'))
        return answers.plateVisible === false ? null : [90, 100]
      if (expression.includes('const plate = document.querySelector('))
        return answers.point === undefined ? [70, 80] : answers.point
      if (expression.includes("startsWith('player-offense-')")) return [50, 60]
      if (expression.includes('return [r.x, r.y, r.width, r.height]'))
        return [BOX.x, BOX.y, BOX.width, BOX.height]
      if (expression.includes('return [r.x + r.width / 2, r.y + r.height / 2]'))
        return [210, 320]
      if (expression.includes('return project(')) return [5, 6]
      throw new Error(`unexpected probe: ${expression.slice(0, 80)}`)
    }
    return answer() as T
  }
  return {
    evaluate,
    tap: async at => {
      taps.push(at)
    },
    drag: async (from, to) => {
      drags.push([from, to])
    },
    taps,
    drags
  }
}

/** The centre of the target `runnerTargets` lays out for an anchor in the box. */
function centre(to: number, key: 'safe' | 'out'): Point {
  const rect = runnerTargets({ x: 200, y: 300 }, BOX.width, BOX.height, to)[key]
  return [BOX.x + rect.x + rect.width / 2, BOX.y + rect.y + rect.height / 2]
}

describe('fieldPointer', function () {
  it('drives a maestro-d device: a probe through evalBrowserScript, a tap, a held drag', async function () {
    const calls: Array<[string, unknown]> = []
    const field = maestroDriver({
      evalBrowserScript: async options => {
        calls.push(['eval', options])
        return undefined
      },
      vars: async () => ({ fieldProbe: '[1,2]' }),
      tapOnPoint: async options => {
        calls.push(['tap', options])
        return undefined
      },
      dragAndDrop: async options => {
        calls.push(['drag', options])
        return undefined
      }
    })
    expect(await field.evaluate<number[]>('[1, 2]')).deep.equals([1, 2])
    await field.tap([1.4, 2.6])
    await field.drag([1, 2], [3.2, 4.7])
    expect(calls).deep.equals([
      [
        'eval',
        { script: 'return JSON.stringify([1, 2])', output: 'fieldProbe' }
      ],
      ['tap', { x: 1, y: 3 }],
      ['drag', { from: { point: '1,2' }, to: { point: '3,5' }, duration: 600 }]
    ])
  })

  it('reads a ground point through the live camera', async function () {
    expect(await groundPoint(fakeField(), 1, 2)).deep.equals([5, 6])
  })

  it('finds the Safe and Out targets beside the base the runner heads for', async function () {
    const field = fakeField()
    expect(await runnerTargetPoint(field, 2, 'Safe')).deep.equals(
      centre(2, 'safe')
    )
    expect(await runnerTargetPoint(field, 3, 'Out')).deep.equals(
      centre(3, 'out')
    )
    // Home is base 0 as well as 4.
    expect(await runnerTargetPoint(field, 4, 'Out')).deep.equals(
      centre(0, 'out')
    )
  })

  it('drags a runner onto the target of the base he goes to, stays at or goes back to', async function () {
    const field = fakeField()
    await dropRunner(field, 1, 'Safe')
    await dropRunner(field, 2, 'Out', 'stay')
    await dropRunner(field, 3, 'Safe', 'back')
    expect(field.drags).deep.equals([
      [[50, 60], centre(2, 'safe')],
      [[50, 60], centre(2, 'out')],
      [[50, 60], centre(2, 'safe')]
    ])
  })

  it('drops the runner the field offers, from the base he is nearest', async function () {
    const field = fakeField({ offered: ['f-ss', 'offense-r2'], nearestBase: 2 })
    await dropOfferedRunner(field, 'Out', true)
    await dropOfferedRunner(field, 'Safe')
    expect(field.drags).deep.equals([
      [[50, 60], centre(3, 'out')],
      [[50, 60], centre(2, 'safe')]
    ])
  })

  it('aims a home run from the middle of the field to a ground point or a fraction of it', async function () {
    const field = fakeField()
    await aimLandingAt(field, 0, 100)
    await aimLanding(field, 0.5, 0.25)
    const middle: Point = [BOX.x + BOX.width / 2, BOX.y + BOX.height / 2]
    expect(field.drags).deep.equals([
      [middle, [5, 6]],
      [middle, [BOX.x + BOX.width * 0.5, BOX.y + BOX.height * 0.25]]
    ])
  })

  it('places, taps and offers players, and sets the trajectory', async function () {
    const field = fakeField({ offered: ['f-cf'] })
    expect(await playerAt(field, 'SS')).deep.equals([90, 100])
    await placeFielder(field, 'SS', 10, 2)
    await tapFielder(field, 'SS')
    expect(await pointOf(field, 'f-cf')).deep.equals([70, 80])
    await placeOffered(field)
    await tapOffered(field)
    expect(await shownAngle(field)).equals(30)
    await setTrajectory(field)
    await setTrajectory(field, 40)
    expect(field.drags).deep.equals([
      [
        [90, 100],
        [92, 90]
      ],
      [
        [70, 80],
        [70, 68]
      ],
      [
        [210, 320],
        [210, 300]
      ]
    ])
    expect(field.taps).deep.equals([
      [90, 100],
      [70, 80],
      [210, 320]
    ])
  })

  it('names a player not on the field, or the control covering him', async function () {
    this.timeout(10000)
    const gone = await pointOf(fakeField({ point: null }), 'f-cf').catch(
      (caught: unknown) => caught
    )
    expect(String(gone)).contains('Player f-cf is not on the field')
    const covered = await pointOf(fakeField({ point: 'Menu' }), 'f-cf').catch(
      (caught: unknown) => caught
    )
    expect(String(covered)).contains('Player f-cf is covered by "Menu"')
  })

  it('names the angle missing when the summary shows none', async function () {
    const error = await shownAngle(fakeField({ angle: 'no angle' })).catch(
      (caught: unknown) => caught
    )
    expect(String(error)).contains('No trajectory angle shown')
  })

  it('installs the scene probe before the page loads', async function () {
    const scripts: string[] = []
    await installSceneProbe({
      evaluateOnNewDocument: async (script: string) => {
        scripts.push(script)
        return { identifier: '1' }
      }
    } as any)
    expect(scripts).length(1)
    expect(scripts[0]).contains('window.qaRoots = []')
  })
})
