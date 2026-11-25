// Handle password links before the app initializes navigation and telemetry.
async function boot(): Promise<void> {
  if (window.location.pathname === '/password-login') {
    const credentials = new URLSearchParams(window.location.hash.slice(1))
    window.history.replaceState(null, '', '/sign-in')
    const { openPasswordLogin } = await import('./passwordLogin')
    await openPasswordLogin(credentials)
  } else {
    await import('./index')
  }
}

boot().catch(() => {
  document.getElementById('root')!.textContent =
    'TeamStation could not start. Reload to try again.'
})
