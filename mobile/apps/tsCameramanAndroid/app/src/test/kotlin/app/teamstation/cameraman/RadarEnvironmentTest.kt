package app.teamstation.cameraman

import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.harness.ControlCommand
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.streamcore.radar.PreferencesRadarFleetStore
import app.teamstation.streamcore.radar.RadarPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Cameraman's single radar goes through the fleet with a limit of one: the card's actions, the
 * uiTest radar commands and the state dump behave as they did with one link, under the same keys.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RadarEnvironmentTest {
    private val context = RuntimeEnvironment.getApplication()
    private val preferences = context.getSharedPreferences(PreferencesRadarFleetStore.CAMERAMAN_FILE, 0)

    @Test
    fun `pairing, the switch and unpairing write Cameraman's keys`() {
        val environment = AppEnvironment(
            context = context,
            store = InMemoryIdentityStore(),
            settingsStore = InMemorySettingsStore()
        )
        try {
            environment.openRadarPicker()
            assertTrue(environment.radarState.value.pickerOpen)
            environment.pairRadar("nope")
            assertTrue(environment.radarState.value.pickerOpen)
            environment.pairRadar("ADFA0000001")
            assertFalse(environment.radarState.value.pickerOpen)
            assertEquals("ADFA0000001", environment.radarState.value.serial)
            assertEquals("ADFA0000001", preferences.getString("serial", null))

            environment.openRadarPicker()
            environment.dismissRadarPicker()
            assertFalse(environment.radarState.value.pickerOpen)

            environment.setRadarEnabled(false)
            assertFalse(preferences.getBoolean("enabled", true))
            assertFalse(environment.radarState.value.enabled)
            environment.setRadarEnabled(true)
            assertTrue(preferences.getBoolean("enabled", false))

            environment.unpairRadar()
            assertNull(environment.radarState.value.serial)
            assertFalse(preferences.contains("serial"))
        } finally {
            environment.camera.close()
        }
    }

    @Test
    fun `the uiTest radar commands show, feed and unpair the one radar`() {
        val environment = AppEnvironment(
            context = context,
            store = InMemoryIdentityStore(),
            settingsStore = InMemorySettingsStore()
        )
        try {
            environment.handle(ControlCommand.RadarShow("ADFA0000001", RadarPhase.connecting, 0))
            environment.setRadarStep(2)
            assertEquals(0, environment.radarState.value.connectingStep)
            environment.handle(ControlCommand.RadarShow("ADFA0000001", RadarPhase.connected, 0))
            environment.handle(ControlCommand.RadarFeed(50, 60, 1_000_000))
            val dump = environment.stateDump()
            assertEquals("ADFA0000001", dump.getString("radarSerial"))
            assertEquals("connected", dump.getString("radarPhase"))
            assertEquals("50/60", dump.getString("radarSpeeds"))
            assertTrue(dump.getBoolean("radarLinkSuppressed"))
            assertFalse("a shown radar is not paired", preferences.contains("serial"))

            environment.handle(ControlCommand.RadarUnpair)
            assertTrue(environment.stateDump().isNull("radarSerial"))
        } finally {
            environment.camera.close()
        }
    }
}
