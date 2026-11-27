package app.teamstation.app.sponsormedia

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * `NativeModules.SponsorMedia`: the phone's half of a sponsor upload. Logos
 * and Schedule row pictures are shrunk or cropped with Android's bitmaps,
 * and reels re-encoded with Media3 Transformer, so the server only has to
 * check them. Each answer is a new file in the app's cache; a failure
 * rejects with the sentence the screen shows.
 */
class SponsorMediaModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val work = Executors.newSingleThreadExecutor()

  override fun getName(): String = "SponsorMedia"

  @ReactMethod
  fun resizeImage(uri: String, maxWidth: Double, maxHeight: Double, format: String, promise: Promise) {
    image(uri, format, promise) { width, height ->
      Crop(0, 0, width, height) to
          SponsorMediaCore.fit(width, height, maxWidth, maxHeight, even = false)
    }
  }

  @ReactMethod
  fun cropSquare(uri: String, size: Double, format: String, promise: Promise) {
    image(uri, format, promise) { width, height ->
      SponsorMediaCore.squareCrop(width, height) to
          SponsorMediaCore.Size(size.toInt(), size.toInt())
    }
  }

  @ReactMethod
  fun cropCover(uri: String, width: Double, height: Double, format: String, promise: Promise) {
    image(uri, format, promise) { w, h -> SponsorMediaCore.coverCrop(w, h, width, height) }
  }

  @ReactMethod
  fun encodeReel(uri: String, options: ReadableMap, promise: Promise) {
    work.execute {
      try {
        val plan = probe(uri, options)
        val out = output("mp4")
        Handler(Looper.getMainLooper()).post { transform(uri, plan, out, promise) }
      } catch (problem: Exception) {
        reject(promise, problem, SponsorMediaCore.VIDEO_PROBLEM)
      }
    }
  }

  /** The reel's plan, from the source's size, turn and options. */
  private fun probe(uri: String, options: ReadableMap): SponsorMediaCore.ReelPlan {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(reactApplicationContext, Uri.parse(uri))
      val number = { key: Int -> retriever.extractMetadata(key)?.toIntOrNull() ?: 0 }
      return SponsorMediaCore.reelPlan(
          number(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH),
          number(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT),
          number(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION),
          options.getDouble("width"),
          options.getDouble("height"),
          options.getDouble("fps"),
          options.getDouble("videoBitrate"),
          options.getDouble("audioBitrate"),
      )
    } finally {
      retriever.release()
    }
  }

  /** Encodes `uri` by `plan` into `out`, on the main looper Transformer runs on. */
  private fun transform(uri: String, plan: SponsorMediaCore.ReelPlan, out: File, promise: Promise) {
    val context = reactApplicationContext
    val encoders =
        DefaultEncoderFactory.Builder(context)
            .setRequestedVideoEncoderSettings(
                VideoEncoderSettings.Builder().setBitrate(plan.videoBitrate).build())
            .setRequestedAudioEncoderSettings(
                AudioEncoderSettings.Builder().setBitrate(plan.audioBitrate).build())
            .build()
    val transformer =
        Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoders)
            .addListener(
                object : Transformer.Listener {
                  override fun onCompleted(composition: Composition, result: ExportResult) {
                    promise.resolve(
                        answer(out, plan.width, plan.height).apply {
                          putDouble("durationMs", result.durationMs.toDouble())
                        })
                  }

                  override fun onError(
                      composition: Composition,
                      result: ExportResult,
                      exception: ExportException,
                  ) {
                    reject(promise, exception, SponsorMediaCore.VIDEO_PROBLEM)
                  }
                })
            .build()
    val effects =
        Effects(
            listOf(),
            listOf(
                Presentation.createForWidthAndHeight(
                    plan.width, plan.height, Presentation.LAYOUT_SCALE_TO_FIT),
                FrameDropEffect.createDefaultFrameDropEffect(plan.fps),
            ))
    transformer.start(
        EditedMediaItem.Builder(MediaItem.fromUri(uri)).setEffects(effects).build(), out.path)
  }

  /**
   * The picture at `uri`, upright, with the part `layout` names drawn at the
   * size it names, written as `format`. A PNG keeps its transparency.
   */
  private fun image(
      uri: String,
      format: String,
      promise: Promise,
      layout: (Int, Int) -> Pair<Crop, SponsorMediaCore.Size>,
  ) {
    work.execute {
      try {
        val kind = SponsorMediaCore.format(format)
        val picture = upright(uri)
        val (crop, size) = layout(picture.width, picture.height)
        val part = Bitmap.createBitmap(picture, crop.left, crop.top, crop.width, crop.height)
        val scaled = Bitmap.createScaledBitmap(part, size.width, size.height, true)
        val out = output(kind.extension)
        out.outputStream().use {
          scaled.compress(
              if (kind == SponsorMediaCore.Format.PNG) Bitmap.CompressFormat.PNG
              else Bitmap.CompressFormat.JPEG,
              90,
              it)
        }
        promise.resolve(answer(out, size.width, size.height))
      } catch (problem: Exception) {
        reject(promise, problem, SponsorMediaCore.PICTURE_PROBLEM)
      }
    }
  }

  /** The picture at `uri`, turned as its EXIF orientation says. */
  private fun upright(uri: String): Bitmap {
    val resolver = reactApplicationContext.contentResolver
    val parsed = Uri.parse(uri)
    val bitmap =
        resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it) }
            ?: throw SponsorMediaCore.Problem(SponsorMediaCore.PICTURE_PROBLEM)
    val orientation =
        resolver.openInputStream(parsed)?.use {
          ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, 0)
        }
    val degrees =
        when (orientation) {
          ExifInterface.ORIENTATION_ROTATE_90 -> 90f
          ExifInterface.ORIENTATION_ROTATE_180 -> 180f
          ExifInterface.ORIENTATION_ROTATE_270 -> 270f
          else -> return bitmap
        }
    val turn = Matrix().apply { postRotate(degrees) }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, turn, true)
  }

  private fun output(extension: String): File =
      File(reactApplicationContext.cacheDir, "sponsor-${UUID.randomUUID()}.$extension")

  private fun answer(file: File, width: Int, height: Int): WritableMap =
      Arguments.createMap().apply {
        putString("uri", Uri.fromFile(file).toString())
        putDouble("bytes", file.length().toDouble())
        putInt("width", width)
        putInt("height", height)
      }

  private fun reject(promise: Promise, problem: Exception, sentence: String) {
    promise.reject(
        "sponsor_media",
        (problem as? SponsorMediaCore.Problem)?.sentence ?: sentence,
        problem)
  }
}

private typealias Crop = SponsorMediaCore.Crop
