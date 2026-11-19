package app.teamstation.speedy

import android.media.AudioAttributes
import android.media.AudioManager
import app.teamstation.speedy.audio.ClipPlayer
import app.teamstation.speedy.audio.Focus
import app.teamstation.speedy.audio.SPEECH
import app.teamstation.speedy.audio.SystemFocus
import app.teamstation.speedy.audio.SystemTrack
import app.teamstation.speedy.audio.Track
import app.teamstation.speedy.core.Phrase
import app.teamstation.speedy.core.Wav
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlayerTest {
    private val context = RuntimeEnvironment.getApplication()
    private fun asset(name: String): ByteArray? =
        runCatching { context.assets.open("$name.wav").use { it.readBytes() } }.getOrNull()

    private class FakeTrack(val pcm: ShortArray) : Track {
        var onDone: (() -> Unit)? = null
        var stopped = false
        override fun play(onDone: () -> Unit) {
            this.onDone = onDone
        }
        override fun stop() {
            stopped = true
        }
    }

    private class FakeFocus : Focus {
        val events = mutableListOf<String>()
        override fun gain() { events += "gain" }
        override fun abandon() { events += "abandon" }
    }

    private val tracks = mutableListOf<FakeTrack>()
    private val focus = FakeFocus()
    private val player = ClipPlayer(::asset, { FakeTrack(it).also { track -> tracks += track } }, focus)

    @Test
    fun `every clip a phrase can name is an asset that parses and is not silent`() {
        val names = Phrase.SPEAKABLE.flatMap { listOf("n$it-final", "n$it-and", "n$it-exit") } + listOf("word-and", "word-exit")
        assertEquals(242, names.size)
        for (name in names) {
            val samples = Wav.samples(asset(name)!!, name)
            assertTrue("$name is longer than 50 ms", samples.size > Wav.RATE / 20)
            assertTrue("$name is not silent", Wav.levelDb(samples) > -40)
        }
    }

    @Test
    fun `the track gets the phrase's clips end to end, and it is sound`() {
        val clips = listOf("n56-and", "word-and", "n52-exit", "word-exit")
        player.play(clips)
        val expected = clips.map { Wav.samples(asset(it)!!, it) }.reduce { a, b -> a + b }
        assertArrayEquals(expected, tracks.single().pcm)
        assertTrue(Wav.levelDb(tracks.single().pcm) > -40)
        assertEquals(listOf("gain"), focus.events)
    }

    @Test
    fun `phrases play in order and focus is held until the last ends`() {
        player.play(listOf("n56-final"))
        player.play(listOf("n53-exit", "word-exit"))
        assertEquals(1, tracks.size)
        assertEquals(1, player.waiting)
        tracks[0].onDone!!()
        assertTrue(tracks[0].stopped)
        assertEquals(2, tracks.size)
        assertTrue(player.playing)
        tracks[1].onDone!!()
        assertFalse(player.playing)
        assertEquals(listOf("gain", "abandon"), focus.events)
    }

    @Test
    fun `a UI test captures what each phrase played`() {
        val file = java.io.File(context.filesDir, "capture-test.wav")
        val capture = app.teamstation.speedy.audio.SpeechCapture(file)
        val capturing = ClipPlayer(::asset, { FakeTrack(it).also { track -> tracks += track } }, focus, capture)
        capturing.play(listOf("n56-final"))
        capturing.play(listOf("n53-exit", "word-exit"))
        tracks[0].onDone!!()
        tracks[1].onDone!!()
        val written = Wav.samples(file.readBytes(), "capture")
        assertEquals(tracks[0].pcm.size + tracks[1].pcm.size, written.size)
        assertArrayEquals(tracks[0].pcm + tracks[1].pcm, written)
        file.delete()
    }

    @Test
    fun `stop drops what waits, and a stopped phrase's end changes nothing`() {
        player.play(listOf("n56-final"))
        player.play(listOf("n57-final"))
        player.stop()
        assertTrue(tracks[0].stopped)
        assertEquals(0, player.waiting)
        tracks[0].onDone!!()
        assertEquals(1, tracks.size)
        player.stop()
        assertEquals(listOf("gain", "abandon"), focus.events)
    }

    @Test
    fun `a missing or broken clip plays nothing`() {
        val broken = ClipPlayer({ if (it == "broken") "nope".toByteArray() else null }, { FakeTrack(it) }, focus)
        broken.play(listOf("missing"))
        broken.play(listOf("broken"))
        broken.play(emptyList())
        assertFalse(broken.playing)
        assertTrue(focus.events.isEmpty())
    }

    @Test
    fun `clips are read once`() {
        var reads = 0
        val counting = ClipPlayer({ reads++; asset(it) }, { FakeTrack(it) }, focus)
        counting.samples("n56-final")
        counting.samples("n56-final")
        assertEquals(1, reads)
    }

    @Test
    fun `the system track plays speech on the media stream`() {
        val track = SystemTrack.of(Wav.samples(asset("n56-final")!!, "n56-final"))
        var done = false
        track.play { done = true }
        // Robolectric's static track never initializes, which is the case that must not stall.
        assertTrue("a track that cannot play is done at once", done)
        track.stop()
        assertEquals(AudioAttributes.USAGE_MEDIA, SPEECH.usage)
        assertEquals(AudioAttributes.CONTENT_TYPE_SPEECH, SPEECH.contentType)
    }

    /** A track the system set up: it plays, and is done when the marker at its last frame is reached. */
    private class ReadyTrack : android.media.AudioTrack(
        SPEECH,
        android.media.AudioFormat.Builder()
            .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(Wav.RATE)
            .setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        4800,
        MODE_STATIC,
        android.media.AudioManager.AUDIO_SESSION_ID_GENERATE
    ) {
        var marker = 0
        var playing = false
        var listener: OnPlaybackPositionUpdateListener? = null
        override fun getState() = STATE_INITIALIZED
        override fun setNotificationMarkerPosition(markerInFrames: Int): Int {
            marker = markerInFrames
            return SUCCESS
        }
        override fun setPlaybackPositionUpdateListener(listener: OnPlaybackPositionUpdateListener?) {
            this.listener = listener
        }
        override fun play() {
            playing = true
        }
    }

    @Test
    fun `a system track that is set up plays until its last frame`() {
        val audio = ReadyTrack()
        var done = false
        SystemTrack(audio, 1234).play { done = true }
        assertTrue(audio.playing)
        assertEquals(1234, audio.marker)
        audio.listener!!.onPeriodicNotification(audio)
        assertFalse(done)
        audio.listener!!.onMarkerReached(audio)
        assertTrue(done)
    }

    @Test
    fun `the system focus is transient and lets others duck`() {
        val systemFocus = SystemFocus(context)
        systemFocus.gain()
        val manager = context.getSystemService(AudioManager::class.java)
        val request = shadowOf(manager).lastAudioFocusRequest
        assertEquals(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK, request.durationHint)
        systemFocus.abandon()
    }
}
