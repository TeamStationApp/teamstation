package app.teamstation.app.sponsormedia

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The sizes, crops and encoder options behind [SponsorMediaModule], kept
 * free of Android so the JVM tests check them directly. Every size is in
 * pixels.
 */
object SponsorMediaCore {
  /** The sentence the screen shows for a picture that cannot be used. */
  const val PICTURE_PROBLEM = "This picture could not be read. Try another file."
  /** The sentence the screen shows for a video that cannot be shrunk. */
  const val VIDEO_PROBLEM = "This video could not be shrunk. Try another file."

  /** A failure, carrying the sentence the screen shows. */
  class Problem(val sentence: String) : Exception(sentence)

  enum class Format(val extension: String) {
    PNG("png"),
    JPEG("jpg"),
  }

  fun format(name: String): Format =
      when (name) {
        "png" -> Format.PNG
        "jpeg" -> Format.JPEG
        else -> throw Problem(PICTURE_PROBLEM)
      }

  data class Size(val width: Int, val height: Int)

  /** A part of a picture: its left, top, width and height. */
  data class Crop(val left: Int, val top: Int, val width: Int, val height: Int)

  /**
   * `width` × `height` shrunk to fit within `maxWidth` × `maxHeight`, its
   * proportions kept and never enlarged. `even` rounds each side down to an
   * even number, as the video encoder needs; otherwise each side is rounded,
   * and no side is ever under one pixel (two when even).
   */
  fun fit(width: Int, height: Int, maxWidth: Double, maxHeight: Double, even: Boolean): Size {
    val scale = min(1.0, min(maxWidth / width, maxHeight / height))
    val w = width * scale
    val h = height * scale
    return if (even) Size(max(2, (w / 2).toInt() * 2), max(2, (h / 2).toInt() * 2))
    else Size(max(1, w.roundToInt()), max(1, h.roundToInt()))
  }

  /** The largest centred square of a `width` × `height` picture. */
  fun squareCrop(width: Int, height: Int): Crop {
    val side = min(width, height)
    return Crop((width - side) / 2, (height - side) / 2, side, side)
  }

  /**
   * The largest part of a `width` × `height` picture in the `boxWidth` :
   * `boxHeight` proportion, anchored to its upper-right corner, and the size
   * it is drawn at: at most `boxWidth` wide, never enlarged.
   */
  fun coverCrop(width: Int, height: Int, boxWidth: Double, boxHeight: Double): Pair<Crop, Size> {
    val aspect = boxWidth / boxHeight
    val crop =
        if (width.toDouble() / height > aspect) {
          val cropWidth = (height * aspect).roundToInt()
          Crop(width - cropWidth, 0, cropWidth, height)
        } else {
          Crop(0, 0, width, max(1, (width / aspect).roundToInt()))
        }
    val outWidth = min(crop.width.toDouble(), boxWidth)
    return crop to Size(max(1, outWidth.roundToInt()), max(1, (outWidth / aspect).roundToInt()))
  }

  /** The upright size of a video `width` × `height` turned by `rotation` degrees. */
  fun upright(width: Int, height: Int, rotation: Int): Size =
      if (rotation % 180 == 0) Size(width, height) else Size(height, width)

  /** What a reel is encoded as: its size, frame rate and bitrates. */
  data class ReelPlan(
      val width: Int,
      val height: Int,
      val fps: Float,
      val videoBitrate: Int,
      val audioBitrate: Int,
  )

  /**
   * The plan for a `width` × `height` source turned by `rotation`: upright,
   * within the `boxWidth` × `boxHeight` box with even sides, at the options'
   * frame rate and bitrates.
   */
  fun reelPlan(
      width: Int,
      height: Int,
      rotation: Int,
      boxWidth: Double,
      boxHeight: Double,
      fps: Double,
      videoBitrate: Double,
      audioBitrate: Double,
  ): ReelPlan {
    if (width <= 0 || height <= 0 || fps <= 0) throw Problem(VIDEO_PROBLEM)
    val source = upright(width, height, rotation)
    val size = fit(source.width, source.height, boxWidth, boxHeight, even = true)
    return ReelPlan(size.width, size.height, fps.toFloat(), videoBitrate.toInt(), audioBitrate.toInt())
  }
}
