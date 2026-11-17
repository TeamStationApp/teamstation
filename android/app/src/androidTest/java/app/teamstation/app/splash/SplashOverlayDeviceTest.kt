package app.teamstation.app.splash

import android.view.View
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.teamstation.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The splash over a real activity whose content stands in for React Native's root. */
@RunWith(AndroidJUnit4::class)
class SplashOverlayDeviceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  private fun <T> onMain(block: () -> T): T {
    var result: T? = null
    instrumentation.runOnMainSync { result = block() }
    @Suppress("UNCHECKED_CAST")
    return result as T
  }

  private fun waitFor(timeoutMs: Long, condition: () -> Boolean): Boolean {
    val until = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < until) {
      if (onMain(condition)) return true
      Thread.sleep(50)
    }
    return onMain(condition)
  }

  @Test
  fun itCoversTheRootUntilContentAppearsAndTheTimelineEnds() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val overlay = onMain { SplashOverlay.install(host, frozenMs = null) }
      onMain {
        assertTrue(overlay.dialog.isShowing)
        assertEquals(R.id.tsSplash, overlay.view.id)
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, host.root.importantForAccessibility)
        assertTrue(overlay.view.contentDescription.startsWith("TeamStation, loading "))
      }
      assertTrue("the stadium decodes and the timeline starts", waitFor(10_000) { overlay.view.startedAt != null })
      onMain { host.root.addView(TextView(host).apply { text = "React Native" }) }
      assertTrue(waitFor(2_000) { overlay.view.contentDescription.startsWith("TeamStation, ready ") })
      assertFalse("the timeline has not ended", onMain { overlay.dismissed } && overlay.view.elapsedMs() < 2000)
      assertTrue(waitFor(5_000) { !overlay.dialog.isShowing })
      onMain {
        assertTrue(overlay.dismissed)
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, host.root.importantForAccessibility)
      }
    }
  }

  @Test
  fun aFrozenSplashHoldsItsFrame() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val overlay = onMain { SplashOverlay.install(host, frozenMs = 700.0) }
      assertTrue(waitFor(10_000) { overlay.view.startedAt != null })
      onMain {
        host.root.addView(TextView(host))
        overlay.view.invalidate()
      }
      Thread.sleep(2_500)
      onMain {
        assertEquals(700.0, overlay.view.currentMs, 0.0)
        assertFalse(overlay.dismissed)
        assertTrue(overlay.dialog.isShowing)
        overlay.dismiss(animated = false)
        assertFalse(overlay.dialog.isShowing)
      }
    }
  }

  @Test
  fun itsWindowKeepsTheStatusBarLightAndLeavesReactNativesAlone() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val activityBars = onMain { androidx.core.view.WindowCompat.getInsetsController(host.window, host.window.decorView) }
      val overlay = onMain { SplashOverlay.install(host, frozenMs = 0.0) }
      onMain {
        val window = overlay.dialog.window!!
        val splashBars = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
        assertFalse("light icons over the splash", splashBars.isAppearanceLightStatusBars)
        // React Native asks for dark icons, then light, on its own window meanwhile.
        activityBars.isAppearanceLightStatusBars = true
        activityBars.isAppearanceLightStatusBars = false
        assertFalse(splashBars.isAppearanceLightStatusBars)
        overlay.dismiss(animated = false)
        assertFalse("React Native's last request stands", activityBars.isAppearanceLightStatusBars)
      }
    }
  }

  @Test
  fun destroyingItMidFadeClosesItsWindowAndNothingFiresAfter() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val overlay = onMain { SplashOverlay.install(host, frozenMs = 0.0) }
      onMain {
        overlay.dismiss()
        assertTrue("the fade is under way", overlay.dialog.isShowing)
        overlay.destroy()
        assertFalse(overlay.dialog.isShowing)
      }
      // Past the fade's end: its end action must not run.
      Thread.sleep((SplashTimeline.FADE_MS * 2).toLong())
      scenario.recreate()
      onMain { assertFalse(overlay.dialog.isShowing) }
    }
  }

  @Test
  fun thePlaceholderIsFrameZeroAsItIsWithNoSecondDarkLayer() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      onMain {
        val view = SplashView(host, frozenMs = 0.0)
        view.measure(View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, 200, 200)
        val gray = 0xff808080.toInt()
        view.showPlaceholder(android.graphics.Bitmap.createBitmap(20, 20, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(gray) })
        assertFalse(view.showsStadium)
        val drawn = android.graphics.Bitmap.createBitmap(200, 200, android.graphics.Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(drawn))
        // The vignette is clear at the centre and the brand has not appeared.
        assertEquals(Integer.toHexString(gray), Integer.toHexString(drawn.getPixel(100, 100)))
      }
    }
  }

  @Test
  fun releasingItLetsGoOfItsImagesAndDropsALateDecode() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val overlay = onMain { SplashOverlay.install(host, frozenMs = null) }
      var closed = 0
      onMain {
        overlay.onClosed = { closed++ }
        overlay.dismiss(animated = false)
      }
      Thread.sleep(3_000)
      onMain {
        assertEquals(1, closed)
        assertNull("the decode finished after the release and was dropped", overlay.view.startedAt)
        assertFalse(overlay.view.showsStadium)
      }
    }
  }

  @Test
  fun itShowsFrameZeroTheMomentItStarts() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      onMain {
        val view = SplashView(host, frozenMs = null)
        view.start {}
        // Before the main thread has run anything else, so before the splash first draws.
        assertTrue(view.showsPlaceholder)
        view.release()
      }
    }
  }

  @Test
  fun anImageThatFailsToDecodeLeavesFrameZeroAndStillStarts() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val view = onMain { SplashView(host, frozenMs = null) }
      val decode = view.decoder
      view.decoder = { if (it == R.drawable.splash_stadium) throw OutOfMemoryError("test") else decode(it) }
      var started = false
      onMain { view.start { started = true } }
      assertTrue(waitFor(10_000) { started })
      onMain {
        assertNotNull(view.startedAt)
        assertFalse(view.showsStadium)
        assertTrue("frame 0 stays under the brand", view.showsPlaceholder)
        view.release()
      }
    }
  }

  @Test
  fun aDecodeThatNeverFinishesStillLeavesAtTheCap() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val gate = java.util.concurrent.CountDownLatch(1)
      val overlay = onMain {
        SplashOverlay.install(host, frozenMs = null) { view ->
          val decode = view.decoder
          view.decoder = { if (it == R.drawable.splash_launch_frame) decode(it) else { gate.await(); null } }
        }
      }
      try {
        assertTrue(waitFor((SplashTimeline.CAP_MS + 4_000).toLong()) { overlay.dismissed })
      } finally {
        gate.countDown()
      }
    }
  }

  @Test
  fun theBrandStaysOpaqueThroughItsBlur() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      onMain {
        val view = SplashView(host, frozenMs = 0.0)
        fun solid(color: Int) = android.graphics.Bitmap.createBitmap(8, 8, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        for (blur in listOf(0.0, 0.25, 0.5, 0.75, 1.0)) {
          val layer = android.graphics.Bitmap.createBitmap(8, 8, android.graphics.Bitmap.Config.ARGB_8888)
          view.crossFade(android.graphics.Canvas(layer), solid(0xffffffff.toInt()), solid(0xff76c33c.toInt()), android.graphics.RectF(0f, 0f, 8f, 8f), blur)
          val pixel = layer.getPixel(4, 4)
          assertTrue("alpha ${android.graphics.Color.alpha(pixel)} at blur $blur", android.graphics.Color.alpha(pixel) >= 254)
        }
      }
    }
  }

  @Test
  fun itPlaysByTheClockWhateverTheAnimatorScale() {
    val shell = instrumentation.uiAutomation
    fun run(command: String) = shell.executeShellCommand(command).close()
    run("settings put global animator_duration_scale 0")
    try {
      ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
        lateinit var host: SplashHostActivity
        scenario.onActivity { host = it }
        val overlay = onMain { SplashOverlay.install(host, frozenMs = null) }
        assertTrue(waitFor(10_000) { overlay.view.startedAt != null })
        Thread.sleep(700)
        onMain {
          val elapsed = overlay.view.elapsedMs()
          assertTrue("drawn at ${overlay.view.currentMs} ms of $elapsed", overlay.view.currentMs in 300.0..(elapsed + 1))
          assertTrue(overlay.view.currentMs < SplashTimeline.DURATION_MS)
          overlay.dismiss(animated = false)
        }
      }
    } finally {
      run("settings put global animator_duration_scale 1")
    }
  }

  @Test
  fun itTakesTouchesAndStopsWhenDismissed() {
    ActivityScenario.launch(SplashHostActivity::class.java).use { scenario ->
      lateinit var host: SplashHostActivity
      scenario.onActivity { host = it }
      val overlay = onMain { SplashOverlay.install(host, frozenMs = null) }
      onMain {
        val down = android.view.MotionEvent.obtain(0, 0, android.view.MotionEvent.ACTION_DOWN, 1f, 1f, 0)
        assertTrue(overlay.view.onTouchEvent(down))
        down.recycle()
        overlay.dismiss(animated = false)
        overlay.dismiss(animated = false)
        assertTrue(overlay.dismissed)
      }
    }
  }
}
