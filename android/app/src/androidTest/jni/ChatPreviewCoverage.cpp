#include <jni.h>
#include "tests/PreviewModuleProbe.h"

namespace facebook::react {
std::shared_ptr<TurboModule> cxxModuleProvider(const std::string &name,
                                            const std::shared_ptr<CallInvoker> &invoker);
}
extern "C" void __llvm_profile_set_filename(const char *);
extern "C" int __llvm_profile_write_file();

extern "C" JNIEXPORT jboolean JNICALL
Java_app_teamstation_app_ChatPreviewCoverageTest_probe(JNIEnv *env, jobject, jstring filename) {
  bool passed = false;
  try {
    passed = preview_test::exercisesPreview([](const auto &invoker) {
      return facebook::react::cxxModuleProvider("NativeChatPreview", invoker);
    });
  } catch (const std::exception &) {
    return JNI_FALSE;
  }
  const char *path = env->GetStringUTFChars(filename, nullptr);
  if (!path) return JNI_FALSE;
  __llvm_profile_set_filename(path);
  const int status = __llvm_profile_write_file();
  env->ReleaseStringUTFChars(filename, path);
  return passed && status == 0;
}
