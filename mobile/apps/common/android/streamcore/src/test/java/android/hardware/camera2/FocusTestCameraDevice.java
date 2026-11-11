package android.hardware.camera2;

import android.hardware.camera2.params.InputConfiguration;
import android.hardware.camera2.params.OutputConfiguration;
import android.os.Handler;
import android.view.Surface;
import java.util.List;

/** A callback-only device: these tests deliberately fail before a capture session exists. */
public final class FocusTestCameraDevice extends CameraDevice {
    public boolean closed;
    @Override public String getId() { return "test-camera"; }
    @Override public void close() { closed = true; }
    @Override public CaptureRequest.Builder createCaptureRequest(int template) { throw new UnsupportedOperationException(); }
    @Override public CaptureRequest.Builder createReprocessCaptureRequest(TotalCaptureResult result) { throw new UnsupportedOperationException(); }
    @Override public void createCaptureSession(List<Surface> outputs, CameraCaptureSession.StateCallback callback, Handler handler) { throw new UnsupportedOperationException(); }
    @Override public void createCaptureSessionByOutputConfigurations(List<OutputConfiguration> outputs, CameraCaptureSession.StateCallback callback, Handler handler) { throw new UnsupportedOperationException(); }
    @Override public void createConstrainedHighSpeedCaptureSession(List<Surface> outputs, CameraCaptureSession.StateCallback callback, Handler handler) { throw new UnsupportedOperationException(); }
    @Override public void createReprocessableCaptureSession(InputConfiguration input, List<Surface> outputs, CameraCaptureSession.StateCallback callback, Handler handler) { throw new UnsupportedOperationException(); }
    @Override public void createReprocessableCaptureSessionByConfigurations(InputConfiguration input, List<OutputConfiguration> outputs, CameraCaptureSession.StateCallback callback, Handler handler) { throw new UnsupportedOperationException(); }
}
