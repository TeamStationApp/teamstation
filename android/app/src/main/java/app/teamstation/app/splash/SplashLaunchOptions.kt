package app.teamstation.app.splash

/**
 * The test hook: the intent extra `TSSplashFreezeAt` (seconds) draws that moment and holds it.
 * Honoured only in a debug build or on an emulator. On a phone any app or web page can start the
 * activity with extras, and a frozen splash has no cap, so a release build there never reads it.
 */
object SplashLaunchOptions {
  const val KEY = "TSSplashFreezeAt"

  /**
   * The frozen time in milliseconds, or null. [extra] reads the launch intent's [KEY] extra, and
   * is called only where the hook is honoured. maestro-d sends a whole number as an Int extra and a
   * fraction as a Float, so any Number or numeric String is read; `0` is frame 0.
   */
  fun freezeMs(extra: () -> Any?, debug: Boolean, emulator: Boolean): Double? {
    if (!(debug || emulator)) return null
    val seconds = when (val value = extra()) {
      is Number -> value.toDouble()
      is String -> value.trim().toDoubleOrNull()
      else -> null
    }
    if (seconds == null || !seconds.isFinite() || seconds < 0) return null
    return seconds * 1000
  }

  /** Whether [hardware] (Build.HARDWARE) is the Android emulator's. */
  fun isEmulator(hardware: String): Boolean = hardware == "ranchu" || hardware == "goldfish"
}
