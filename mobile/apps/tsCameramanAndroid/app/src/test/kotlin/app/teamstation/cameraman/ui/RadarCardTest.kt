package app.teamstation.cameraman.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import app.teamstation.cameraman.radar.RadarPhase
import app.teamstation.cameraman.radar.RadarUiState
import app.teamstation.cameraman.radar.SpeedBoard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import app.teamstation.cameraman.radar.PreferencesRadarPairingStore
import app.teamstation.cameraman.radar.systemRadarRadio

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RadarCardTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun `unpaired settings offer pair, and the picker lists a radar or says none are in range`() {
        val state = mutableStateOf(RadarUiState())
        rule.setContent {
            app.teamstation.cameraman.ui.theme.CameramanTheme {
                RadarSettingsCard(
                    state = state.value,
                    onPair = {},
                    onUnpair = {},
                    onChoose = {},
                    onDismiss = {}
                )
            }
        }
        rule.onNodeWithTag("settings-radar-pair").assertExists()

        state.value = RadarUiState(pickerOpen = true)
        rule.onNodeWithText("No radars in range").assertExists()

        state.value = RadarUiState(pickerOpen = true, pickerNames = listOf("ADFAA003519"))
        rule.onNodeWithTag("settings-radar-option-ADFAA003519").assertExists()
    }

    @Test
    fun `a connected card shows the serial, the green word, and unpair`() {
        val state = RadarUiState(
            serial = "ADFAA003519",
            phase = RadarPhase.connected,
            board = SpeedBoard().receive(50, 60, 0)
        )
        rule.setContent {
            app.teamstation.cameraman.ui.theme.CameramanTheme {
                RadarSettingsCard(state, {}, {}, {}, {})
            }
        }
        rule.onNodeWithTag("settings-radar-serial").assertExists()
        rule.onNodeWithText("Connected").assertExists()
        rule.onNodeWithTag("settings-radar-unpair").assertExists()
        rule.onAllNodesWithText("connecting.").assertCountEquals(0)
    }

    @Test
    fun `connecting steps render one, two, and three dots`() {
        val state = mutableStateOf(
            RadarUiState(
                serial = "ADFAA003519",
                phase = RadarPhase.connecting,
                connectingStep = 0,
                linkSuppressed = true
            )
        )
        rule.setContent {
            app.teamstation.cameraman.ui.theme.CameramanTheme {
                RadarSettingsCard(state.value, {}, {}, {}, {})
            }
        }
        for ((step, label) in listOf(0 to "connecting.", 1 to "connecting..", 2 to "connecting...")) {
            state.value = state.value.copy(connectingStep = step)
            rule.onNodeWithText(label).assertExists()
        }
    }

    @Test
    fun `the overlay shows the pair only while connected`() {
        val state = mutableStateOf(RadarUiState())
        rule.setContent {
            app.teamstation.cameraman.ui.theme.CameramanTheme {
                SpeedOverlay(state.value)
            }
        }
        rule.onAllNodesWithTag("radar-speeds").assertCountEquals(0)
        state.value = RadarUiState(
            phase = RadarPhase.connected,
            board = SpeedBoard().receive(50, 60, 0)
        )
        rule.onNodeWithTag("radar-speeds").assertTextEquals("50/60")
        state.value = state.value.copy(batteryPercent = 19)
        rule.onNodeWithTag("radar-speeds").assertTextEquals("⚡19% 50/60")
        state.value = RadarUiState(
            phase = RadarPhase.connected,
            board = SpeedBoard().receive(0, 70, 0)
        )
        rule.onNodeWithTag("radar-speeds").assertTextEquals("–/70")
    }

    @Test
    fun `the card names bluetooth, location, permission, and a quiet idle`() {
        val state = mutableStateOf(
            RadarUiState(serial = "ADFAA003519", phase = RadarPhase.bluetoothOff)
        )
        rule.setContent {
            app.teamstation.cameraman.ui.theme.CameramanTheme {
                RadarSettingsCard(state.value, {}, {}, {}, {})
            }
        }
        rule.onNodeWithText("Bluetooth is off").assertExists()
        state.value = state.value.copy(phase = RadarPhase.locationOff)
        rule.onNodeWithText("Location is off").assertExists()
        state.value = state.value.copy(phase = RadarPhase.permission)
        rule.onNodeWithText("Bluetooth permission is required").assertExists()
        state.value = state.value.copy(phase = RadarPhase.idle, statusText = "Paused")
        rule.onNodeWithText("Paused").assertExists()
    }

    @Test
    fun `a live connecting card steps the dots`() {
        val steps = mutableListOf<Int>()
        val state = mutableStateOf(
            RadarUiState(serial = "ADFAA003519", phase = RadarPhase.connecting)
        )
        rule.mainClock.autoAdvance = false
        rule.setContent {
            app.teamstation.cameraman.ui.theme.CameramanTheme {
                RadarSettingsCard(state.value, {}, {}, {}, {}, onStep = { steps.add(it) })
            }
        }
        rule.mainClock.advanceTimeBy(900)
        rule.waitForIdle()
        state.value = state.value.copy(phase = RadarPhase.idle)
        rule.mainClock.autoAdvance = true
        assertTrue(steps.isNotEmpty())
    }

    @Test
    fun `preferences round-trip a serial and reject anything that is not a TAG One`() {
        val store = PreferencesRadarPairingStore(RuntimeEnvironment.getApplication())
        assertEquals(null, store.read())
        store.write("ADFAA003519")
        assertEquals("ADFAA003519", store.read())
        store.write("nope")
        assertEquals("nope", org.robolectric.RuntimeEnvironment.getApplication()
            .getSharedPreferences(PreferencesRadarPairingStore.FILE, 0)
            .getString("serial", null))
        assertEquals(null, store.read())
        store.write(null)
        assertEquals(null, store.read())
    }

    @Test
    fun `the platform radio can be constructed and idled`() {
        val radio = systemRadarRadio(RuntimeEnvironment.getApplication())
        radio.setListener(null)
        radio.startScan { }
        radio.stopScan()
        radio.connect("ADFAA003519")
        radio.disconnect()
        radio.subscribe("6e40ff03-b5a3-f393-e0a9-5461674f6e65")
        radio.write(byteArrayOf(0x80.toByte(), 0x01, 0x65))
    }
}
