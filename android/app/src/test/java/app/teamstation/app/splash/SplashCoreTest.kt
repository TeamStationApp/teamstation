package app.teamstation.app.splash

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The browser's computed values, written by scripts/splash/buildSplashAssets.mjs. */
private fun samples(): JSONObject {
  var dir: File? = File("").absoluteFile
  while (dir != null && !File(dir, "src/test/fixtures/splashSamples.json").isFile) dir = dir.parentFile
  return JSONObject(File(dir, "src/test/fixtures/splashSamples.json").readText())
}

class SplashSamplerTest {
  @Test
  fun matchesTheBrowserAtEverySample() {
    val all = samples().getJSONObject("samples")
    var rows = 0
    for (size in all.keys()) {
      val list = all.getJSONArray(size)
      for (i in 0 until list.length()) {
        val row = list.getJSONObject(i)
        val f = SplashSampler.frame(row.getDouble("ms"))
        val pairs = listOf(
          Triple("stadium", "scale", f.stadiumScale),
          Triple("stadium", "opacity", f.stadiumOpacity),
          Triple("stadium", "brightness", f.stadiumBrightness),
          Triple("stadium", "contrast", f.stadiumContrast),
          Triple("stadium", "blur", f.stadiumBlur),
          Triple("dark", "opacity", f.darkOpacity),
          Triple("glow", "opacity", f.glowOpacity),
          Triple("glow", "scale", f.glowScale),
          Triple("mark", "opacity", f.markOpacity),
          Triple("mark", "scale", f.markScale),
          Triple("mark", "blur", f.markBlur),
          Triple("wordmark", "opacity", f.wordmarkOpacity),
          Triple("wordmark", "translateY", f.wordmarkTranslateY),
          Triple("wordmark", "scale", f.wordmarkScale),
        )
        for ((layer, prop, ours) in pairs) {
          assertEquals("$size ${row.getDouble("ms")} $layer.$prop", row.getJSONObject(layer).getDouble(prop), ours, 0.002)
        }
        rows++
      }
    }
    assertEquals(4 * 41, rows)
  }

  @Test
  fun eachLayerMakesItsCurveOnce() {
    val layer = SplashTimeline.MARK_TRACKS
    assertTrue(layer.curve === layer.curve)
  }

  @Test
  fun theCurveIsCss() {
    assertEquals(0.3, CubicBezier(0.0, 0.0, 1.0, 1.0)(0.3), 1e-6)
    val ease = CubicBezier(listOf(0.25, 0.1, 0.25, 1.0))
    assertEquals(0.0, ease(0.0), 0.0)
    assertEquals(1.0, ease(1.0), 0.0)
    assertEquals(0.8024, ease(0.5), 1e-3)
    // x = t³ is flat at its start, so Newton's slope vanishes and bisection finds t ≈ ∛progress.
    val t = Math.cbrt(1e-5)
    assertEquals(3 * t * t - 2 * t * t * t, CubicBezier(0.0, 0.0, 0.0, 1.0)(1e-5), 1e-4)
  }

  @Test
  fun eachSegmentIsEasedOnItsOwn() {
    val track = SplashTrack(listOf(0.0 to 0.0, 0.5 to 10.0, 1.0 to 0.0))
    val linear = CubicBezier(0.0, 0.0, 1.0, 1.0)
    assertEquals(5.0, SplashSampler.value(track, linear, 0.25), 1e-6)
    assertEquals(5.0, SplashSampler.value(track, linear, 0.75), 1e-6)
    assertEquals(0.0, SplashSampler.value(track, linear, -1.0), 0.0)
    assertEquals(0.0, SplashSampler.value(track, linear, 2.0), 0.0)
    assertEquals(1.0, SplashSampler.progress(99_999.0), 0.0)
  }
}

class SplashGeometryTest {
  @Test
  fun widerWindowsCropLessOfTheStadium() {
    val phone = SplashGeometry(390.0, 844.0)
    assertEquals(0.252, phone.visibleWidth, 0.001)
    assertEquals(195.0, phone.cover.x + phone.cover.width / 2, 0.01)
    val tv = SplashGeometry(1920.0, 1080.0)
    assertEquals(0.969, tv.visibleWidth, 0.001)
    assertTrue(SplashGeometry(2400.0, 1000.0).visibleHeight < 0.8)
  }

  @Test
  fun theMarkFitsAnyWindow() {
    for ((w, h, side) in listOf(Triple(390.0, 844.0, 210.0), Triple(1194.0, 834.0, 207.5), Triple(834.0, 1194.0, 297.1), Triple(1920.0, 1080.0, 268.7))) {
      assertEquals("${w}x$h", side, SplashGeometry(w, h).side, 0.05)
    }
    val g = SplashGeometry(412.0, 923.0)
    assertEquals(206.0, g.markCenterX, 1e-9)
    assertEquals(923 * 0.45, g.markCenterY, 1e-9)
    assertEquals(SplashBox(-g.side / 2, 0.0, g.side, g.side / 2), g.brand(SplashRect(-0.5, 0.0, 1.0, 0.5)))
  }

