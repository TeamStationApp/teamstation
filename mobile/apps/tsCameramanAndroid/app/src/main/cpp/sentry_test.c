#include <jni.h>

/* Writes through a null pointer: a real native crash, inside the app's own library, so the NDK
 * handler reports it with this function on top. Only `sentryTest=crash` calls it. */
JNIEXPORT void JNICALL
Java_app_teamstation_cameraman_sentry_SentryTest_nativeCrash(JNIEnv *env, jobject self) {
  (void)env;
  (void)self;
  volatile int *nowhere = (volatile int *)0;
  *nowhere = 42;
}
