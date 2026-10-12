package app.teamstation.streamcore.record

import android.media.MediaFormat
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.stream.BasicMediaTelemetry
import app.teamstation.streamcore.stream.MediaCodecAacEncoder
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowMediaCodec
import java.io.File

/**
 * [RecordingSession] against a real catalog: a take opened, recorded, closed; interrupted and picked
 * up as its next part; and the live session's heartbeat.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingSessionTest {
    @get:Rule
    val folder = TemporaryFolder()

    private var wall = 1_000.0
    private var host = 10.0
    private val catalog by lazy { RecordingCatalog(File(folder.root, "index.sqlite")) }
    private val settings = RecordingSettings(EncodeSettings())
    private val rates = mutableListOf<Int>()

    @After
    fun tearDown() {
        catalog.close()
        ShadowMediaCodec.clearCodecs()
    }

    private fun session(heartbeat: Double = 5.0) = RecordingSession(
        catalog,
        ProgramEncoder(BasicMediaTelemetry(), settings.programme, File(folder.root, "programme"), { wall }, { host }, { CountingAac() }),
        clock = { wall },
        heartbeatSeconds = heartbeat,
        setRecordingRate = { rates += it }
    )

    private fun record(session: RecordingSession, seconds: Double) {
        val sets = listOf(FragmentedMp4WriterTest.vps, FragmentedMp4WriterTest.sps, FragmentedMp4WriterTest.pps)
        for (index in 0 until (seconds * 30).toInt()) {
            wall += 1.0 / 30
            host += 1.0 / 30
            val slot = session.encoder.append(host, wall) ?: continue
            session.encoder.appendEncoded(EncodedVideoFrame(listOf(byteArrayOf(0x26, 1)), sets, true, slot))
        }
    }

    @Test
    fun aTakeIsOpenedRecordedAndClosedOnItsRow() {
        val session = session()
        val id = session.open(wall, settings)
        assertTrue(session.isRecording)
        assertEquals(wall, session.startedAt!!, 0.0)
        session.startProgramme(wall, settings)
        assertEquals(listOf(30), rates)
        record(session, 4.0)
        session.detachAnchors()
        val file = session.finishProgramme(until = wall)
        assertNotNull(file)
        session.close(endedAt = wall)
        assertFalse(session.isRecording)
        assertNull(session.startedAt)
        val row = catalog.recording(id)!!
        assertEquals(listOf(file!!.name), row.programFilenames)
        assertEquals(wall, row.endedAt!!, 0.0)
        assertEquals(settings.takeEncoding, row.encoding)
        assertEquals(listOf(0.0, 3.0), catalog.programAnchors(id).map { it.programSeconds })
        assertEquals(1, row.soundChecks.single().part)
    }

    @Test
    fun anInterruptedTakeComesBackAsItsNextPart() {
        val first = session()
        val id = first.open(wall, settings)
        first.startProgramme(wall, settings)
        first.beginLiveSession(recording = id) { true }
        record(first, 4.0)
        first.beatLiveSession(isLive = true)
        // The app is killed here: nothing finishes, nothing closes.
        first.stopHeartbeat()
        wall += 20

        val plan = LiveSessionResume.plan(catalog, now = wall)!!
        val take = (plan.outcome as LiveSessionResume.Outcome.Resume).recording!!
        assertEquals(2, take.nextProgramPart)
        val second = session()
        assertEquals(1, second.resume(take, wall, settings))
        assertEquals(id, second.recordingID)
        val names = catalog.recording(id)!!.programFilenames
        assertEquals(2, names.size)
        assertTrue(names[1].endsWith("-2.mp4"))
        record(second, 4.0)
        second.finishProgramme(until = wall)
        second.close(endedAt = wall)
        val row = catalog.recording(id)!!
        assertEquals(names, row.programFilenames)
        assertEquals(1, row.resumeCount)
        assertEquals(setOf(1, 2), catalog.programPartStarts(id).keys)
    }

    @Test
    fun theHeartbeatKeepsTheSessionAliveAndEndsIt() {
        val session = session(heartbeat = 0.05)
        session.beginLiveSession(streaming = true) { wall < 1_010.0 }
        session.beginLiveSession(streaming = true) { true }
        assertTrue(session.isBeating)
        wall += 5
        Thread.sleep(300)
        assertEquals(1_005.0, catalog.liveSession()!!.lastAlive, 0.0)
        // Nothing live any more: the next beat closes the session and stops beating.
        wall += 10
        val deadline = System.nanoTime() + 3_000_000_000L
        while (session.isBeating && System.nanoTime() < deadline) Thread.sleep(20)
        assertFalse(session.isBeating)
        assertNull(catalog.liveSession())
        session.beginLiveSession(recording = 4, streaming = true) { true }
        session.endLiveSession(streaming = true, stillLive = true)
        assertEquals(4L, catalog.liveSession()!!.recordingID)
        assertTrue(session.isBeating)
        session.endLiveSession(stillLive = false)
        assertNull(catalog.liveSession())
        assertFalse(session.isBeating)
    }

    @Test
    fun silenceIsTheLastPacketOfARunOfZeros() {
        val copy = ShadowMediaCodec.CodecConfig(8192, 8192) { input, output -> output.put(input) }
        ShadowMediaCodec.addEncoder(MediaFormat.MIMETYPE_AUDIO_AAC, copy)
        val packet = SilentAac.packet(MediaCodecAacEncoder())
        assertNotNull(packet)
        assertTrue(packet!!.all { it.toInt() == 0 })
        assertNull(SilentAac.packet(CountingAacThatMakesNothing()))
        assertArrayEquals(byteArrayOf(0x11, 0x90.toByte()), SilentAac.audioSpecificConfig(48_000, 2))
        assertArrayEquals(byteArrayOf(0x11, 0x88.toByte()), SilentAac.audioSpecificConfig(48_000, 1))
        assertArrayEquals(byteArrayOf(0x12, 0x90.toByte()), SilentAac.audioSpecificConfig(32_000, 2))
        assertArrayEquals(byteArrayOf(0x11, 0x90.toByte()), SilentAac.audioSpecificConfig(37_000, 2))
    }

    private class CountingAacThatMakesNothing : app.teamstation.streamcore.stream.StreamAudioEncoding {
        override val audioSpecificConfig = byteArrayOf()
        override val primingSamples = 0
        override fun encode(samples: ShortArray) = emptyList<ByteArray>()
        override fun reset() = Unit
        override fun close() = Unit
    }
}
