package app.teamstation.cameraman

import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.harness.LaunchConfiguration
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.streamcore.core.StreamSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Broadcasting starts the listener with the shared library's adaptive bitrate loop behind it, set
 * from the operator's settings, and stopping takes the loop down with the listener.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BroadcastBitrateEnvironmentTest {
    @Test
    fun `broadcasting runs the adaptive bitrate loop and stopping ends it`() {
        val environment = AppEnvironment(
            context = RuntimeEnvironment.getApplication(),
            launch = LaunchConfiguration(advertise = false, persistSettings = false),
            store = InMemoryIdentityStore(),
            settingsStore = InMemorySettingsStore()
        )
        try {
            assertTrue(environment.stateDump().isNull("adaptiveBitrate"))

            environment.setBroadcasting(true)
            val loop = environment.stateDump().getJSONObject("adaptiveBitrate")
            assertEquals(StreamSettings().bitrate, loop.getJSONObject("controller").getInt("ceiling"))

            environment.setBroadcasting(false)
            assertTrue(environment.stateDump().isNull("adaptiveBitrate"))
        } finally {
            environment.setBroadcasting(false)
            environment.camera.close()
        }
    }
}
