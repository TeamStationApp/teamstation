package app.teamstation.app.splash

import android.content.Intent
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.teamstation.app.MainActivity
import app.teamstation.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** MainActivity puts the splash up on a fresh start only, reading the freeze hook from its intent. */
@RunWith(AndroidJUnit4::class)
class MainActivitySplashTest {
  @Test
  fun aFreshStartFreezesFromItsIntentAndARecreationShowsNoSplash() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val intent = Intent(context, MainActivity::class.java).putExtra(SplashLaunchOptions.KEY, 0.7f)
    ActivityScenario.launch<MainActivity>(intent).use { scenario ->
      scenario.onActivity { activity ->
        val splash = activity.splash
        assertNotNull(splash)
        assertEquals(700.0, splash!!.view.frozenMs!!, 0.01)
        assertTrue(splash.dialog.isShowing)
      }
      scenario.recreate()
      scenario.onActivity { activity ->
        assertNull("a recreated activity has no splash", activity.splash)
      }
    }
  }
}
