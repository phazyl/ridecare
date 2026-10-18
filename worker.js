/* worker.js - runs the simulation off the main thread.
 * All logic lives in core.js (shared with the page-side fallback); this file only wires messages.
 */
'use strict';
importScripts('shared.js', 'core.js');
const runner = self.GM.createRunner((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => runner.handle(e.data);
