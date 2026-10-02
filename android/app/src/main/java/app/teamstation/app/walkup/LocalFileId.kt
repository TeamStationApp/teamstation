package app.teamstation.app.walkup

import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale

/**
 * A local file's walk-up `providerId`: `lf:` and the first 16 hex characters
 * of sha256(normalised title, NUL, normalised artist, NUL, whole seconds).
 *
 * The same function as `src/app/walkup/localFileId.ts`, normalisation and
 * all (`normaliseSongText` in `songMatch.ts`), so a song saved on one Android
 * phone is found on another holding the same recording. Both are held to
 * `src/app/walkup/localFileId.fixtures.json` by `LocalFileIdTest` and
 * `localFileId.test.ts`; change one, change the other and the fixtures.
 */
object LocalFileId {
  private val marks = Regex("\\p{M}+")
  private val brackets = Regex("\\([^)]*\\)|\\[[^\\]]*\\]")
  private val featuring =
      Regex("(^|[^\\p{L}\\p{N}])(feat|ft|featuring)(\\.|[^\\p{L}\\p{N}.]).*$")
  private val separators = Regex("[^\\p{L}\\p{N}]+")

  /** Lower case, accents off, brackets and featured artists gone, `&` as `and`. */
  fun normalise(text: String): String =
      Normalizer.normalize(text.lowercase(Locale.ROOT), Normalizer.Form.NFKD)
          .replace(marks, "")
          .replace(brackets, " ")
          .replace(featuring, "\$1")
          .replace("&", " and ")
          .replace(separators, " ")
          .trim()

  fun of(title: String, artist: String, durationMs: Long): String {
    val seconds = (maxOf(0L, durationMs) + 500) / 1000
    val text = "${normalise(title)}\u0000${normalise(artist)}\u0000$seconds"
    val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
    return "lf:" + digest.joinToString("") { "%02x".format(it) }.substring(0, 16)
  }
}
