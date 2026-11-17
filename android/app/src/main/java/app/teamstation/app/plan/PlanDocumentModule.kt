package app.teamstation.app.plan

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import androidx.core.content.FileProvider
import app.teamstation.app.walkup.NativePlanDocumentSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Hands a game plan PDF in the cache to the system: a share chooser, through
 * the cache FileProvider react-native-blob-util declares, and the print
 * dialog. The rectangle a call carries points an iPad's popover; Android
 * has none to point.
 */
class PlanDocumentModule(context: ReactApplicationContext) : NativePlanDocumentSpec(context) {
  override fun share(path: String, x: Double, y: Double, width: Double, height: Double, promise: Promise) {
    try {
      val file = File(path)
      if (!file.isFile) throw IllegalArgumentException("Nothing to share from")
      val uri = FileProvider.getUriForFile(
        reactApplicationContext, "${reactApplicationContext.packageName}.provider", file)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "application/pdf"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, file.name).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (reactApplicationContext.currentActivity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      (reactApplicationContext.currentActivity ?: reactApplicationContext).startActivity(chooser)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("plan_document", error.message, error)
    }
  }

  override fun print(
    path: String, jobName: String, x: Double, y: Double, width: Double, height: Double, promise: Promise
  ) {
    val file = File(path)
    val activity = reactApplicationContext.currentActivity
    if (!file.isFile || activity == null) {
      promise.reject("plan_document", "Nothing to print")
      return
    }
    UiThreadUtil.runOnUiThread {
      try {
        val printer = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
        val letter = PrintAttributes.Builder()
          .setMediaSize(PrintAttributes.MediaSize.NA_LETTER.asPortrait())
          .build()
        printer.print(jobName, FileAdapter(file, jobName), letter)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("plan_document", error.message, error)
      }
    }
  }

  /** The PDF as it is, copied to whatever the print service asks for. */
  private class FileAdapter(private val file: File, private val name: String) : PrintDocumentAdapter() {
    override fun onLayout(
      oldAttributes: PrintAttributes?, newAttributes: PrintAttributes, cancellation: CancellationSignal?,
      callback: LayoutResultCallback, extras: Bundle?
    ) {
      if (cancellation?.isCanceled == true) {
        callback.onLayoutCancelled()
        return
      }
      callback.onLayoutFinished(
        PrintDocumentInfo.Builder(name)
          .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
          .setPageCount(1)
          .build(),
        oldAttributes != newAttributes)
    }

    override fun onWrite(
      pages: Array<out PageRange>, destination: ParcelFileDescriptor, cancellation: CancellationSignal?,
      callback: WriteResultCallback
    ) {
      try {
        FileInputStream(file).use { input ->
          FileOutputStream(destination.fileDescriptor).use { output -> input.copyTo(output) }
        }
        callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
      } catch (error: Exception) {
        callback.onWriteFailed(error.message)
      }
    }
  }
}