  @Test
  fun gradientsReachTheFarthestCorner() {
    val circle = SplashGradient(0.5, 0.45, emptyList())
    assertEquals(Math.sqrt(50.0 * 50 + 55 * 55), circle.radius(100.0, 100.0), 1e-9)
    assertEquals(0x7376c33c, SplashStop(0.0, 0x76c33c, 0.45).argb)
  }
}

class SplashPolicyTest {
  @Test
  fun holdsUntilContentHasAppeared() {
    assertEquals(SplashPolicy.Decision.HOLD, SplashPolicy().decision(2500.0, 2000.0))
  }

  @Test
  fun holdsUntilTheTimelineHasEnded() {
    val policy = SplashPolicy().apply { contentDidAppear() }
    assertEquals(SplashPolicy.Decision.HOLD, policy.decision(300.0, 300.0))
    assertEquals(SplashPolicy.Decision.HOLD, policy.decision(2500.0, null))
    assertEquals(SplashPolicy.Decision.DISMISS, policy.decision(2600.0, 2000.0))
  }

  @Test
  fun theCapCountsFromInstallWithoutContentOrATimeline() {
    assertEquals(SplashPolicy.Decision.DISMISS, SplashPolicy().decision(8000.0, null))
    assertEquals(SplashPolicy.Decision.DISMISS, SplashPolicy().decision(8000.0, 5000.0))
  }

  @Test
  fun aFrozenSplashNeverDismisses() {
    val policy = SplashPolicy(frozen = true).apply { contentDidAppear() }
    assertEquals(SplashPolicy.Decision.HOLD, policy.decision(60_000.0, 60_000.0))
  }
}

class SplashLaunchOptionsTest {
  @Test
  fun readsEveryKindOfNumberIncludingZero() {
    for ((value, ms) in listOf<Pair<Any, Double>>(0 to 0.0, 2 to 2000.0, 0.7f to 700.0, "1.4" to 1400.0)) {
      assertEquals("$value", ms, SplashLaunchOptions.freezeMs({ value }, debug = false, emulator = true)!!, 0.01)
    }
  }

  @Test
  fun isNullWhenMissingOrNotANumber() {
    assertNull(SplashLaunchOptions.freezeMs({ null }, debug = true, emulator = true))
    assertNull(SplashLaunchOptions.freezeMs({ "soon" }, debug = true, emulator = false))
    assertNull(SplashLaunchOptions.freezeMs({ -1 }, debug = true, emulator = false))
    assertNull(SplashLaunchOptions.freezeMs({ listOf(1) }, debug = true, emulator = false))
  }

  @Test
  fun eachConditionAloneHonoursIt() {
    val extras = { 1 }
    assertEquals(1000.0, SplashLaunchOptions.freezeMs(extras, debug = true, emulator = false)!!, 0.0)
    assertEquals(1000.0, SplashLaunchOptions.freezeMs(extras, debug = false, emulator = true)!!, 0.0)
    assertNull(SplashLaunchOptions.freezeMs(extras, debug = false, emulator = false))
  }

  @Test
  fun aReleaseBuildOnAPhoneNeverReadsTheIntent() {
    val read = { throw AssertionError("the extras were read") }
    assertNull(SplashLaunchOptions.freezeMs(read, debug = false, emulator = false))
  }

  @Test
  fun knowsTheEmulator() {
    assertTrue(SplashLaunchOptions.isEmulator("ranchu"))
    assertTrue(SplashLaunchOptions.isEmulator("goldfish"))
    assertTrue(!SplashLaunchOptions.isEmulator("tensor"))
  }
}

class SplashViewMathTest {
  @Test
  fun theMixesFollowTheTracks() {
    assertEquals(0.0, SplashView.dimming(1.05), 0.0)
    assertEquals(0.0, SplashView.dimming(2.0), 0.0)
    assertEquals(0.5, SplashView.stadiumBlurMix(2.0), 0.0)
    assertEquals(1.0, SplashView.brandBlurMix(24.0), 0.0)
    assertEquals(255, SplashView.alpha(1.5))
    assertEquals("412", SplashView.format(412f))
    assertEquals("2.625", SplashView.format(2.625f))
    assertEquals("411.4286", SplashView.format(1080f / 2.625f))
    assertEquals("100.5", SplashView.format(100.5f))
    assertEquals("0.75", SplashView.format(0.75f))
    val default = java.util.Locale.getDefault()
    try {
      java.util.Locale.setDefault(java.util.Locale.GERMANY)
      assertEquals("2.625", SplashView.format(2.625f))
    } finally {
      java.util.Locale.setDefault(default)
    }
  }
}
