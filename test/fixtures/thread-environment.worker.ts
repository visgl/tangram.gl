// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Thread from '../../modules/tangram-renderer/src/utils/thread';

// Verify the real worker path, including FontFaceObserver's compatibility shim.
postMessage({
  thread: Thread,
  hasDocumentShim: typeof window !== 'undefined' && window.document === document
});
