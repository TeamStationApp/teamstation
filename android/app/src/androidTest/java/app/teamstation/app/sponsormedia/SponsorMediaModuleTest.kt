package app.teamstation.app.sponsormedia

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.ExifInterface
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.PromiseImpl
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The module on a real phone: pictures shrunk and cropped with their
 * transparency kept, and a synthetic 4 s 1280 × 720 60 fps clip encoded to
 * 640 × 360 H.264 at no more than 30 fps.
 */
@RunWith(AndroidJUnit4::class)
class SponsorMediaModuleTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  // A plain context for the module: it reads files and the cache, nothing of React's.
  @Suppress("DEPRECATION")
  private val module = SponsorMediaModule(BridgeReactContext(context))

  private class Answer(val value: ReadableMap?, val problem: String?)

  /** Calls `call` with a promise and waits for what it settles to. */
  private fun settle(call: (PromiseImpl) -> Unit): Answer {
    val done = CountDownLatch(1)
    var answer: Answer? = null
    call(
        PromiseImpl(
            { args ->
              answer = Answer(args[0] as ReadableMap, null)
              done.countDown()
            },
            { args ->
              answer = Answer(null, (args[0] as ReadableMap).getString("message"))
              done.countDown()
            }))
    assertTrue("the module answered", done.await(120, TimeUnit.SECONDS))
    return answer!!
  }

  private fun file(name: String): File = File(context.cacheDir, "test-$name").apply { delete() }

  private fun picture(width: Int, height: Int, name: String, format: Bitmap.CompressFormat): File {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    // Transparent, with an opaque red block in the upper-right corner.
    Canvas(bitmap).drawRect(
        width / 2f, 0f, width.toFloat(), height / 2f, Paint().apply { color = Color.RED })
    val out = file(name)
    out.outputStream().use { bitmap.compress(format, 100, it) }
    return out
  }

  private fun uri(file: File): String = Uri.fromFile(file).toString()

  private fun decoded(answer: Answer): Bitmap {
    val path = Uri.parse(answer.value!!.getString("uri")).path!!
    assertEquals(File(path).length().toDouble(), answer.value.getDouble("bytes"), 0.0)
    return BitmapFactory.decodeFile(path)
  }

  @Test
  fun aLargePngIsShrunkKeepingItsTransparency() {
    val source = picture(960, 540, "logo.png", Bitmap.CompressFormat.PNG)
    val answer = settle { module.resizeImage(uri(source), 480.0, 270.0, "png", it) }
    assertEquals(480, answer.value!!.getInt("width"))
    assertEquals(270, answer.value.getInt("height"))
    val out = decoded(answer)
    assertEquals(480, out.width)
    assertTrue(out.hasAlpha())
    assertEquals(0, Color.alpha(out.getPixel(10, 260)))
    assertEquals(Color.RED, out.getPixel(470, 10))
  }

  @Test
  fun squareAndCoverCropsAreWrittenAsAsked() {
    val source = picture(400, 200, "row.jpg", Bitmap.CompressFormat.JPEG)
    val square = settle { module.cropSquare(uri(source), 128.0, "jpeg", it) }
    assertEquals(128, decoded(square).width)
    assertTrue(square.value!!.getString("uri")!!.endsWith(".jpg"))
    val wide = picture(4000, 224, "background.png", Bitmap.CompressFormat.PNG)
    val cover = settle { module.cropCover(uri(wide), 1920.0, 224.0, "png", it) }
    val out = decoded(cover)
    assertEquals(1920, out.width)
    assertEquals(224, out.height)
    // The upper-right corner is kept: the red block is there.
    assertEquals(Color.RED, out.getPixel(1910, 10))
  }

  @Test
  fun aTurnedPhotoIsDrawnUpright() {
    for ((turn, name) in
        listOf(
            ExifInterface.ORIENTATION_ROTATE_90 to "90",
            ExifInterface.ORIENTATION_ROTATE_180 to "180",
            ExifInterface.ORIENTATION_ROTATE_270 to "270")) {
      val source = picture(400, 200, "turned-$name.jpg", Bitmap.CompressFormat.JPEG)
      ExifInterface(source.path).apply {
        setAttribute(ExifInterface.TAG_ORIENTATION, turn.toString())
        saveAttributes()
      }
      val answer = settle { module.resizeImage(uri(source), 1000.0, 1000.0, "jpeg", it) }
      val expected = if (name == "180") 400 else 200
      assertEquals(name, expected, answer.value!!.getInt("width"))
    }
  }

  @Test
  fun anUnreadablePictureOrFormatIsRefusedWithTheSentence() {
    val missing = settle { module.resizeImage(uri(file("missing.png")), 10.0, 10.0, "png", it) }
    assertEquals(SponsorMediaCore.PICTURE_PROBLEM, missing.problem)
    val notAPicture = file("text.png").apply { writeText("not a picture") }
    assertEquals(
        SponsorMediaCore.PICTURE_PROBLEM,
        settle { module.cropSquare(uri(notAPicture), 10.0, "png", it) }.problem)
    val source = picture(20, 20, "format.png", Bitmap.CompressFormat.PNG)
    assertEquals(
        SponsorMediaCore.PICTURE_PROBLEM,
        settle { module.cropSquare(uri(source), 10.0, "gif", it) }.problem)
  }

  private fun options(width: Double, height: Double): ReadableMap =
      JavaOnlyMap.of(
          "width", width, "height", height, "fps", 30.0,
          "videoBitrate", 1_000_000.0, "audioBitrate", 128_000.0)

  /** A 4 s 1280 × 720 60 fps H.264 clip of a still picture, made with Transformer. */
  private fun sixtyFpsClip(): File {
    val still = picture(1280, 720, "still.png", Bitmap.CompressFormat.PNG)
    val out = file("source.mp4")
    val done = CountDownLatch(1)
    var failure: Exception? = null
    instrumentation.runOnMainSync {
      Transformer.Builder(context)
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .addListener(
              object : Transformer.Listener {
                override fun onCompleted(composition: Composition, result: ExportResult) {
                  done.countDown()
                }

                override fun onError(
                    composition: Composition,
                    result: ExportResult,
                    exception: ExportException,
                ) {
                  failure = exception
                  done.countDown()
                }
              })
          .build()
          .start(
              EditedMediaItem.Builder(
                      MediaItem.Builder()
                          .setUri(uri(still))
                          .setImageDurationMs(4_000)
                          .build())
                  .setFrameRate(60)
                  .build(),
              out.path)
    }
    assertTrue(done.await(120, TimeUnit.SECONDS))
    failure?.let { throw it }
    return out
  }

  @Test
  fun aSixtyFpsClipIsEncodedToThirtyFpsH264Within640By360() {
    val source = sixtyFpsClip()
    val answer = settle { module.encodeReel(uri(source), options(640.0, 360.0), it) }
    val value = answer.value!!
    assertEquals(640, value.getInt("width"))
    assertEquals(360, value.getInt("height"))
    assertTrue(value.getDouble("durationMs") in 3_500.0..4_500.0)
    val path = Uri.parse(value.getString("uri")).path!!
    assertEquals(File(path).length().toDouble(), value.getDouble("bytes"), 0.0)
    val extractor = MediaExtractor().apply { setDataSource(path) }
    val format = extractor.getTrackFormat(0)
    assertEquals(MimeTypes.VIDEO_H264, format.getString(MediaFormat.KEY_MIME))
    assertEquals(640, format.getInteger(MediaFormat.KEY_WIDTH))
    assertEquals(360, format.getInteger(MediaFormat.KEY_HEIGHT))
    extractor.selectTrack(0)
    var frames = 0
    var last = 0L
    while (extractor.sampleTime >= 0) {
      frames++
      last = extractor.sampleTime
      extractor.advance()
    }
    extractor.release()
    // At most 30 frames a second over the clip.
    assertTrue("$frames frames over $last us", frames <= 4 * 30 + 1)
    assertTrue("$frames frames", frames >= 4 * 30 - 10)
  }

  @Test
  fun thePackageGivesTheModuleByItsJavaScriptName() {
    @Suppress("DEPRECATION")
    val react = BridgeReactContext(context)
    val modules = SponsorMediaPackage().createNativeModules(react)
    assertEquals(listOf("SponsorMedia"), modules.map { it.name })
    assertTrue(SponsorMediaPackage().createViewManagers(react).isEmpty())
  }

  @Test
  fun aVideoThatCannotBeReadIsRefusedWithTheSentence() {
    val notAVideo = file("text.mp4").apply { writeText("not a video") }
    assertEquals(
        SponsorMediaCore.VIDEO_PROBLEM,
        settle { module.encodeReel(uri(notAVideo), options(640.0, 360.0), it) }.problem)
  }
}
