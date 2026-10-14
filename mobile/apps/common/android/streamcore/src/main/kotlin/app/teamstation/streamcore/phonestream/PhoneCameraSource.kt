package app.teamstation.streamcore.phonestream

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaRecorder
import android.os.SystemClock
import android.view.Surface
import app.teamstation.streamcore.capture.CameraSession
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.gl.ProgrammeTicker
import app.teamstation.streamcore.record.DirectorClock
import app.teamstation.streamcore.record.SteadyWall
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import app.teamstation.streamcore.core.StreamSettings as CaptureSettings

/**
 * Maps the capture clocks onto the steady wall clock.
 *
 * Camera2 stamps a frame with its sensor timestamp, on `elapsedRealtimeNanos` when the camera says
 * its source is `REALTIME` and on the monotonic clock otherwise. `AudioRecord.getTimestamp` with
 * `TIMEBASE_BOOTTIME` says which frame position was captured when, on `elapsedRealtimeNanos`. The
 * steady wall clock is that same boot clock plus a fixed offset, so both map with one addition and
 * no reading of either clock's epoch.
 */
class CaptureClockMapping(
    /** Read at each mapping, so making a mapping anchors no clock. */
    private val steadyWall: () -> SteadyWall = { SteadyWall.shared },
    private val bootNanos: () -> Long = SystemClock::elapsedRealtimeNanos,
    private val monotonicNanos: () -> Long = System::nanoTime
) {
    constructor(steady: SteadyWall, bootNanos: () -> Long, monotonicNanos: () -> Long) : this({ steady }, bootNanos, monotonicNanos)

    private val steady: SteadyWall get() = steadyWall()

    /** The steady wall second a camera frame stamped [sensorNanos] was captured. */
    fun wallForSensor(sensorNanos: Long, realtime: Boolean): Double {
        val boot = if (realtime) sensorNanos else sensorNanos + (bootNanos() - monotonicNanos())
        return boot / 1e9 + steady.offsetSeconds
    }

    /**
     * The steady wall second microphone frame [frame] was captured, from a boot-time timestamp that
     * says frame [timestampFrame] was captured at [timestampNanos].
     */
    fun wallForAudio(timestampNanos: Long, timestampFrame: Long, frame: Long, sampleRate: Int): Double =
        timestampNanos / 1e9 + (frame - timestampFrame).toDouble() / sampleRate + steady.offsetSeconds

    /** The steady wall second of boot-clock [nanos]: sound read with no timestamp is stamped on arrival. */
    fun wallForBoot(nanos: Long): Double = nanos / 1e9 + steady.offsetSeconds

    fun bootNow(): Long = bootNanos()
}

/** What [PhoneCameraSource] captures pictures from: TS Cameraman's [CameraSession], or a fake in a test. */
interface PhoneCaptureDevice {
    /** On the main thread, with every change of lens, zoom or running state. */
    var onStateChange: ((CameraSession.State) -> Unit)?
    val sensorTimestampsAreRealtime: Boolean

    fun configure(position: CameraPosition, settings: CaptureSettings)
    fun start()
    fun close()

    /** Opens the camera again after it was lost: taken by another app, or failed. */
    fun reopen() = Unit
    fun flip()
    fun setDeviceZoom(value: Double)
    fun setDisplayedZoom(value: Double)
    fun setLensSelection(selection: LensSelection)
    fun lensCatalog(): List<CameraLens>
    fun attachEncoder(key: String, surface: Surface?)
    fun detachEncoder(key: String)
    fun attachPreview(surface: Surface?, width: Int, height: Int)
    fun setProgramme(ticker: ProgrammeTicker?)

    /** The screen's rotation (`Surface.ROTATION_*` in degrees), which turns the picture upright. */
    fun setDisplayRotation(degrees: Int)
}

/** [CameraSession] as the phone's capture device: Camera2 into `CaptureRenderer`. */
class CameraSessionDevice(context: Context) : PhoneCaptureDevice {
    val session = CameraSession(context)
    override var onStateChange: ((CameraSession.State) -> Unit)?
        get() = session.onStateChange
        set(value) {
            session.onStateChange = value
        }
    override val sensorTimestampsAreRealtime: Boolean get() = session.sensorTimestampsAreRealtime

    override fun configure(position: CameraPosition, settings: CaptureSettings) = session.configure(position, settings)
    override fun start() = session.start()
    override fun close() = session.close()
    override fun reopen() = session.reopen()
    override fun flip() = session.flip()
    override fun setDeviceZoom(value: Double) = session.setDeviceZoom(value)
    override fun setDisplayedZoom(value: Double) = session.setDisplayedZoom(value)
    override fun setLensSelection(selection: LensSelection) = session.setLensSelection(selection)
    override fun lensCatalog(): List<CameraLens> = session.lensCatalog()
    override fun attachEncoder(key: String, surface: Surface?) = session.attachEncoder(key, surface)
    override fun detachEncoder(key: String) = session.detachEncoder(key)
    override fun attachPreview(surface: Surface?, width: Int, height: Int) = session.attachPreview(surface, width, height)
    override fun setProgramme(ticker: ProgrammeTicker?) = session.setProgramme(ticker)
    override fun setDisplayRotation(degrees: Int) = session.setDisplayRotation(degrees)
}

