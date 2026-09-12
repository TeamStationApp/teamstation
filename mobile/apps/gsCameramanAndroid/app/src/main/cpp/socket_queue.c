#include <jni.h>
#include <linux/sockios.h>
#include <sys/ioctl.h>

// Bytes in the socket's kernel send queue: written by the app and not yet acknowledged by the
// peer. -1 when the kernel or the sandbox refuses to say.
JNIEXPORT jint JNICALL
Java_co_gamestation_cameraman_rtsp_SocketQueue_nativeQueuedBytes(JNIEnv *env, jclass type, jint fd) {
    int bytes = 0;
    if (ioctl(fd, SIOCOUTQ, &bytes) != 0) return -1;
    return bytes;
}
