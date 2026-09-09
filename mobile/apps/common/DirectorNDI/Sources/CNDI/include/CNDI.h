// Umbrella over the vendored NDI headers.
//
// Only `Processing.NDI.Lib.h` is included: it pulls in the send, find, receive, frame-sync,
// routing and utility headers itself, and including them individually produces duplicate
// declarations. The headers beside this one are copied in by
// `gsDirector/scripts/bootstrapNdi.sh` and are gitignored.
#pragma once

#include "Processing.NDI.Lib.h"
