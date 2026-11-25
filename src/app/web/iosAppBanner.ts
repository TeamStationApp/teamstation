declare const TS_API_BASE_URL: string

/** Runs as a classic script in the parsing head, before the web app starts. */
function installAppBanner(): void {
  const page = document as Document & {
    teamStationAppBannerRequested?: true
    teamStationFinishAppBanner?: () => void
  }
  const { userAgent, platform, maxTouchPoints } = navigator
  if (
    window.top !== window ||
    document.readyState !== 'loading' ||
    !(
      /\b(iPhone|iPad)\b/.test(userAgent) ||
      (platform === 'MacIntel' && maxTouchPoints > 1)
    ) ||
    // Branded iOS browsers can append their identity after Safari's product token.
    !/\bVersion\/\S+ (?:Mobile\/\S+ )?Safari\/\d+(?:\.\d+)*$/.test(userAgent) ||
    /\b(Android|iPod|CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|DuckDuckGo|GSA)\b/i.test(
      userAgent
    ) ||
    page.teamStationAppBannerRequested === true ||
    document.querySelector('meta[name="apple-itunes-app"]') != null
  )
    return

  page.teamStationAppBannerRequested = true
  // A parser-inserted stylesheet holds the next classic script. Detaching
  // it on expiry releases the parser even if the connection never responds.
  const linkId = 'teamstation-ios-app-banner-css'
  let expired = false
  const timeout = setTimeout(() => {
    expired = true
    const sheet = document.getElementById(linkId) as HTMLLinkElement | null
    if (sheet != null) {
      sheet.disabled = true
      sheet.remove()
    }
  }, 1500)
  page.teamStationFinishAppBanner = () => {
    delete page.teamStationFinishAppBanner
    clearTimeout(timeout)
    if (expired) return
    const appId = getComputedStyle(document.documentElement)
      .getPropertyValue('--teamstation-ios-app-id')
      .trim()
    if (/^[0-9]+$/.test(appId))
      document.write(`<meta name="apple-itunes-app" content="app-id=${appId}">`)
  }
  const href = (TS_API_BASE_URL.replace(/\/+$/, '') + '/node/ios-app-banner')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
  document.write(`<link rel="stylesheet" id="${linkId}" href="${href}">`)
}

installAppBanner()
