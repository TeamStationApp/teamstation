package app.teamstation.speedy

import app.teamstation.speedy.core.Announcer
import app.teamstation.speedy.core.AudioSetting
import app.teamstation.speedy.core.ControlCommand
import app.teamstation.speedy.core.Phrase
import app.teamstation.speedy.core.RadarStatus
import app.teamstation.speedy.core.ReadoutMetrics
import app.teamstation.speedy.core.SpeedBoard
import app.teamstation.speedy.core.Wav
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

class SpeedBoardTest {
    @Test
    fun `empty sides show the dash`() {
        assertEquals("--", SpeedBoard().text(SpeedBoard.Side.PITCH, 0))
        assertEquals("--", SpeedBoard().text(SpeedBoard.Side.EXIT, 0))
    }

    @Test
    fun `each side expires five seconds after its own reading`() {
        val board = SpeedBoard().receive(56, 0, 1_000).receive(0, 52, 3_000)
        assertEquals("56", board.text(SpeedBoard.Side.PITCH, 5_999))
        assertEquals("--", board.text(SpeedBoard.Side.PITCH, 6_000))
        assertEquals("52", board.text(SpeedBoard.Side.EXIT, 7_999))
        assertEquals("--", board.text(SpeedBoard.Side.EXIT, 8_000))
    }

    @Test
    fun `a zero side leaves the other alone`() {
        val board = SpeedBoard().receive(56, 52, 0).receive(61, 0, 1_000).receive(0, 0, 4_000)
        assertEquals("61", board.text(SpeedBoard.Side.PITCH, 1_000))
        assertEquals("52", board.text(SpeedBoard.Side.EXIT, 1_000))
        assertEquals("--", board.text(SpeedBoard.Side.EXIT, 5_000))
    }
}

class PhraseTest {
    @Test
    fun `pitch and exit join with and`() {
        assertEquals(listOf("n56-and", "word-and", "n52-exit", "word-exit"), Phrase.clips(56, 52))
        assertEquals("56 and 52 exit", Phrase.words(Phrase.clips(56, 52)))
    }

    @Test
    fun `a pitch alone and an exit alone`() {
        assertEquals(listOf("n56-final"), Phrase.clips(56, null))
        assertEquals("56", Phrase.words(Phrase.clips(56, null)))
        assertEquals(listOf("n53-exit", "word-exit"), Phrase.clips(null, 53))
        assertEquals("53 exit", Phrase.words(Phrase.clips(null, 53)))
    }

    @Test
    fun `only twenty to ninety-nine is spoken`() {
        assertTrue(Phrase.clips(19, null).isEmpty())
        assertEquals(listOf("n20-final"), Phrase.clips(20, null))
        assertEquals(listOf("n99-final"), Phrase.clips(99, null))
        assertTrue(Phrase.clips(100, null).isEmpty())
        assertTrue(Phrase.clips(null, null).isEmpty())
        assertEquals(listOf("n52-exit", "word-exit"), Phrase.clips(104, 52))
        assertEquals(listOf("n56-final"), Phrase.clips(56, 110))
    }
}

class AnnouncerTest {
    private val scheduler = StepScheduler()
    private val said = mutableListOf<String>()
    private val announcer = Announcer(true, scheduler) { said += Phrase.words(it) }

    @Test
    fun `a pitch is said when its window closes`() {
        announcer.receive(56, 0)
        scheduler.advance(249)
        assertTrue(said.isEmpty())
        scheduler.advance(1)
        assertEquals(listOf("56"), said)
    }

    @Test
    fun `an exit inside the window joins the pitch`() {
        announcer.receive(56, 0)
        scheduler.advance(249)
        announcer.receive(0, 52)
        scheduler.advance(1_000)
        assertEquals(listOf("56 and 52 exit"), said)
    }

    @Test
    fun `an exit after the window is said on its own`() {
        announcer.receive(61, 0)
        scheduler.advance(251)
        announcer.receive(0, 48)
        assertEquals(listOf("61", "48 exit"), said)
    }

    @Test
    fun `a reading with both is said at once, and a hit frame after its pitch says the pitch once`() {
        announcer.receive(56, 52)
        assertEquals(0, scheduler.pending)
        announcer.receive(56, 0)
        scheduler.advance(100)
        announcer.receive(56, 52)
        scheduler.advance(1_000)
        assertEquals(listOf("56 and 52 exit", "56 and 52 exit"), said)
    }

