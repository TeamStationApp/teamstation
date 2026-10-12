package app.teamstation.streamcore.phonestream

import android.Manifest
import android.content.Context
import android.graphics.SurfaceTexture
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.view.Surface
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.gl.ProgrammeDraw
import app.teamstation.streamcore.gl.ProgrammeTicker
import app.teamstation.streamcore.record.SteadyWall
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.MediaCodecAacEncoder
import app.teamstation.streamcore.stream.MediaTelemetry
import app.teamstation.streamcore.stream.ProgramStreamer
import app.teamstation.streamcore.stream.StreamEncoderConfig
import app.teamstation.streamcore.stream.StreamVideoEncoding
import app.teamstation.streamcore.upload.UploadClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.MediaCodecInfoBuilder
import org.robolectric.shadows.ShadowAudioRecord
import org.robolectric.shadows.ShadowMediaCodecList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The engine's system glue under Robolectric's shadows: Camera2 behind [CameraSessionDevice],
 * `AudioRecord` behind [AudioRecordMicrophone], the encoder list, the radios, the live environment.
 * The real camera and microphone are E9's.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneStreamSystemTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    @After
    fun tearDown() {
        ShadowAudioRecord.clearSource()
        ShadowMediaCodecList.reset()
    }

    @Test
    fun theCameraSessionIsThePhonesCaptureDevice() {
        val device = CameraSessionDevice(context)
        val states = mutableListOf<app.teamstation.streamcore.capture.CameraSession.State>()
        device.onStateChange = { states += it }
        assertTrue(device.onStateChange != null)
        assertTrue(device.sensorTimestampsAreRealtime)
        device.configure(CameraPosition.BACK, PhoneStreamProfile.captureSettings(emptySet()))
        device.setProgramme(object : ProgrammeTicker {
            override val frameRate = 30
            override fun tick(latestCaptureNanos: Long?, attached: Set<String>): List<ProgrammeDraw> = emptyList()
        })
        device.start()
        device.setDisplayedZoom(1.0)
        device.setDeviceZoom(1.0)
        device.setLensSelection(LensSelection())
        device.setDisplayRotation(90)
        val surface = Surface(SurfaceTexture(4))
        device.attachEncoder(PhoneProgramme.STREAM_KEY, surface)
        device.detachEncoder(PhoneProgramme.STREAM_KEY)
        device.attachPreview(surface, 1920, 1080)
        device.flip()
        assertTrue(device.lensCatalog().isEmpty())
        device.setProgramme(null)
        device.close()
        shadowOf(android.os.Looper.getMainLooper()).idle()
    }

    @Test
    fun theMicrophoneStampsEachBufferWithItsCaptureTime() {
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        ShadowAudioRecord.setSource(object : ShadowAudioRecord.AudioRecordSource {
            override fun readInShortArray(audioData: ShortArray, offsetInShorts: Int, sizeInShorts: Int, isBlocking: Boolean): Int {
                Thread.sleep(5)
                for (index in offsetInShorts until offsetInShorts + sizeInShorts) audioData[index] = 7
                return sizeInShorts
            }
        })
        val mapping = CaptureClockMapping(SteadyWall(wall = { 1_000.0 }, uptime = { 10.0 }), { 10_000_000_000L }, { 10_000_000_000L })
        val microphone = AudioRecordMicrophone(mapping)
        val heard = CountDownLatch(3)
        val walls = mutableListOf<Double>()
        val started = microphone.start { samples, wall ->
            if (samples.all { it == 7.toShort() }) synchronized(walls) { walls += wall }
            heard.countDown()
        }
        assertTrue(started)
        assertTrue(heard.await(5, TimeUnit.SECONDS))
        microphone.stop()
        microphone.stop()
        assertTrue(synchronized(walls) { walls.isNotEmpty() })
    }

    private class Device : PhoneCaptureDevice {
        override var onStateChange: ((app.teamstation.streamcore.capture.CameraSession.State) -> Unit)? = null
        override val sensorTimestampsAreRealtime = false
        var ticker: ProgrammeTicker? = null
        var closed = 0
        override fun configure(position: CameraPosition, settings: app.teamstation.streamcore.core.StreamSettings) = Unit
        override fun start() = Unit
        override fun close() {
            closed += 1
        }
        override fun flip() = Unit
        override fun setDeviceZoom(value: Double) = Unit
        override fun setDisplayedZoom(value: Double) = Unit
        override fun setLensSelection(selection: LensSelection) = Unit
        override fun lensCatalog() = emptyList<app.teamstation.streamcore.core.CameraLens>()
        override fun attachEncoder(key: String, surface: Surface?) = Unit
        override fun detachEncoder(key: String) = Unit
        override fun attachPreview(surface: Surface?, width: Int, height: Int) = Unit
        override fun setProgramme(ticker: ProgrammeTicker?) {
            this.ticker = ticker
        }
        override fun setDisplayRotation(degrees: Int) = Unit
    }

    @Test
    fun theSourceReadsTheMixOutOnItsOwnThread() {
        val device = Device()
        val mapping = CaptureClockMapping(SteadyWall(wall = { 1_000.0 }, uptime = { 10.0 }), { 12_000_000_000L }, { 2_000_000_000L })
        var wall = 1_000.0
        val source = PhoneCameraSource(device, null, mapping, { wall })
        // A monotonic sensor stamp is moved onto the boot clock first.
        assertEquals(1_001.0, source.captureWall(1_000_000_000L), 1e-6)
        val mix = PhoneSoundMix()
        val pumped = CountDownLatch(2)
        mix.add(PhoneSoundMix.Output(0.0) { pumped.countDown() })
        mix.start(wall)
        val ticker = object : ProgrammeTicker {
            override val frameRate = 30
            override fun tick(latestCaptureNanos: Long?, attached: Set<String>) = emptyList<ProgrammeDraw>()
        }
        source.start(ticker, mix)
        source.start(ticker, mix)
        assertTrue(source.isRunning)
        assertFalse(source.hasMicrophone)
        wall += 0.1
        assertTrue(pumped.await(5, TimeUnit.SECONDS))
        source.stop()
        source.stop()
        assertFalse(source.isRunning)
        assertNull(device.ticker)
        assertEquals(1, device.closed)
        assertTrue(PhoneCameraSource.system(context) { 0.0 }.device is CameraSessionDevice)
    }

    @Test
    fun theEncoderListSaysWhetherThePhoneCanRecord() {
        fun capabilities(mime: String, encoder: Boolean, level: Int) = MediaCodecInfoBuilder.CodecCapabilitiesBuilder.newBuilder()
            .setMediaFormat(MediaFormat().apply { setString(MediaFormat.KEY_MIME, mime) })
            .setIsEncoder(encoder)
            .setProfileLevels(arrayOf(MediaCodecInfo.CodecProfileLevel().apply {
                profile = if (mime == MediaFormat.MIMETYPE_VIDEO_HEVC) MediaCodecInfo.CodecProfileLevel.HEVCProfileMain else MediaCodecInfo.CodecProfileLevel.AVCProfileHigh
                this.level = level
            }))
            .setColorFormats(intArrayOf(MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface))
            .build()
        ShadowMediaCodecList.addCodec(
            MediaCodecInfoBuilder.newBuilder().setName("c2.example.hevc.decoder").setIsEncoder(false)
                .setCapabilities(capabilities(MediaFormat.MIMETYPE_VIDEO_HEVC, false, MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel51)).build()
        )
        ShadowMediaCodecList.addCodec(
            MediaCodecInfoBuilder.newBuilder().setName("c2.example.avc.encoder").setIsEncoder(true)
                .setCapabilities(capabilities(MediaFormat.MIMETYPE_VIDEO_AVC, true, MediaCodecInfo.CodecProfileLevel.AVCLevel51)).build()
        )
        ShadowMediaCodecList.addCodec(
            MediaCodecInfoBuilder.newBuilder().setName("c2.example.hevc.encoder").setIsEncoder(true)
                .setCapabilities(capabilities(MediaFormat.MIMETYPE_VIDEO_HEVC, true, MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel51)).build()
        )
        val encoders = PhoneStreamCapabilities.systemEncoders()
        assertEquals(listOf("c2.example.hevc.encoder"), encoders.map { it.name })
        assertEquals(encoders.single().codes1080p30, PhoneStreamCapabilities.isSupported)
    }

    @Test
    fun theLiveEnvironmentPutsTheSystemsPartsInEachPlace() {
        val live = PhoneStreamEnvironment.live(context)
        assertTrue(live.makeRecordingAudioEncoder() is MediaCodecAacEncoder)
        val output = live.makeStream(MediaTelemetry.None, { 0.0 }, { it }) as ProgramStreamerOutput
        assertFalse(output.admit(0.0))
        output.append(AudioFrame(ShortArray(1920), 0.0))
        output.onInputSurface(null)
        assertFalse(output.running)
        assertTrue(live.makeUploadClient("https://teamstation.example.test", "token-0000") is UploadClient)
        assertTrue(live.makeRadar().state.devices.isEmpty())
        // A host with no foreground service is told nothing.
        PhoneForegroundWork.None.recordingStarted("Home Plate")
        PhoneForegroundWork.None.recordingStopped()
        PhoneForegroundWork.None.uploadStarted("Home Plate")
        PhoneForegroundWork.None.uploadsFinished()
        // An encoder with nothing to drain finishes at once.
        object : StreamVideoEncoding {
            override fun open(config: StreamEncoderConfig, output: StreamVideoEncoding.Output): Surface? = null
            override fun requestSyncFrame() = Unit
            override fun setBitrate(bitrate: Int) = Unit
            override fun close() = Unit
        }.finishInput(10)
        ProgramEncoderTarget(app.teamstation.streamcore.record.ProgramEncoder(MediaTelemetry.None, PhoneStreamProfile.recordingEncoding, context.cacheDir, { 0.0 }, { 0.0 }))
            .append(AudioFrame(ShortArray(1920), 0.0))
        assertTrue(ProgramStreamer.Metrics().queuedBytes == 0)
        assertTrue(EncodedVideoFrame(emptyList(), emptyList(), false, 0.0).nalUnits.isEmpty())
    }

    @Test
    fun thePhonesRadarAsksTheSystem() {
        val radar = PhoneRadar.system(context)
        radar.setEnabled(true)
        radar.scan()
        radar.refresh()
        radar.stopScan()
        assertEquals(PhoneRadar.permissions(android.os.Build.VERSION.SDK_INT), PhoneRadar.permissions())
        assertTrue(radar.state.bluetooth in setOf("on", "off", "unknown"))
        radar.setEnabled(false)
    }
}
