package app.teamstation.speedy

import android.content.Context
import app.teamstation.speedy.core.AudioSetting
import app.teamstation.speedy.core.RadarStatus
import app.teamstation.speedy.core.SpeedBoard
import app.teamstation.speedy.core.SpeedyModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ModelTest {
    private val radar = FakeSpeedyRadar()
    private val player = RecordingPlayer()
    private val scheduler = StepScheduler()
    private val preferences = RuntimeEnvironment.getApplication().getSharedPreferences("model-test", Context.MODE_PRIVATE)
    private var clock = 1_800_000_000_000L

    private fun model(uiTest: Boolean = true) =
        SpeedyModel(radar, player, AudioSetting(preferences), scheduler, { clock }, uiTest)

    @Test
    fun `start and refresh reach the radar and read its status`() {
        val model = model()
        radar.status = RadarStatus(serial = "ADFA1", link = RadarStatus.Link.CONNECTED)
        model.start()
        model.refresh()
        assertEquals(listOf("start", "resume", "refresh"), radar.calls)
        assertEquals("Connected", model.radarStatus.value.text)
        radar.status = RadarStatus()
        assertEquals("No radar paired", model.radarStatus.value.text)
    }

    @Test
    fun `a reading shows at once and is spoken after the hold`() {
        val model = model()
        radar.reading(56, 0)
        assertEquals("56", model.pitchText(clock))
        assertEquals("--", model.exitText(clock))
        assertTrue(player.played.isEmpty())
        scheduler.advance(250)
        assertEquals(listOf(listOf("n56-final")), player.played)
        assertEquals("56", model.speechLog.value)
        assertEquals("--", model.pitchText(clock + 5_000))
        assertEquals(clock, model.now)
        radar.reading(0, 0)
        assertEquals("56", model.pitchText(clock))
    }

    @Test
    fun `audio off shows but does not speak and is remembered`() {
        val model = model()
        assertTrue(model.audioOn.value)
        model.toggleAudio()
        assertFalse(model.audioOn.value)
        assertEquals(1, player.stops)
        radar.reading(70, 0)
        scheduler.advance(1_000)
        assertEquals("70", model.pitchText(clock))
        assertTrue(player.played.isEmpty())
        assertEquals("muted", model.speechLog.value)
        assertFalse(model().audioOn.value)
        model.toggleAudio()
        assertTrue(model.audioOn.value)
    }

    @Test
    fun `outside a UI test the speech log stays empty and links are ignored`() {
        val model = model(uiTest = false)
        radar.reading(0, 53)
        assertEquals(listOf(listOf("n53-exit", "word-exit")), player.played)
        assertEquals("", model.speechLog.value)
        model.setAudio(false)
        radar.reading(0, 53)
        assertEquals("", model.speechLog.value)
        assertFalse(model.handle("tsspeedy://test/radar-feed?pitch=56"))
        assertFalse(model().handle("tsspeedy://test/nope"))
        model.setAudio(true)
    }

    @Test
    fun `settings pairs and unpairs through the radar`() {
        val model = model()
        model.openSettings()
        assertTrue(model.showingSettings.value)
        model.startPairing()
        model.pair("ADFA0000001")
        model.stopPairing()
        model.unpair()
        model.closeSettings()
        assertFalse(model.showingSettings.value)
        assertEquals(listOf("startPairing", "pair ADFA0000001", "stopPairing", "stopPairing", "unpair", "stopPairing"), radar.calls)
    }

    @Test
    fun `links feed readings, time sequences and reset`() {
        val model = model()
        assertTrue(model.handle("tsspeedy://test/radar-feed?pitch=0&exit=53"))
        assertEquals("53 exit", model.speechLog.value)
        model.handle("tsspeedy://test/radar-sequence?pitch=56&exit=52&gapMs=100")
        scheduler.advance(100)
        assertEquals("52", model.exitText(clock))
        scheduler.advance(1_000)
        assertEquals("56 and 52 exit", model.speechLog.value)
        model.handle("tsspeedy://test/radar-sequence?pitch=61&exit=48&gapMs=600")
        scheduler.advance(600)
        assertEquals("48 exit", model.speechLog.value)
        model.handle("tsspeedy://test/radar-sequence?pitch=60&exit=40&gapMs=100")
        model.handle("tsspeedy://test/reset")
        scheduler.advance(1_000)
        assertEquals(SpeedBoard(), model.board.value)
        assertEquals("", model.speechLog.value)
        assertEquals(1, player.stops)
        assertEquals(
            listOf(
                listOf("n53-exit", "word-exit"),
                listOf("n56-and", "word-and", "n52-exit", "word-exit"),
                listOf("n61-final"),
                listOf("n48-exit", "word-exit")
            ),
            player.played
        )
    }

    @Test
    fun `off the screen the radar is let go, nothing is said, and back it is taken again`() {
        val model = model()
        radar.reading(56, 0)
        model.pause()
        assertEquals(listOf("pause"), radar.calls)
        assertEquals(1, player.stops)
        scheduler.advance(1_000)
        radar.reading(0, 53)
        assertTrue("nothing is said while away", player.played.isEmpty())
        assertTrue("the audio setting is kept", model.audioOn.value)
        model.resume()
        assertEquals(listOf("pause", "resume"), radar.calls)
        model.pause()
        assertTrue(model.isPaused)
        model.start()
        assertFalse("a start takes a paused radar back", model.isPaused)
        radar.reading(0, 53)
        assertEquals(listOf(listOf("n53-exit", "word-exit")), player.played)
    }

    @Test
    fun `a permission the system no longer asks for shows as one for Settings`() {
        val model = model()
        radar.status = RadarStatus(blocker = RadarStatus.Blocker.PERMISSION)
        model.setPermissionInSettings(true)
        assertEquals("Allow Bluetooth in Settings", model.radarStatus.value.text)
        radar.status = RadarStatus(blocker = RadarStatus.Blocker.BLUETOOTH_OFF)
        assertEquals("Bluetooth off", model.radarStatus.value.text)
        radar.status = RadarStatus(blocker = RadarStatus.Blocker.PERMISSION)
        model.setPermissionInSettings(false)
        assertEquals("Allow Bluetooth", model.radarStatus.value.text)
    }

    @Test
    fun `the default clock is the wall clock`() {
        val model = SpeedyModel(radar, player, AudioSetting(preferences), scheduler)
        assertTrue(Math.abs(model.now - System.currentTimeMillis()) < 5_000)
        assertFalse(model.uiTest)
    }
}