    @Test
    fun `a second pitch says the first alone`() {
        announcer.receive(56, 0)
        announcer.receive(62, 0)
        assertEquals(listOf("56"), said)
        scheduler.advance(250)
        assertEquals(listOf("56", "62"), said)
    }

    @Test
    fun `nothing, and unspeakable numbers, say nothing`() {
        announcer.receive(0, 0)
        announcer.receive(104, 0)
        scheduler.advance(1_000)
        assertTrue(said.isEmpty())
        announcer.receive(104, 0)
        announcer.receive(0, 52)
        assertEquals(listOf("52 exit"), said)
    }

    @Test
    fun `audio off ignores readings and drops the waiting pitch`() {
        announcer.receive(56, 0)
        announcer.audioOn = false
        scheduler.advance(1_000)
        announcer.receive(70, 0)
        announcer.receive(0, 52)
        assertTrue(said.isEmpty())
        announcer.audioOn = true
        announcer.receive(0, 52)
        assertEquals(listOf("52 exit"), said)
        announcer.receive(56, 0)
        announcer.reset()
        scheduler.advance(1_000)
        assertEquals(listOf("52 exit"), said)
    }
}

class WavTest {
    @Test
    fun `reads samples and skips other chunks`() {
        assertEquals(listOf<Short>(7, -8, Short.MAX_VALUE), Wav.samples(wavBytes(shortArrayOf(7, -8, Short.MAX_VALUE)), "x").toList())
        val plain = wavBytes(shortArrayOf(1, 2))
        val list = "LIST".toByteArray() + byteArrayOf(3, 0, 0, 0, 1, 2, 3, 0)
        val withChunk = plain.copyOfRange(0, 36) + list + plain.copyOfRange(36, plain.size)
        assertEquals(listOf<Short>(1, 2), Wav.samples(withChunk, "x").toList())
    }

    private fun failure(bytes: ByteArray): String = try {
        Wav.samples(bytes, "x")
        fail("expected a failure")
        ""
    } catch (error: Wav.Failure) {
        error.message.orEmpty()
    }

    @Test
    fun `rejects the wrong format and broken files`() {
        assertEquals("x: codec 3, not PCM", failure(wavBytes(shortArrayOf(1), codec = 3)))
        assertEquals("x: 2 channels, not mono", failure(wavBytes(shortArrayOf(1), channels = 2)))
        assertEquals("x: 16000 Hz, not 24000", failure(wavBytes(shortArrayOf(1), rate = 16_000)))
        assertEquals("x: 8-bit, not 16", failure(wavBytes(shortArrayOf(1), bits = 8)))
        assertEquals("x: not a RIFF WAVE file", failure("nope".toByteArray()))
        val full = wavBytes(shortArrayOf(1, 2, 3, 4))
        assertEquals("x: truncated", failure(full.copyOfRange(0, 46)))
        assertEquals("x: truncated", failure(full.copyOfRange(0, 36)))
        val shortFormat = "RIFF".toByteArray() + byteArrayOf(0, 0, 0, 0) + "WAVEfmt ".toByteArray() + byteArrayOf(4, 0, 0, 0, 1, 0, 1, 0)
        assertEquals("x: truncated", failure(shortFormat))
        assertEquals("x: data before fmt", failure(full.copyOfRange(0, 12) + full.copyOfRange(36, full.size)))
    }

    @Test
    fun levels() {
        assertEquals(Double.NEGATIVE_INFINITY, Wav.levelDb(ShortArray(0)), 0.0)
        assertEquals(Double.NEGATIVE_INFINITY, Wav.levelDb(ShortArray(2)), 0.0)
        assertEquals(-6.02, Wav.levelDb(shortArrayOf(16384, -16384)), 0.01)
    }
}

class ReadoutMetricsTest {
    @Test
    fun `the line sits fifteen percent below center and the numbers fill their widths`() {
        val metrics = ReadoutMetrics.of(400f, 800f, 1.25f)
        assertEquals(520f, metrics.lineY)
        assertEquals(24f, metrics.gap)
        assertEquals(256f, metrics.pitchSize)
        assertEquals(192f, metrics.exitSize)
        assertEquals(360f, metrics.maxTextWidth)
    }

