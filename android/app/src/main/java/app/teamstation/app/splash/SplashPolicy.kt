package app.teamstation.app.splash

/**
 * When the splash leaves: once the timeline has ended and React Native has drawn its first content,
 * or at the cap after install, whatever state React Native or the image decode is in. A frozen
 * splash (the test hook) never leaves.
 */
class SplashPolicy(val frozen: Boolean = false) {
  enum class Decision { HOLD, DISMISS }

  var contentAppeared = false
    private set

  fun contentDidAppear() {
    contentAppeared = true
  }

  /** What to do [sinceInstallMs] after the splash went up, [timelineMs] into its timeline (null until it has started). */
  fun decision(sinceInstallMs: Double, timelineMs: Double?): Decision = when {
    frozen -> Decision.HOLD
    sinceInstallMs >= SplashTimeline.CAP_MS -> Decision.DISMISS
    timelineMs != null && timelineMs >= SplashTimeline.DURATION_MS && contentAppeared -> Decision.DISMISS
    else -> Decision.HOLD
  }
}
