package app.teamstation.app.chat

import android.content.Intent
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.ViewGroup.LayoutParams
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.teamstation.app.MainActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChatHardwareKeysDeviceTest {
  @Test
  fun activityForwardsPhysicalUpToAnOrdinaryMultilineField() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
      scenario.recreate() // The launch splash owns focus until it closes on a fresh start.
      val laidOut = CountDownLatch(1)
      val received = mutableListOf<Pair<Int, Int>>()
      lateinit var input: EditText
      scenario.onActivity { activity ->
        input = EditText(activity)
        input.setText("First line\nSecond line")
        input.addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
          if (view.width > 0 && view.height > 0) laidOut.countDown()
        }
        input.setOnKeyListener { _, code, event ->
          received.add(code to event.action)
          true
        }
        activity.addContentView(input, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
      }
      assertTrue("Ordinary input received a layout", laidOut.await(10, TimeUnit.SECONDS))
      scenario.onActivity { activity ->
        input.isFocusableInTouchMode = true
        assertTrue(input.requestFocus())
        assertSame(input, activity.currentFocus)

        val up = KeyEvent.KEYCODE_DPAD_UP
        val downTime = SystemClock.uptimeMillis()
        for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
          val event = KeyEvent(downTime, SystemClock.uptimeMillis(), action, up, 0, 0, 3, 0, 0, InputDevice.SOURCE_KEYBOARD)
          assertTrue("Activity handled action $action, observed $received", activity.dispatchKeyEvent(event))
        }
        assertEquals(listOf(up to KeyEvent.ACTION_DOWN, up to KeyEvent.ACTION_UP), received)
      }
    }
  }
}
