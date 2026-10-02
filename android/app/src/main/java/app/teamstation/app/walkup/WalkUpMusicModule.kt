package app.teamstation.app.walkup

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * Walk-up songs on an Android phone: its music files.
 *
 * - **Access** is `READ_MEDIA_AUDIO` (`READ_EXTERNAL_STORAGE` below Android
 *   13), asked for once a launch; after that the answer is read, not asked,
 *   so returning from Settings finds a new grant without a second prompt.
 * - **Search** is MediaStore: music only, every word in the title, artist or
 *   album, 50 at most. The handle is the content address and the provider id
 *   the `lf:` hash (`LocalFileId`).
 * - **Choose a file** is the system picker, with a grant that outlives the
 *   launch, and the tags read from the file.
 * - **Play** is Media3's ExoPlayer, holding transient audio focus that lets
 *   other sound duck. It starts at the clip's start and ramps the player's
 *   own volume — never the phone's — up over the fade in and down over the
 *   fade out before the end, then stops. `stop(fadeMs)` ramps down from
 *   wherever it is.
 *
 * Every report goes to JavaScript as `onWalkUpMusicState` and to the device
 * log under the `WalkUpMusic` tag: `playing` every 250 ms with the position
 * and the level, then `idle` with the fade's start, lowest and restored
 * levels, or `error`.
 */