/** The phone's microphone: mono 16-bit sound, each buffer with the steady wall second it was captured. */
interface PhoneMicrophone {
    /** Starts reading; false when the microphone could not be opened, and the mix carries silence. */
    fun start(onSound: (samples: ShortArray, captureWall: Double) -> Unit): Boolean
    fun stop()
}

/**
 * `AudioRecord` at 48 kHz mono on its own thread, `VOICE_RECOGNITION` as Cameraman reads it (the
 * source without the handset's noise suppression and gain), each buffer stamped from the record's own
 * boot-time timestamp and frame position.
 */
class AudioRecordMicrophone(
    private val mapping: CaptureClockMapping,
    private val sampleRate: Int = PhoneStreamProfile.audioSampleRate
) : PhoneMicrophone {
    private var record: AudioRecord? = null
    private var thread: Thread? = null

    @Volatile
    private var running = false

    @SuppressLint("MissingPermission")
    override fun start(onSound: (ShortArray, Double) -> Unit): Boolean {
        stop()
        val minimum = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) return false
        val created = runCatching {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minimum * 4
            )
        }.getOrNull() ?: return false
        if (created.state != AudioRecord.STATE_INITIALIZED) {
            created.release()
            return false
        }
        record = created
        running = true
        created.startRecording()
        thread = Thread({
            val buffer = ShortArray(sampleRate / 100 * 2)
            val stamp = AudioTimestamp()
            var framesRead = 0L
            while (running) {
                val read = created.read(buffer, 0, buffer.size)
                if (read <= 0) {
                    if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_DEAD_OBJECT) return@Thread
                    continue
                }
                val wall = if (created.getTimestamp(stamp, AudioTimestamp.TIMEBASE_BOOTTIME) == AudioRecord.SUCCESS) {
                    mapping.wallForAudio(stamp.nanoTime, stamp.framePosition, framesRead, sampleRate)
                } else {
                    mapping.wallForBoot(mapping.bootNow()) - read.toDouble() / sampleRate
                }
                framesRead += read
                onSound(buffer.copyOf(read), wall)
            }
        }, "phone-microphone").apply {
            priority = Thread.MAX_PRIORITY
            isDaemon = true
            start()
        }
        return true
    }

    override fun stop() {
        running = false
        thread?.join(500)
        thread = null
        record?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        record = null
    }
}

/**
 * The phone's one camera and its microphone, feeding the programme. A port of TS Director's
 * `FrameSource` for the phone's camera.
 *
 * Pictures stay on the GPU: Camera2 writes into `CaptureRenderer`'s texture, and the programme's tick
 * ([PhoneProgramme], set as the renderer's [ProgrammeTicker]) draws the latest one into the two
 * encoder surfaces, the stream's and the recording's, stamped from the sensor timestamp mapped onto
 * the steady wall clock. Sound goes from `AudioRecord` into [PhoneSoundMix] at the capture time its
 * frame position maps to, and a sound thread reads the mix out every 10 ms.
 */
class PhoneCameraSource(
    val device: PhoneCaptureDevice,
    private val microphone: PhoneMicrophone?,
    val mapping: CaptureClockMapping,
    private val clock: DirectorClock,
    /** False in a test, which pumps the mix itself. */
    private val runsSoundThread: Boolean = true
) {
    private var sound: ScheduledExecutorService? = null

    /** Whether the microphone opened; when it did not, the mix carries silence. */
    var hasMicrophone = false
        private set

    var isRunning = false
        private set

    /** The steady wall second a picture with sensor timestamp [nanos] was captured. */
    fun captureWall(nanos: Long): Double = mapping.wallForSensor(nanos, device.sensorTimestampsAreRealtime)

    fun start(programme: ProgrammeTicker, mix: PhoneSoundMix) {
        if (isRunning) return
        isRunning = true
        device.setProgramme(programme)
        device.start()
        hasMicrophone = microphone?.start { samples, wall -> mix.write(samples, wall) } ?: false
        if (runsSoundThread) {
            sound = Executors.newSingleThreadScheduledExecutor { Thread(it, "phone-sound").apply { isDaemon = true } }.also {
                it.scheduleWithFixedDelay({ runCatching { mix.pump(clock.now()) } }, 10, 10, TimeUnit.MILLISECONDS)
            }
        }
    }

    fun stop() {
        if (!isRunning) return
        isRunning = false
        sound?.shutdown()
        sound = null
        microphone?.stop()
        device.setProgramme(null)
        device.close()
    }

    companion object {
        fun system(context: Context, clock: DirectorClock): PhoneCameraSource {
            val mapping = CaptureClockMapping()
            return PhoneCameraSource(CameraSessionDevice(context), AudioRecordMicrophone(mapping), mapping, clock)
        }
    }
}
