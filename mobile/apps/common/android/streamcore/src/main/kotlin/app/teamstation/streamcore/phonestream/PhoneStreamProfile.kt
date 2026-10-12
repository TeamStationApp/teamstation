package app.teamstation.streamcore.phonestream

import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.record.EncodeSettings
import app.teamstation.streamcore.record.RecordingSettings
import app.teamstation.streamcore.record.TakeEncoding
import app.teamstation.streamcore.stream.StreamEncoderConfig
import app.teamstation.streamcore.stream.StreamSettings
import app.teamstation.streamcore.core.StreamSettings as CaptureSettings

/**
 * What a phone records and streams with. Fixed values, none of them shown to the user: a phone at a
 * ball field has nobody to tune it, and TS Director's live values are the ones proven there.
 *
 * - Video: HEVC Main, 1920×1080, 30 fps, a 2 s stream GOP, no B-frames.
 * - Stream: adaptive between 0.5 and 4 Mbps, opening at 2 Mbps with the `.rtmpStream` tuning. A
 *   phone starts on an uplink nobody has measured, so it opens in the middle rather than at the top.
 * - Recording: a fixed 6 Mbps, crash-safe fragmented MP4.
 * - Sound: AAC at 48 kHz. The microphone is mono and is carried as the stereo mix Director's bus
 *   makes; 128 kbps on the stream, 192 kbps in the recording.
 * - TS Director shows each picture a second after capture ([pictureDelaySeconds]) so a late camera
 *   can still make the programme. A phone's one camera is never late, and every picture and every
 *   run of sound is stamped with its capture time on both outputs, so on Android the tick draws the
 *   newest picture at once rather than holding a second of 1080p textures on the GPU. The recording's
 *   mix still waits [recordingMixDelaySeconds] for its sound, and the stream's mix only as long as
 *   the microphone's own buffering ([liveMixDelaySeconds]).
 * - A stream whose connection has taken nothing for 6 s while the stream waits on it is replaced by a
 *   fresh dial ([stallRedialSeconds]). Android's TCP backoff can sit on a dead connection far longer
 *   than that, and the stream would come back only when the server gives up on it.
 */
object PhoneStreamProfile {
    val codec: StreamCodec = StreamCodec.HEVC
    const val width = 1920
    const val height = 1080
    const val frameRate = 30
    const val gopSeconds = 2.0

    const val streamBitrateLow = 500_000
    const val streamBitrateHigh = 4_000_000
    const val streamBitrateStart = 2_000_000
    const val recordingBitrate = 6_000_000

    const val audioSampleRate = 48_000
    const val streamAudioBitrate = 128_000
    const val recordingAudioBitrate = 192_000

    const val pictureDelaySeconds = 1.0
    const val recordingMixDelaySeconds = 1.0
    const val liveMixDelaySeconds = 0.1

    /** How long the app may be away before an interrupted take is closed rather than resumed. */
    const val resumeDowntimeLimitSeconds = 3_600.0

    /** How long the stream's connection may take nothing, with the stream waiting on it, before it is replaced. */
    const val stallRedialSeconds = 6.0

    /** The recording's encoding, kept with every take so its export is made the way it was recorded. */
    val recordingEncoding: EncodeSettings
        get() = EncodeSettings(codec, width, height, frameRate, recordingBitrate, gopSeconds)

    /** A phone has one camera and no camera archive, so the raw camera encoding is the recording's. */
    val takeEncoding: TakeEncoding get() = TakeEncoding(recordingEncoding, recordingEncoding)

    val recordingSettings: RecordingSettings
        get() = RecordingSettings(recordingEncoding, takeEncoding, resumeDowntimeLimitSeconds)

    val streamSettings: StreamSettings
        get() = StreamSettings(
            codec = codec,
            width = width,
            height = height,
            frameRate = frameRate,
            bitrateLow = streamBitrateLow,
            bitrateHigh = streamBitrateHigh,
            gopSeconds = gopSeconds,
            bitrateStart = streamBitrateStart
        )

    /** The recording's own MediaCodec session: the fixed rate, on its frame grid, nothing repeated. */
    val recordingEncoderConfig: StreamEncoderConfig
        get() = StreamEncoderConfig(codec, width, height, frameRate, recordingBitrate, gopSeconds, live = false)

    /** What the camera is opened with: 1080p30 on the lenses the operator left on. */
    fun captureSettings(disabledLenses: Set<String>, position: CameraPosition = CameraPosition.BACK): CaptureSettings =
        CaptureSettings(
            width = width,
            height = height,
            frameRate = frameRate.toDouble(),
            codec = codec,
            audioEnabled = true,
            audioSampleRate = audioSampleRate,
            disabledLensIDs = disabledLenses,
            cameraPosition = position
        )
}