class WalkUpMusicModule(reactContext: ReactApplicationContext) :
    NativeWalkUpMusicSpec(reactContext), ActivityEventListener {

  private val main = Handler(Looper.getMainLooper())
  private val background = Executors.newSingleThreadExecutor()
  private val accessWaiting = mutableListOf<Promise>()
  private var askedAccess = false
  private var picking: Promise? = null

  private var player: ExoPlayer? = null
  private var clip: Clip? = null
  private var focus: AudioFocusRequest? = null

  private class Clip(
      val handle: String,
      val startMs: Long,
      val endMs: Long,
      val inMs: Long,
      val outMs: Long,
  ) {
    var level = 1f
    var startLevel = 1f
    var lowestLevel = 1f
    var lastReport = 0L
    var fadeFrom = 1f
    var fadeStartedAt = 0L
    var fadeMs = 0L
    var fading = false
  }

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun invalidate() {
    main.post { finish(report = false) }
    background.shutdown()
    super.invalidate()
  }

  // Access

  private val permission: String
    get() =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO
        else Manifest.permission.READ_EXTERNAL_STORAGE

  private fun granted(): Boolean =
      ContextCompat.checkSelfPermission(reactApplicationContext, permission) ==
          PackageManager.PERMISSION_GRANTED

  override fun access(promise: Promise) {
    main.post {
      if (granted()) {
        promise.resolve("authorized")
        return@post
      }
      val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
      if (activity == null || askedAccess) {
        promise.resolve("denied")
        return@post
      }
      accessWaiting.add(promise)
      if (accessWaiting.size > 1) return@post
      askedAccess = true
      activity.requestPermissions(
          arrayOf(permission),
          PERMISSION_REQUEST,
          PermissionListener { requestCode, _, _ ->
            if (requestCode != PERMISSION_REQUEST) return@PermissionListener false
            val answer = if (granted()) "authorized" else "denied"
            Log.i(TAG, "access $answer")
            accessWaiting.forEach { it.resolve(answer) }
            accessWaiting.clear()
            true
          })
    }
  }

  // Search

  override fun search(term: String, promise: Promise) {
    background.execute {
      try {
        if (!granted()) {
          promise.reject("denied", "TeamStation may not read the music on this phone")
          return@execute
        }
        val words = term.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(8)
        val selection = StringBuilder("${MediaStore.Audio.Media.IS_MUSIC} != 0")
        val args = mutableListOf<String>()
        for (word in words) {
          selection.append(
              " AND (${MediaStore.Audio.Media.TITLE} LIKE ? ESCAPE '\\'" +
                  " OR ${MediaStore.Audio.Media.ARTIST} LIKE ? ESCAPE '\\'" +
                  " OR ${MediaStore.Audio.Media.ALBUM} LIKE ? ESCAPE '\\')")
          val pattern = "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
          repeat(3) { args.add(pattern) }
        }
        val projection =
            arrayOf(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.DISPLAY_NAME)
        val results = Arguments.createArray()
        reactApplicationContext.contentResolver
            .query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                projection,
                selection.toString(),
                args.toTypedArray(),
                "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC")
            ?.use { cursor ->
              var count = 0
              while (cursor.moveToNext() && count < SEARCH_LIMIT) {
                val duration = cursor.getLong(4)
                if (duration <= 0) continue
                val uri =
                    ContentUris.withAppendedId(
                        MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cursor.getLong(0))
                results.pushMap(
                    candidate(
                        title = cursor.getString(1),
                        artist = cursor.getString(2),
                        album = cursor.getString(3),
                        durationMs = duration,
                        fallbackName = cursor.getString(5),
                        handle = uri.toString()))
                count++
              }
            }
        promise.resolve(results)
      } catch (error: Exception) {
        promise.reject("search", error.message ?: "The music search failed", error)
      }
    }
  }

  private fun candidate(
      title: String?,
      artist: String?,
      album: String?,
      durationMs: Long,
      fallbackName: String?,
      handle: String,
  ): WritableMap {
    val shownTitle =
        known(title) ?: known(fallbackName)?.substringBeforeLast('.') ?: "Untitled"
    val shownArtist = known(artist) ?: "Unknown artist"
    return Arguments.createMap().apply {
      putString("provider", "localFile")
      putString("providerId", LocalFileId.of(shownTitle, shownArtist, durationMs))
      putNull("isrc")
      putString("title", shownTitle)
      putString("artist", shownArtist)
      val shownAlbum = known(album)
      if (shownAlbum == null) putNull("album") else putString("album", shownAlbum)
      putNull("artworkUrl")
      putDouble("durationMs", durationMs.toDouble())
      putString("source", "device")
      putString("handle", handle)
    }
  }

  /** MediaStore writes `<unknown>` for a missing tag. */
  private fun known(text: String?): String? =
      text?.trim()?.takeUnless { it.isEmpty() || it == "<unknown>" }

  // Choose a file

  override fun pickFile(promise: Promise) {
    main.post {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject("pickFile", "TeamStation is not in front")
        return@post
      }
      picking?.resolve(null)
      picking = promise
      val intent =
          Intent(Intent.ACTION_OPEN_DOCUMENT)
              .addCategory(Intent.CATEGORY_OPENABLE)
              .setType("audio/*")
              .addFlags(
                  Intent.FLAG_GRANT_READ_URI_PERMISSION or
                      Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      try {
        activity.startActivityForResult(intent, PICK_REQUEST)
      } catch (error: Exception) {
        picking = null
        promise.reject("pickFile", error.message ?: "No file picker on this phone", error)
      }
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != PICK_REQUEST) return
    val promise = picking ?: return
    picking = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) {
      promise.resolve(null)
      return
    }
    background.execute {
      try {
        try {
          reactApplicationContext.contentResolver.takePersistableUriPermission(
              uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
          // A provider that grants only for now still plays today.
        }
        promise.resolve(describe(uri))
      } catch (error: Exception) {
        promise.reject("pickFile", error.message ?: "Cannot read that file", error)
      }
    }
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun describe(uri: Uri): WritableMap {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(reactApplicationContext, uri)
      val duration =
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
              ?: 0L
      if (duration <= 0) throw IllegalArgumentException("That file is not a song TeamStation can play")
      return candidate(
          title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE),
          artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST),
          album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM),
          durationMs = duration,
          fallbackName = displayName(uri),
          handle = uri.toString())
    } finally {
      retriever.release()
    }
  }

  private fun displayName(uri: Uri): String? =
      reactApplicationContext.contentResolver
          .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
          ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

  // Play

  override fun play(
      handle: String,
      startMs: Double,
      endMs: Double,
      fadeInMs: Double,
      fadeOutMs: Double,
      promise: Promise,
  ) {
    main.post {
      try {
        finish(report = false)
        val next =
            Clip(handle, startMs.toLong(), endMs.toLong(), fadeInMs.toLong(), fadeOutMs.toLong())
        next.level = if (next.inMs > 0) 0f else 1f
        next.startLevel = next.level
        next.lowestLevel = next.level
        val exo = player ?: newPlayer().also { player = it }
        exo.volume = next.level
        exo.setMediaItem(MediaItem.fromUri(handle), next.startMs)
        exo.prepare()
        requestFocus()
        exo.playWhenReady = true
        clip = next
        Log.i(TAG, "play $handle ${next.startMs}-${next.endMs} fade ${next.inMs}/${next.outMs}")
        main.post(tick)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("play", error.message ?: "Cannot play that song", error)
      }
    }
  }

  override fun stop(fadeMs: Double, promise: Promise) {
    main.post {
      val current = clip
      if (current == null) {
        promise.resolve(null)
        return@post
      }
      if (fadeMs <= 0) {
        finish(report = true)
      } else if (!current.fading) {
        current.fading = true
        current.fadeFrom = current.level
        current.fadeStartedAt = SystemClock.uptimeMillis()
        current.fadeMs = fadeMs.toLong()
      }
      promise.resolve(null)
    }
  }

  private fun newPlayer(): ExoPlayer =
      ExoPlayer.Builder(reactApplicationContext).build().apply {
        setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            false)
        addListener(
            object : Player.Listener {
              override fun onPlayerError(error: PlaybackException) {
                val message = error.message ?: "Playback failed"
                finish(report = false)
                report(Arguments.createMap().apply {
                  putString("kind", "error")
                  putString("message", message)
                })
              }

              override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && clip != null) finish(report = true)
              }
            })
      }

  /** Every 50 ms while a clip plays: the ramps, the end, and the reports. */
  private val tick: Runnable =
      object : Runnable {
        override fun run() {
          val current = clip ?: return
          val exo = player ?: return
          val now = SystemClock.uptimeMillis()
          val position = exo.currentPosition
          var level: Float
          if (current.fading) {
            val done = (now - current.fadeStartedAt).toFloat() / current.fadeMs
            level = current.fadeFrom * (1f - min(1f, done))
            if (done >= 1f) {
              current.level = 0f
              current.lowestLevel = 0f
              finish(report = true)
              return
            }
          } else {
            if (position >= current.endMs) {
              finish(report = true)
              return
            }
            level = 1f
            if (current.inMs > 0) {
              level = min(level, (position - current.startMs).toFloat() / current.inMs)
            }
            if (current.outMs > 0) {
              level = min(level, (current.endMs - position).toFloat() / current.outMs)
            }
          }
          level = max(0f, min(1f, level))
          current.level = level
          current.lowestLevel = min(current.lowestLevel, level)
          exo.volume = level
          if (now - current.lastReport >= REPORT_EVERY_MS) {
            current.lastReport = now
            report(Arguments.createMap().apply {
              putString("kind", "playing")
              putString("handle", current.handle)
              putDouble("positionMs", position.toDouble())
              putDouble("volume", level.toDouble())
            })
          }
          main.postDelayed(this, TICK_MS)
        }
      }

  /** Stops the clip, gives the focus back and, if asked, reports `idle`. */
  private fun finish(report: Boolean) {
    val current = clip ?: return
    clip = null
    main.removeCallbacks(tick)
    player?.let {
      it.stop()
      it.volume = 1f
    }
    abandonFocus()
    Log.i(TAG, "stopped ${current.handle}")
    if (report) {
      report(Arguments.createMap().apply {
        putString("kind", "idle")
        putString("handle", current.handle)
        putDouble("volume", current.level.toDouble())
        putString("fade", "player")
        putDouble("startLevel", current.startLevel.toDouble())
        putDouble("lowestLevel", current.lowestLevel.toDouble())
        putDouble("restoredLevel", 1.0)
      })
    }
  }

  private fun report(state: WritableMap) {
    Log.i(TAG, "WalkUpMusicState $state")
    try {
      emitOnWalkUpMusicState(state)
    } catch (error: Exception) {
      Log.w(TAG, "No listener for a state report", error)
    }
  }

  private fun requestFocus() {
    val audio = reactApplicationContext.getSystemService(AudioManager::class.java) ?: return
    val request =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
            .setOnAudioFocusChangeListener(
                { change ->
                  if (change == AudioManager.AUDIOFOCUS_LOSS ||
                      change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                    finish(report = true)
                  }
                },
                main)
            .build()
    focus = request
    audio.requestAudioFocus(request)
  }

  private fun abandonFocus() {
    val request = focus ?: return
    focus = null
    reactApplicationContext.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(request)
  }

  companion object {
    const val TAG = "WalkUpMusic"
    private const val PERMISSION_REQUEST = 4711
    private const val PICK_REQUEST = 4712
    private const val SEARCH_LIMIT = 50
    private const val TICK_MS = 50L
    private const val REPORT_EVERY_MS = 250L
  }
}
