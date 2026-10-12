package app.teamstation.cameraman

import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.eventcontrol.EventControlHost
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

/**
 * The app wires event control to its scoreboard and its settings, reports it in the state dump
 * without the key, and a signed-out camera has nothing listening.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventControlEnvironmentTest {
    @Test
    fun `event control is wired, off by default, and in the dump without the key`() {
        val settings = InMemorySettingsStore()
        val environment = AppEnvironment(
            context = RuntimeEnvironment.getApplication(),
            store = InMemoryIdentityStore(),
            settingsStore = settings
        )
        try {
            assertFalse(environment.scoreboard.state.value.allowOverride)
            assertFalse(environment.scoreboard.state.value.overrideToggleEnabled)
            environment.scoreboard.setAllowOverride(true)
            ShadowLooper.idleMainLooper()
            assertEquals("1", settings.string(EventControlHost.KEY_CONSENT))
            assertTrue(environment.scoreboard.state.value.allowOverride)

            val json = environment.eventControlJSON()
            assertEquals(true, json.getBoolean("allowOverride"))
            assertEquals(false, json.getBoolean("eligible"))
            assertTrue(json.isNull("port"))
            assertTrue(json.isNull("overrideFrom"))
            assertEquals(setOf("allowOverride", "eligible", "port", "overrideFrom", "status"), json.keys().asSequence().toSet())
            val dump: JSONObject = environment.stateDump()
            assertEquals(json.toString(), dump.getJSONObject("eventControl").toString())
        } finally {
            environment.camera.close()
        }
    }
}
