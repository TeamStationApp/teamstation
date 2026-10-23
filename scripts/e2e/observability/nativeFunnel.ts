import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

/** Exercise shipped native forms; clipboard bytes never enter driver logs. */
export async function nativeFunnel(
  m: any,
  device: string,
  origin: string,
  fixtures: any
): Promise<void> {
  const started = new Date().toISOString()
  const email = 'observability-signup-' + Date.now() + '@example.test'
  const clipboard = (value: string): void => {
    const writer = process.env.OBSERVABILITY_CLIPBOARD_WRITER
    const result =
      writer == null
        ? spawnSync('xcrun', ['simctl', 'pbcopy', device], { input: value })
        : spawnSync(writer, [], { input: value })
    assert.equal(result.status, 0, 'Private clipboard setup failed')
  }
  const paste = async (label: string, value: string): Promise<void> => {
    await m.tapOn({ text: label })
    await m.waitForAnimationToEnd({ timeout: 5000 })
    clipboard(value)
    try {
      await m.longPressOn({ text: label })
      if (process.env.OBSERVABILITY_CLIPBOARD_WRITER == null) {
        await m.tapOn({ text: 'Paste' })
      } else {
        // Android's floating selection menu can be misclassified as keyboard-covered.
        const findPaste = (node: any): any =>
          node.text === 'Paste'
            ? node
            : (node.children ?? []).map(findPaste).find(Boolean)
        let bounds
        for (let attempt = 0; attempt < 3 && bounds == null; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 300))
          bounds = findPaste(await m.hierarchy())?.bounds
          if (bounds == null) await m.longPressOn({ text: label })
        }
        assert(bounds != null, 'Visible Paste selection action required')
        await m.tapOn({
          point: `${bounds.x + bounds.width / 2},${bounds.y + bounds.height / 2}`
        })
      }
    } finally {
      clipboard('')
    }
    await m.hideKeyboard()
  }
  const signOut = async (): Promise<void> => {
    await m.tapOn({ text: 'Close', optional: true })
    await m.tapOn({ text: 'Account, Observability.*' })
    await m.scrollUntilVisible({
      element: { text: 'Sign out' },
      direction: 'DOWN',
      visibilityPercentage: 100,
      centerElement: true
    })
    // Keep the action clear of the floating tab bar before tapping it.
    await m.swipe({ start: '50%,80%', end: '50%,40%', duration: 500 })
    await m.waitForAnimationToEnd({ timeout: 5000 })
    await m.tapOn({ text: 'Sign out' })
    await m.assertVisible({ text: 'E-mail address' })
  }
  const signedIn = (node: any): boolean =>
    String(node.text ?? '').startsWith('Account, Observability') ||
    Boolean((node.children ?? []).some(signedIn))
  if (signedIn(await m.hierarchy())) await signOut()
  await paste('E-mail address', email)
  await m.tapOn({
    text: 'Send me a sign-in code',
    optional: true,
    timeout: 1000
  })
  await m.assertVisible({ text: '^Sign-in code$', timeout: 15000 })
  const { stdout } = await promisify(execFile)(
    process.env.OBSERVABILITY_MAIL_READER!,
    [],
    {
      env: { ...process.env, OBSERVABILITY_MAIL_ADDRESS: email },
      timeout: 30000
    }
  )
  const code = stdout.trim()
  assert(/^\d{6}$/.test(code))
  await paste('Sign-in code', code)
  await m.tapOn({ text: 'Sign in', optional: true })
  await m.assertVisible({ text: 'What is your name?', timeout: 15000 })
  await paste('Name', 'Observability signup')
  await m.tapOn({ text: 'Continue', optional: true })
  await m.assertVisible({ text: 'Choose your photo' })
  await m.tapOn({ text: 'Use my initials' })
  await m.assertVisible({
    text: 'Account, Observability signup',
    timeout: 15000
  })
  assert(fixtures.joinTeam != null, 'Owned discovery fixture required')
  await m.openLink({ link: 'teamstation://discover' })
  await m.tapOn({ text: '^Teams$' })
  await paste('Search by name or city', fixtures.joinTeam.name)
  await m.tapOn({ text: 'Open ' + fixtures.joinTeam.name, timeout: 15000 })
  await m.tapOn({ text: 'Follow ' + fixtures.joinTeam.name })
  await m.assertVisible({ text: 'Unfollow ' + fixtures.joinTeam.name })
  if (process.env.TS_ANDROID_DEVICE != null) await m.pressKey({ key: 'BACK' })
  else await m.tapOn({ text: '^Back$' })
  await signOut()
  const second = fixtures.accounts.find((a: any) => a.role === 'second')
  await paste('E-mail address', second.email)
  await m.tapOn({ text: 'Use a password instead' })
  await paste('Password', second.password)
  await m.tapOn({ text: 'Sign in', optional: true })
  await m.assertVisible({
    text: 'Account, Observability second',
    timeout: 15000
  })
  await new Promise(resolve => setTimeout(resolve, 5500))
  const admin = fixtures.accounts.find((a: any) => a.role === 'admin')
  const response = await fetch(origin + '/api/v1/admin/analytics/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + admin.token
    },
    body: JSON.stringify({
      sql: 'SELECT event_name, properties, user_id FROM analytics.events WHERE occurred_at >= $1 AND app = $2 ORDER BY occurred_at',
      parameters: [started, 'TS']
    })
  })
  assert.equal(response.status, 200)
  const rows: any[] = (await response.json()).rows
  for (const event of [
    'signup_started',
    'signup_step_completed',
    'account_created',
    'onboarding_completed',
    'page_viewed',
    'search_submitted',
    'follow_changed',
    'logout',
    'login_succeeded'
  ])
    assert(
      rows.some(row => row.event_name === event),
      'Missing ' + event
    )
  const created = rows.find(row => row.event_name === 'account_created')
  assert(
    created.user_id != null &&
      created.user_id !== second.id &&
      created.user_id !== admin.id
  )
  assert(
    rows.some(
      row =>
        row.event_name === 'onboarding_completed' &&
        row.user_id === created.user_id
    )
  )
  assert(
    rows.some(
      row => row.event_name === 'login_succeeded' && row.user_id === second.id
    )
  )
  for (const secret of [
    email,
    code,
    second.email,
    second.password,
    'Observability signup'
  ])
    assert(
      !JSON.stringify(rows).includes(secret),
      'Private form value reached analytics'
    )
  console.log(
    'native: real signup, onboarding, navigation/search/follow/back, logout and second-account login; correct actors and no form values'
  )
}
