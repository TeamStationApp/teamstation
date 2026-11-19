package app.teamstation.speedy

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ActivityTest {
    private val app = RuntimeEnvironment.getApplication()
    private val all = arrayOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION
    )

    @Before
    fun fresh() = SpeedyEnvironment.forget()

    @After
    fun forget() = SpeedyEnvironment.forget()

    private fun launch(uiTest: Boolean): ActivityScenario<MainActivity> {
        val intent = Intent(app, MainActivity::class.java)
        if (uiTest) intent.putExtra(MainActivity.UI_TEST, "true")
        return ActivityScenario.launch(intent)
    }

    @Test
    fun `the screen is kept on and the activity is portrait, single task`() {
        shadowOf(app).grantPermissions(*all)
        launch(uiTest = false).use { scenario ->
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
                val info = activity.packageManager.getActivityInfo(activity.componentName, 0)
                assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, info.screenOrientation)
                assertEquals(ActivityInfo.LAUNCH_SINGLE_TASK, info.launchMode)
                assertEquals("app.teamstation.speedy", activity.packageName)
                assertTrue(activity.environment.radar.fleet.enabled.value)
            }
        }
    }

    @Test
    fun `the manifest asks for all four permissions`() {
        val info = app.packageManager.getPackageInfo(app.packageName, android.content.pm.PackageManager.GET_PERMISSIONS)
        assertTrue(info.requestedPermissions!!.toSet().containsAll(all.toList()))
    }

    @Test
    fun `without permissions it asks for all four, and the answer starts the radar`() {
        launch(uiTest = false).use { scenario ->
            scenario.onActivity { activity ->
                val request = shadowOf(activity).lastRequestedPermission
                assertEquals(all.toSet(), request.requestedPermissions.toSet())
                activity.onPermissionResult()
                activity.onPermissionResult()
                assertTrue(activity.environment.radar.fleet.enabled.value)
                activity.askForPermissions()
            }
        }
    }

    @Test
    fun `a UI-test launch takes links, a normal one does not`() {
        shadowOf(app).grantPermissions(*all)
        launch(uiTest = true).use { scenario ->
            scenario.onActivity { activity ->
                activity.onNewIntent(Intent(Intent.ACTION_VIEW, Uri.parse("tsspeedy://test/radar-feed?pitch=56&exit=52")))
                assertEquals("56", activity.environment.model.pitchText(activity.environment.model.now))
                activity.onNewIntent(Intent(Intent.ACTION_MAIN))
            }
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED)
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        }
        SpeedyEnvironment.forget()
        launch(uiTest = false).use { scenario ->
            scenario.onActivity { activity ->
                activity.onNewIntent(Intent(Intent.ACTION_VIEW, Uri.parse("tsspeedy://test/radar-feed?pitch=56&exit=52")))
                assertEquals("--", activity.environment.model.pitchText(activity.environment.model.now))
            }
        }
    }

    @Test
    fun `the main scheduler runs work after its delay, unless cancelled`() {
        val scheduler = MainScheduler()
        val ran = mutableListOf<String>()
        scheduler.after(250) { ran += "kept" }
        scheduler.after(250) { ran += "cancelled" }.cancel()
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(300))
        assertEquals(listOf("kept"), ran)
    }
}
