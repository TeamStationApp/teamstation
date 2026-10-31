import { execFileSync } from 'node:child_process'

import { BlockedError } from '../core/result'
import type { Surface } from '../core/spec'
import { FAULTS } from './catalogue'

const STYLES: Record<string, string> = {
  'layout-shift': 'body { transform: translateY(40px); }',
  'hidden-element':
    '[role="button"], [role="tab"], button, a { visibility: hidden !important; }',
  'missing-font': '* { font-family: serif !important; }',
  'blank-screen':
    'html, body { background: #fff !important; } body * { visibility: hidden !important; }'
}

/** A fault the proxy, the process or a fixture stream applies has no style. */
export function styleScript(fault: string): string | undefined {
  const css = STYLES[fault]
  if (css == null) return undefined
  return `(function () {
    if (document.getElementById('e2e-fault')) return
    var style = document.createElement('style')
    style.id = 'e2e-fault'
    style.textContent = ${JSON.stringify(css)}
    document.head.appendChild(style)
  })()`
}

/** Says why this fault cannot run here, instead of reporting a false survivor. */
export function refuseUnreachable(fault: string, surface: Surface): void {
  const entry = FAULTS[fault]
  if (entry == null) throw new Error(`Unknown fault "${fault}"`)
  if (entry.how === 'style' && surface !== 'web-chromium') {
    throw new BlockedError(`${fault} is applied in Chromium, not on ${surface}`)
  }
  if (
    entry.how === 'process' &&
    surface !== 'ios-app' &&
    surface !== 'android-app'
  ) {
    throw new BlockedError(`${fault} needs an app, not ${surface}`)
  }
}

/** Kills the app under test, the way a native crash would. */
export function killApp(
  surface: Surface,
  udid: string,
  appId: string,
  exec: (file: string, args: string[]) => unknown = (file, args) =>
    execFileSync(file, args)
): void {
  if (surface === 'ios-app') {
    exec('xcrun', ['simctl', 'terminate', udid, appId])
  } else {
    exec('adb', ['-s', udid, 'shell', 'am', 'force-stop', appId])
  }
}
