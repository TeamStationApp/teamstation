// A translation unit exists so SwiftPM treats CNDI as a buildable target rather than a bare
// header directory, and so a header that stops compiling is caught here rather than at the
// first Swift file that imports it.
#include "CNDI.h"

const char* ts_ndi_shim_version(void) {
  return NDIlib_version();
}
