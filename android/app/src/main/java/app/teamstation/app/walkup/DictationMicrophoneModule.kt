package app.teamstation.app.walkup

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.concurrent.Executors
import kotlin.math.max

/**
 * The Android microphone as 16 kHz mono 16-bit PCM, the same frames the
 * iPhone module and the web worklet produce.
 *
 * `RECORD_AUDIO` is asked the first time dictation is turned on. Hardware
 * reads are cut into 3200-byte frames ([PcmFrames]) and emitted as base64
 * `onPcm` events. A phone with no microphone rejects with the same messages
 * the iPhone uses, so the scoring screen can show them unchanged.
 */
class DictationMicrophoneModule(reactContext: ReactApplicationContext) :
    NativeDictationMicrophoneSpec(reactContext) {

  private val main = Handler(Looper.getMainLooper())
  private val reader = Executors.newSingleThreadExecutor()
  private val gate = Any()
  private val queued = mutableListOf<Promise>()

  @Volatile private var running = false
  private var opening = false
  private var asking = false
  private var cancel = false
  private var record: AudioRecord? = null
  private var pending = ByteArray(0)

  override fun invalidate() {
    halt()
    reader.shutdown()
    super.invalidate()
  }

  override fun start(promise: Promise) {
    main.post { enqueueStart(promise) }
  }

  override fun stop(promise: Promise) {
    halt()
    promise.resolve(null)
  }

  private fun enqueueStart(promise: Promise) {
    synchronized(gate) {
      cancel = false
      if (running) {
        promise.resolve(null)
        return
      }
      queued.add(promise)
      if (opening || asking) return
      opening = true
    }
    if (granted()) {
      reader.execute { open() }
      return
    }
    ask()
  }

  private fun ask() {
    val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
    if (activity == null) {
      failWaiting("permission denied")
      return
    }
    synchronized(gate) { asking = true }
    activity.requestPermissions(
        arrayOf(Manifest.permission.RECORD_AUDIO),
        PERMISSION_REQUEST,
        PermissionListener { requestCode, _, _ ->
          if (requestCode != PERMISSION_REQUEST) return@PermissionListener false
          synchronized(gate) { asking = false }
          when {
            cancel -> {
              synchronized(gate) { opening = false }
              succeedWaiting()
            }
            granted() -> reader.execute { open() }
            else -> failWaiting("permission denied")
          }
          true
        })
  }

  private fun open() {
    if (cancel) {
      synchronized(gate) { opening = false }
      succeedWaiting()
      return
    }
    val min =
        AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (min <= 0) {
      failWaiting("This phone has no microphone")
      return
    }
    val opened =
        try {
          create(max(min, PcmFrames.BYTES))
        } catch (error: SecurityException) {
          Log.w(TAG, "record permission", error)
          failWaiting("permission denied")
          return
        } catch (error: Exception) {
          Log.w(TAG, "AudioRecord", error)
          failWaiting("The microphone could not be read")
          return
        }
    if (opened == null) {
      failWaiting("This phone has no microphone")
      return
    }
    try {
      opened.startRecording()
    } catch (error: IllegalStateException) {
      opened.release()
      Log.w(TAG, "startRecording", error)
      failWaiting("The microphone could not be read")
      return
    }
    if (opened.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      opened.release()
      failWaiting("The microphone could not be read")
      return
    }
    val published =
        synchronized(gate) {
          if (cancel) {
            opening = false
            false
          } else {
            record = opened
            pending = ByteArray(0)
            running = true
            opening = false
            true
          }
        }
    if (!published) {
      release(opened)
      succeedWaiting()
      return
    }
    succeedWaiting()
    pump(opened)
  }

  private fun create(bufferSize: Int): AudioRecord? {
    val sources =
        intArrayOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)
    for (source in sources) {
      val candidate =
          try {
            AudioRecord.Builder()
                .setAudioSource(source)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build())
                .setBufferSizeInBytes(bufferSize)
                .build()
          } catch (error: IllegalArgumentException) {
            Log.w(TAG, "source $source", error)
            continue
          }
      if (candidate.state == AudioRecord.STATE_INITIALIZED) return candidate
      candidate.release()
    }
    return null
  }

  private fun pump(opened: AudioRecord) {
    val buffer = ByteArray(PcmFrames.BYTES)
    try {
      while (running) {
        val count = opened.read(buffer, 0, buffer.size)
        if (!running) break
        if (count < 0) {
          // `start` has already resolved, and the module has no error event,
          // so the scoring screen keeps an open microphone that will send
          // nothing until dictation is switched off and on again.
          Log.w(TAG, "read $count")
          break
        }
        if (count == 0) continue
        val (frames, rest) = PcmFrames.append(pending, buffer.copyOf(count))
        pending = rest
        for (frame in frames) emit(frame)
      }
    } finally {
      release(opened)
      synchronized(gate) {
        if (record === opened) record = null
        pending = ByteArray(0)
        running = false
      }
    }
  }

  private fun emit(frame: ByteArray) {
    val encoded = Base64.encodeToString(frame, Base64.NO_WRAP)
    main.post {
      if (!running) return@post
      try {
        emitOnPcm(Arguments.createMap().apply { putString("pcm", encoded) })
      } catch (error: Exception) {
        Log.w(TAG, "No listener for PCM", error)
      }
    }
  }

  /** Unblocks a read in progress. The reader thread releases the recorder. */
  private fun halt() {
    val current: AudioRecord?
    synchronized(gate) {
      cancel = true
      running = false
      current = record
    }
    if (current == null) return
    try {
      if (current.recordingState == AudioRecord.RECORDSTATE_RECORDING) current.stop()
    } catch (error: IllegalStateException) {
      Log.w(TAG, "stop", error)
    }
  }

  private fun release(opened: AudioRecord) {
    try {
      if (opened.recordingState == AudioRecord.RECORDSTATE_RECORDING) opened.stop()
    } catch (_: IllegalStateException) {}
    opened.release()
  }

  private fun granted(): Boolean =
      ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED

  private fun failWaiting(message: String) {
    val waiting =
        synchronized(gate) {
          opening = false
          asking = false
          val copy = queued.toList()
          queued.clear()
          copy
        }
    waiting.forEach { it.reject("microphone", message) }
  }

  private fun succeedWaiting() {
    val waiting =
        synchronized(gate) {
          val copy = queued.toList()
          queued.clear()
          copy
        }
    waiting.forEach { it.resolve(null) }
  }

  companion object {
    const val TAG = "DictationMicrophone"
    private const val SAMPLE_RATE = 16000
    private const val PERMISSION_REQUEST = 4713
  }
}
