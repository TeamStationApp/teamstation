package app.teamstation.app.cues

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import app.teamstation.app.walkup.NativeCueSoundsSpec
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray

/**
 * The field's swish, pop and bat on Android: each cue a static AudioTrack per
 * voice, so cues can overlap. Sonification needs no audio focus, so a cue
 * never ducks music. Every method is one platform call; what to call and when
 * is cueSoundsController.ts. An exception is logged, never thrown, so sound
 * can never take the app down.
 */
class CueSoundsModule(context: ReactApplicationContext) : NativeCueSoundsSpec(context) {
  private val tracks = mutableMapOf<String, List<AudioTrack>>()

  override fun load(kind: String, samples: ReadableArray, sampleRate: Double) {
    guarded("load $kind") {
      val pcm = ShortArray(samples.size()) { samples.getDouble(it).toInt().toShort() }
      tracks.remove(kind)?.forEach { it.release() }
      tracks[kind] = List(VOICES) { track(pcm, sampleRate.toInt()) }
    }
  }

  override fun play(kind: String, voice: Double) {
    guarded("play $kind") {
      val track = tracks.getValue(kind)[voice.toInt() % VOICES]
      track.stop()
      track.reloadStaticData()
      track.play()
    }
  }

  override fun stop() {
    guarded("stop") { tracks.values.flatten().forEach { it.stop() } }
  }

  override fun isRunning(): Boolean = true

  override fun start() = Unit

  override fun sessionCategory(): String = ""

  override fun useAmbientSession() = Unit

  override fun invalidate() {
    tracks.values.flatten().forEach { it.release() }
    tracks.clear()
    super.invalidate()
  }

  private fun track(pcm: ShortArray, rate: Int): AudioTrack =
      AudioTrack.Builder()
          .setAudioAttributes(
              AudioAttributes.Builder()
                  .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                  .build())
          .setAudioFormat(
              AudioFormat.Builder()
                  .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                  .setSampleRate(rate)
                  .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                  .build())
          .setTransferMode(AudioTrack.MODE_STATIC)
          .setBufferSizeInBytes(pcm.size * 2)
          .build()
          .also { it.write(pcm, 0, pcm.size) }

  private inline fun guarded(what: String, step: () -> Unit) {
    try {
      step()
    } catch (error: Exception) {
      Log.w("CueSounds", "$what: ${error.message}")
    }
  }

  companion object {
    private const val VOICES = 4
  }
}
