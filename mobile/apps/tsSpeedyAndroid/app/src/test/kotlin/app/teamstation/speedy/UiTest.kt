package app.teamstation.speedy

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.teamstation.speedy.core.AudioSetting
import app.teamstation.speedy.core.RadarStatus
import app.teamstation.speedy.core.SpeedyModel
import app.teamstation.speedy.ui.SpeedyScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp")
class UiTest {
    @get:Rule
    val compose = createComposeRule()

    private val radar = FakeSpeedyRadar()
    private val player = RecordingPlayer()
    private val scheduler = StepScheduler()
    private val preferences = RuntimeEnvironment.getApplication().getSharedPreferences("ui-test", Context.MODE_PRIVATE)
    private var allowed = 0

    private fun show(uiTest: Boolean = true): SpeedyModel {
        val model = SpeedyModel(radar, player, AudioSetting(preferences), scheduler, uiTest = uiTest)
        compose.setContent { SpeedyScreen(model, onAllowBluetooth = { allowed++ }, keepsScreenOn = { true }) }
        return model
    }

    @Test
    fun `an empty readout shows dashes, the hint, the gear and the speaker`() {
        show()
        compose.onNodeWithTag("speedy-pitch").assertTextEquals("--")
        compose.onNodeWithTag("speedy-exit").assertTextEquals("--")
        compose.onNodeWithTag("speedy-pair-hint").assertIsDisplayed()
        compose.onNodeWithTag("speedy-settings").assertIsDisplayed()
        compose.onNodeWithTag("speedy-audio-on").assertIsDisplayed()
        compose.onNodeWithTag("speedy-speech-log").assertTextEquals("-")
        compose.onNodeWithTag("speedy-awake").assertTextEquals("keep-screen-on")
    }

    @Test
    fun `readings show, a wide one fits, and the speaker turns the voice off`() {
        val model = show()
        compose.runOnIdle { model.handle("tsspeedy://test/radar-feed?pitch=56&exit=52") }
        compose.onNodeWithTag("speedy-pitch").assertTextEquals("56")
        compose.onNodeWithTag("speedy-exit").assertTextEquals("52")
        compose.onNodeWithTag("speedy-speech-log").assertTextEquals("56 and 52 exit")
        compose.runOnIdle { model.handle("tsspeedy://test/radar-feed?pitch=104&exit=0") }
        compose.onNodeWithTag("speedy-pitch").assertTextEquals("104")
        compose.onNodeWithTag("speedy-audio-on").performClick()
        compose.onNodeWithTag("speedy-audio-off").assertIsDisplayed()
        assertFalse(model.audioOn.value)
    }

    @Test
    fun `a paired radar hides the hint, and a normal launch has no test readouts`() {
        radar.status = RadarStatus(serial = "ADFA0000001", link = RadarStatus.Link.CONNECTED, batteryPercent = 80)
        show(uiTest = false)
        compose.onNodeWithTag("speedy-pair-hint").assertDoesNotExist()
        compose.onNodeWithTag("speedy-speech-log").assertDoesNotExist()
    }

    @Test
    fun `settings with nothing paired offers Pair, then the radars in range`() {
        val model = show()
        compose.onNodeWithTag("speedy-settings").performClick()
        compose.onNodeWithText("Radar").assertIsDisplayed()
        compose.onNodeWithTag("settings-radar-status").assertTextEquals("No radar paired")
        compose.onNodeWithTag("settings-radar-pair").assertTextEquals("Pair").performClick()
        assertEquals(listOf("startPairing"), radar.calls)
        compose.runOnIdle { radar.status = RadarStatus(pairing = true) }
        compose.onNodeWithTag("settings-radar-none").assertIsDisplayed()
        compose.runOnIdle { radar.status = RadarStatus(pairing = true, nearby = listOf("ADFA0000001")) }
        compose.onNodeWithTag("settings-radar-option-ADFA0000001").performClick()
        compose.onNodeWithTag("settings-radar-close").performClick()
        compose.onNodeWithTag("settings-done").performClick()
        assertFalse(model.showingSettings.value)
        assertEquals(listOf("startPairing", "pair ADFA0000001", "stopPairing", "stopPairing", "stopPairing"), radar.calls)
    }

    @Test
    fun `settings with a paired radar shows it and unpairs`() {
        radar.status = RadarStatus(serial = "ADFA0000001", link = RadarStatus.Link.CONNECTED, batteryPercent = 80)
        show()
        compose.onNodeWithTag("speedy-settings").performClick()
        compose.onNodeWithTag("settings-radar-status").assertTextEquals("Connected")
        compose.onNodeWithTag("settings-radar-serial").assertTextEquals("ADFA0000001")
        compose.onNodeWithTag("settings-radar-battery").assertTextEquals("⚡80%")
        compose.onNodeWithTag("settings-radar-pair").assertTextEquals("Pair another radar")
        compose.onNodeWithTag("settings-radar-unpair").performClick()
        assertTrue("unpair" in radar.calls)
    }

    @Test
    fun `without the permission, settings asks for it`() {
        radar.status = RadarStatus(blocker = RadarStatus.Blocker.PERMISSION)
        show()
        compose.onNodeWithTag("speedy-settings").performClick()
        compose.onNodeWithTag("settings-radar-status").assertTextEquals("Allow Bluetooth")
        compose.onNodeWithTag("settings-radar-allow").performClick()
        assertEquals(1, allowed)
    }
}
