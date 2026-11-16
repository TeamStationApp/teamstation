import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import { type E2eContext, specProblems } from '../../core/spec'
import { gapSeek, tvCameras } from './targetedScenarios'
import { defineTargeted } from './targetedSpec'

describe('a targeted scenario as the suite runs it', function () {
  it('is one Chrome surface with a hardware device for each other watcher', function () {
    const spec = defineTargeted({
      behaviour: 'gap-seek',
      scenario: 'paused',
      title: 'A paused seek into a hole',
      minutes: 15,
      covers: ['src/app/player/**'],
      steps: gapSeek,
      judge: () => {}
    })
    expect(specProblems(spec)).deep.equals([])
    expect(spec.id).equals('streaming/targeted/gap-seek')
    expect(spec.minutes).equals(15)
    expect(spec.stack).equals('isolated')
    expect(spec.exclusive).equals(true)
    expect(Object.keys(spec.surfaces)).deep.equals(['web-chromium'])
    expect(spec.surfaces['web-chromium']!.devices).deep.equals([
      { role: 'iphone', needs: ['ios-phone'], hardware: 'required' },
      { role: 'android', needs: ['android-phone'], hardware: 'required' },
      { role: 'ipad', needs: ['ipad'], hardware: 'required' }
    ])
    expect(Object.keys(spec.scenarios)).deep.equals(['paused'])
  })

  it('needs an Apple TV for the TV, and runs the scenario on the attached stack', async function () {
    const judged: unknown[] = []
    const spec = defineTargeted({
      behaviour: 'tv',
      scenario: 'four-cameras',
      title: 'The TV with four cameras',
      minutes: 20,
      covers: ['src/app/tv/**'],
      steps: tvCameras,
      judge: outcome => {
        judged.push(outcome)
      }
    })
    expect(spec.surfaces['web-chromium']!.devices).deep.equals([
      { role: 'tv', needs: ['apple-tv'], hardware: 'required' }
    ])
    // Without an attached stack the runner's world blocks the run at once.
    const error = await spec.scenarios['four-cameras']({
      stack: {}
    } as unknown as E2eContext).then(
      () => undefined,
      (reason: unknown) => reason as Error
    )
    expect(error).instanceOf(BlockedError)
    expect(error!.message).contains('needs a stack')
    // A run that never got going is not judged.
    expect(judged).deep.equals([])
  })
})
