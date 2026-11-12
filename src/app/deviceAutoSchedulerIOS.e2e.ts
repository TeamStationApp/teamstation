// Focused iPad simulator check, against synthetic E7 fixtures.
import { writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { join } from 'node:path'

import { expect } from 'chai'

import type { SeasonScheduleSettings } from '../common/seasonScheduling'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  autoSchedulerFixture,
  seedThrough
} from '../test/autoSchedulerFixture'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { maestro } from '../test/refinementsMaestro.e2e'

async function main(): Promise<void> {
  const device = process.env.TS_AUTO_SCHEDULER_IOS_DEVICE
  const dir = process.env.TS_AUTO_SCHEDULER_ARTIFACTS
  const port = Number(process.env.TS_AUTO_SCHEDULER_IOS_PORT)
  if (device == null || dir == null || !Number.isInteger(port) || port < 1)
    throw new Error('Supply the task simulator and artifacts directory')
  const places = await googlePlacesStub()
  const fx = await autoSchedulerFixture(undefined, {
    cityLookup: googlePlaces({ apiKey: 'test', baseUrl: places.baseUrl })
  })
  await seedThrough(fx, 'E7')
  const fixtureOrigin = new URL(fx.f.h.origin)
  const proxy = createServer((req, res) => {
    const path = req.url ?? '/'
    if (!path.startsWith('/') || path.startsWith('//')) {
      res.writeHead(400)
      res.end()
      return
    }
    const outgoing = request(
      {
        hostname: fixtureOrigin.hostname,
        port: fixtureOrigin.port,
        path,
        method: req.method,
        headers: { ...req.headers, host: fixtureOrigin.host }
      },
      reply => {
        res.writeHead(reply.statusCode ?? 500, reply.headers)
        reply.pipe(res)
      }
    )
    outgoing.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(outgoing)
  })
  await new Promise<void>(resolve => {
    proxy.listen(port, '0.0.0.0', resolve)
  })
  const daemon = await maestro('deviceAutoSchedulerIOS')
  const m = await daemon.attach({
    device,
    platform: 'ios',
    appId: 'app.teamstation.app',
    artifacts: 'on-failure',
    driverStartTimeout: 300
  })
  const tap = async (text: string): Promise<void> => {
    console.log(`tap ${text}`)
    await m.tapOn({ text, timeout: 20000 })
    await m.waitForAnimationToEnd()
  }
  const visible = async (text: string): Promise<void> => {
    await m.assertVisible({ text, timeout: 30000 })
  }
  const capture = async (name: string): Promise<void> => {
    await writeFile(join(dir, name), await m.screenshot())
  }
  try {
    await m.launchApp({
      appId: 'app.teamstation.app',
      stopApp: true,
      clearState: false
    })
    await visible('E-mail address')
    await tap('E-mail address')
    await m.inputText({ text: 'alex@example.com' })
    await tap('Send me a sign-in code')
    await visible('.*six-digit code.*')
    await tap('Sign-in code')
    await m.inputText({ text: fx.f.h.mail.get('alex@example.com')! })
    await m.pressKey({ key: 'Enter' })
    await visible('Your Home')
    await m.openLink({
      link: `teamstation://groups/league/${fx.f.leagueA}/scheduler/seasons/${fx.f.seasonA}`
    })
    await visible('Max games on weekdays: 200')
    await capture('constraints-ios-after.png')
    await tap('Max games on weekdays: 200')
    await m.inputText({ text: '2' })
    await capture('constraints-ios-keyboard.png')
    await m.hideKeyboard()
    await tap('Max games on weekend: 200')
    await m.hideKeyboard()
    await visible('Max games on weekdays: 2')
    const settings = await api<SeasonScheduleSettings>(
      fx,
      101,
      'GET',
      `/seasons/${fx.f.seasonA}/schedule-settings`
    )
    expect(settings.settings.maxGamesOnWeekdays).equals(2)
    await m.scrollUntilVisible({
      element: { text: 'Add another time window' },
      centerElement: true,
      timeout: 20000
    })
    await tap('Add another time window')
    await visible('Use date')
    await tap('Choose 2027-06-02')
    await capture('constraints-ios-date.png')
    await tap('Use date')
    await visible('Remove Windows from Wednesday, June 2, 2027')
    await visible('Season Scheduling Constraints')
    await capture('constraints-ios-header.png')
    const after = await api<SeasonScheduleSettings>(
      fx,
      101,
      'GET',
      `/seasons/${fx.f.seasonA}/schedule-settings`
    )
    expect(after.settings.windows.length).greaterThan(
      settings.settings.windows.length
    )
    await writeFile(
      join(dir, 'native-constraints.log'),
      '$ node -r sucrase/register src/app/deviceAutoSchedulerIOS.e2e.ts\nPASS iPad constraints numeric keyboard, selected replacement, saved date period, and title handoff.\n'
    )
  } catch (error) {
    await capture('support/native-failure.png')
    await writeFile(
      join(dir, 'support/native-hierarchy.json'),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
    throw error
  } finally {
    await daemon.shutdown()
    proxy.closeAllConnections()
    await new Promise<void>(resolve => {
      proxy.close(() => {
        resolve()
      })
    })
    await fx.f.h.close()
    await places.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
