package app.teamstation.app.qrscanner

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.TSQrScannerManagerDelegate
import com.facebook.react.viewmanagers.TSQrScannerManagerInterface

/** `TSQrScanner`: Share Lineup's camera, a [QrScannerView]. */
class QrScannerViewManager :
    SimpleViewManager<QrScannerView>(),
    TSQrScannerManagerInterface<QrScannerView> {
    private val delegate = TSQrScannerManagerDelegate(this)

    override fun getDelegate(): ViewManagerDelegate<QrScannerView> = delegate

    override fun getName(): String = NAME

    override fun createViewInstance(context: ThemedReactContext): QrScannerView = QrScannerView(context)

    override fun setActive(view: QrScannerView, value: Boolean) {
        view.setActive(value)
    }

    override fun onDropViewInstance(view: QrScannerView) {
        view.release()
        super.onDropViewInstance(view)
    }

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
        mapOf(
            "topCode" to mapOf("registrationName" to "onCode"),
            "topStatus" to mapOf("registrationName" to "onStatus")
        )

    companion object {
        const val NAME = "TSQrScanner"
    }
}
