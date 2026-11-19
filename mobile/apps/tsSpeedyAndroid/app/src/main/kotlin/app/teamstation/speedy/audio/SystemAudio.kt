package app.teamstation.speedy.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import app.teamstation.speedy.core.Wav

/**
 * Speech on the media stream, so the ringer's silent mode does not mute it, with a spoken-content
 * hint the system uses when it ducks.
 */
val SPEECH: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

/** A phrase in a static [AudioTrack], done when its marker at the last frame is reached. */
class SystemTrack(private val track: AudioTrack, private val frames: Int) : Track {
    companion object {
        /** [pcm] at 24 kHz mono, written into a static track before it plays. */
        fun of(pcm: ShortArray): SystemTrack {
            val track = AudioTrack.Builder()
                .setAudioAttributes(SPEECH)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(Wav.RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
            track.write(pcm, 0, pcm.size)
            return SystemTrack(track, pcm.size)
        }
    }

    /** A track the system could not set up is done at once, so the phrases after it still play. */
    override fun play(onDone: () -> Unit) {
        val started = track.state == AudioTrack.STATE_INITIALIZED && runCatching {
            track.notificationMarkerPosition = frames
            track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(track: AudioTrack) = onDone()
                override fun onPeriodicNotification(track: AudioTrack) = Unit
            })
            track.play()
        }.isSuccess
        if (!started) onDone()
    }

    override fun stop() {
        runCatching { track.stop() }
        track.release()
    }
}

/** Transient focus that lets other audio duck while a phrase plays. */
class SystemFocus(context: Context) : Focus {
    private val manager = context.getSystemService(AudioManager::class.java)
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(SPEECH)
        .build()

    override fun gain() {
        manager?.requestAudioFocus(request)
    }

    override fun abandon() {
        manager?.abandonAudioFocusRequest(request)
    }
}
