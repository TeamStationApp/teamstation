package app.teamstation.streamcore.phonestream

import android.content.Context
import android.view.Surface
import app.teamstation.streamcore.record.DirectorClock
import app.teamstation.streamcore.record.SteadyWall
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.ConnectivityNetworkMonitor
import app.teamstation.streamcore.stream.MediaCodecAacEncoder
import app.teamstation.streamcore.stream.MediaCodecStreamEncoder
import app.teamstation.streamcore.stream.MediaTelemetry
import app.teamstation.streamcore.stream.NetworkPathMonitoring
import app.teamstation.streamcore.stream.ProgramStreamer
import app.teamstation.streamcore.stream.StreamAudioEncoding
import app.teamstation.streamcore.stream.StreamPublishing
import app.teamstation.streamcore.stream.StreamRetryScheduling
import app.teamstation.streamcore.stream.StreamVideoEncoding
import app.teamstation.streamcore.upload.UploadClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import okhttp3.OkHttpClient
import java.util.concurrent.Executors

/** The stream as the engine drives it: [ProgramStreamer], or a fake in a test. */
interface PhoneStreamOutput : StreamPublishing, ProgrammeStreamTarget {
    /** Told of every new encoder input surface, and of null when the session closes. */
    fun onInputSurface(listener: ((Surface?) -> Unit)?)
}

/** [ProgramStreamer] as the phone's stream. */
class ProgramStreamerOutput(val streamer: ProgramStreamer) : PhoneStreamOutput, StreamPublishing by streamer {
    override fun admit(presentationTime: Double): Boolean = streamer.append(presentationTime)
    override fun append(audio: AudioFrame) = streamer.append(audio)
    override fun onInputSurface(listener: ((Surface?) -> Unit)?) = streamer.onInputSurface(listener)
}

/**
 * What keeps the phone's work alive while the screen is off or the app is in the background: on
 * Android a foreground service, `camera|microphone` while recording and `dataSync` while uploading,
 * which the app's bridge runs. The engine says when each starts and ends.
 */
interface PhoneForegroundWork {
    fun recordingStarted(angleName: String) = Unit
    fun recordingStopped() = Unit
    fun uploadStarted(angleName: String) = Unit

    /** Every upload has finished or stopped. */
    fun uploadsFinished() = Unit

    companion object {
        val None = object : PhoneForegroundWork {}
    }
}

/** Everything the engine runs on, so a test can put fakes in each place. */
class PhoneStreamEnvironment(
    val storage: PhoneStorage,
    val clock: DirectorClock,
    /** Host uptime in seconds: the clock the programme ticks and the recording's grid run on. */
    val uptime: () -> Double,
    val makeSource: () -> PhoneCameraSource,
    /** The recording's video encoder, a fresh session per part. */
    val makeRecordingVideoEncoder: () -> StreamVideoEncoding,
    /** The recording's AAC encoder, one per part. */
    val makeRecordingAudioEncoder: () -> StreamAudioEncoding,
    /** The stream, with the telemetry and the clocks it stamps by. */
    val makeStream: (telemetry: MediaTelemetry, wallClock: () -> Double, pictureWall: (Double) -> Double) -> PhoneStreamOutput,
    val freeDiskBytes: () -> Long,
    val storageRules: PhoneStorageRules = PhoneStorageRules.standard,
    val retention: PhoneRetentionPolicy = PhoneRetentionPolicy(),
    val http: OkHttpClient = LiveStreamClient.defaultClient,
    val makeUploadClient: (baseURL: String, token: String) -> UploadClient = { base, token -> UploadClient(base, token) },
    /** The waits between upload tries, in milliseconds; a test records them. */
    val uploadSleep: (suspend (Long) -> Unit)? = null,
    val makeRetryScheduler: () -> StreamRetryScheduling? = { null },
    val makePathMonitor: () -> NetworkPathMonitoring? = { null },
    val heartbeatSeconds: Double = 5.0,
    val statusIntervalSeconds: Double = 0.25,
    val storageCheckSeconds: Double = 5.0,
    /** How long a stop waits for the recording's mix to hand over the sound up to the stop. */
    val stopTailSeconds: Double = PhoneStreamProfile.recordingMixDelaySeconds,
    val deviceStatus: PhoneDeviceStatusReading,
    val makeRadar: () -> PhoneRadar,
    val foreground: PhoneForegroundWork = PhoneForegroundWork.None,
    /** The one thread every engine method runs on. */
    val dispatcher: CoroutineDispatcher = Executors.newSingleThreadExecutor { Thread(it, "phone-stream").apply { isDaemon = true } }
        .asCoroutineDispatcher(),
    /** Where blocking work goes: a part's finish, an export. */
    val ioDispatcher: CoroutineDispatcher = Dispatchers.IO
) {
    companion object {
        /** The app's own storage, camera, microphone, network and radios. */
        fun live(context: Context, foreground: PhoneForegroundWork = PhoneForegroundWork.None): PhoneStreamEnvironment {
            val app = context.applicationContext
            val storage = PhoneStorage.standard(app)
            // The process's steady wall clock, anchored at its first reading rather than here.
            val clock = DirectorClock { SteadyWall.shared.seconds() }
            return PhoneStreamEnvironment(
                storage = storage,
                clock = clock,
                uptime = SteadyWall::elapsedRealtime,
                makeSource = { PhoneCameraSource.system(app, clock) },
                makeRecordingVideoEncoder = { MediaCodecStreamEncoder() },
                makeRecordingAudioEncoder = { MediaCodecAacEncoder(bitrate = PhoneStreamProfile.recordingAudioBitrate) },
                makeStream = { telemetry, wallClock, pictureWall ->
                    ProgramStreamerOutput(
                        ProgramStreamer(
                            telemetry = telemetry,
                            audioEncoderFactory = { MediaCodecAacEncoder(bitrate = PhoneStreamProfile.streamAudioBitrate) },
                            wallClock = wallClock,
                            pictureWall = pictureWall
                        )
                    )
                },
                freeDiskBytes = storage::freeBytes,
                makePathMonitor = { ConnectivityNetworkMonitor(app) },
                deviceStatus = SystemDeviceStatus(app),
                makeRadar = { PhoneRadar.system(app) },
                foreground = foreground
            )
        }
    }
}
