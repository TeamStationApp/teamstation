// Only staged on the isolated fixture origin. Safari and Chrome can omit all
// web text from accessibility, so report the browser's cookie check to the
// existing forwarded-request observer. Credentials never enter the report.
;(async () => {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const run = params.get('run')
  const action = params.get('action')
  if (!/^[0-9a-f-]{36}$/.test(run ?? '')) return
  if (action === 'reset') {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
  }
  const response = await fetch('/api/v1/auth/me', { cache: 'no-store' })
  const confirmed =
    action === 'reset'
      ? response.status === 401
      : response.ok && (await response.json()).id === params.get('actor')
  document.querySelector('p').textContent = confirmed
    ? 'Fixture session confirmed'
    : 'Unexpected fixture session'
  await fetch(
    '/api/v1/viewport-session/' + run + '/' + (confirmed ? 'ok' : 'mismatch'),
    {
      method: 'OPTIONS',
      credentials: 'omit',
      cache: 'no-store'
    }
  )
})()