    @Test
    fun `a wide number shrinks to ninety percent`() {
        val metrics = ReadoutMetrics.of(400f, 800f, 1.25f)
        assertEquals(256f, metrics.fitted(256f, 320f))
        assertEquals(128f, metrics.fitted(256f, 720f))
        assertEquals(0f, ReadoutMetrics.pitchSize(0f, 400f))
    }
}

class RadarStatusTest {
    @Test
    fun `blockers come first`() {
        assertEquals("Bluetooth off", RadarStatus(blocker = RadarStatus.Blocker.BLUETOOTH_OFF).text)
        assertEquals("Turn on Location", RadarStatus(blocker = RadarStatus.Blocker.LOCATION_OFF).text)
        assertEquals("Allow Bluetooth", RadarStatus(serial = "ADFA1", link = RadarStatus.Link.CONNECTED, blocker = RadarStatus.Blocker.PERMISSION).text)
    }

    @Test
    fun `nothing paired, then each link`() {
        assertEquals("No radar paired", RadarStatus().text)
        assertFalse(RadarStatus().isPaired)
        assertEquals("No radar paired", RadarStatus(serial = "ADFA1").text)
        fun text(link: RadarStatus.Link) = RadarStatus(serial = "ADFA1", link = link).text
        assertEquals("Off", text(RadarStatus.Link.OFF))
        assertEquals("Searching", text(RadarStatus.Link.SEARCHING))
        assertEquals("Connecting", text(RadarStatus.Link.CONNECTING))
        assertEquals("Connected", text(RadarStatus.Link.CONNECTED))
        assertEquals("Bluetooth off", text(RadarStatus.Link.BLUETOOTH_OFF))
        assertTrue(RadarStatus(serial = "ADFA1").isPaired)
    }
}

class ControlLinkTest {
    @Test
    fun `each command parses`() {
        assertEquals(ControlCommand.RadarFeed(56, 0), ControlCommand.parse("tsspeedy://test/radar-feed?pitch=56&exit=0"))
        assertEquals(ControlCommand.RadarFeed(0, 53), ControlCommand.parse("TSSPEEDY://test/radar-feed?exit=53&junk"))
        assertEquals(ControlCommand.RadarFeed(0, 0), ControlCommand.parse("tsspeedy://test/radar-feed?pitch=-3"))
        assertEquals(ControlCommand.RadarSequence(56, 52, 100), ControlCommand.parse("tsspeedy://test/radar-sequence?pitch=56&exit=52&gapMs=100"))
        assertEquals(ControlCommand.Reset, ControlCommand.parse("tsspeedy://test/reset"))
    }

    @Test
    fun `anything else is null`() {
        assertNull(ControlCommand.parse("tsspeedy://test/radar-sequence?pitch=56&exit=52"))
        assertNull(ControlCommand.parse("tsspeedy://test/radar-sequence?gapMs=-1"))
        assertNull(ControlCommand.parse("tsspeedy://test/unknown"))
        assertNull(ControlCommand.parse("tsspeedy://other/reset"))
        assertNull(ControlCommand.parse("tscameraman://test/reset"))
        assertNull(ControlCommand.parse("not a uri ::"))
    }

    @Test
    fun `the uiTest extra`() {
        assertTrue(ControlCommand.isUITest(true))
        assertTrue(ControlCommand.isUITest("true"))
        assertTrue(ControlCommand.isUITest("YES"))
        assertTrue(ControlCommand.isUITest("1"))
        assertFalse(ControlCommand.isUITest(false))
        assertFalse(ControlCommand.isUITest("false"))
        assertFalse(ControlCommand.isUITest(null))
        assertFalse(ControlCommand.isUITest(1))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AudioSettingTest {
    @Test
    fun `on by default and remembered`() {
        val preferences = RuntimeEnvironment.getApplication().getSharedPreferences("audio-test", Context.MODE_PRIVATE)
        val setting = AudioSetting(preferences)
        assertTrue(setting.isOn)
        setting.isOn = false
        assertFalse(AudioSetting(preferences).isOn)
    }
}
