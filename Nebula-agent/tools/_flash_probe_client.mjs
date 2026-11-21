// Node client that MIRRORS app.js streamAssistant's real browser path:
//   fetch(stream:true) -> body.getReader() -> read() at least ONE frame -> controller.abort()
//   -> the next read() rejects with AbortError. That AbortError is EXACTLY what sets
//   m.stopped=true in app.js L7266 (if (e.name === "AbortError") m.stopped = true).
// Runs against a REAL gateway subprocess whose upstream is a deterministic slow-SSE mock.
import process from 'node:process';

const port = process.argv[2];
const stopId = 'flash-probe-' + Date.now().toString(36);

async function main() {
  const controller = new AbortController();
  let gotFrames = 0;
  let abortErrorSeen = false;

  // fetch mirrors streamAssistant's body shape: {model, messages:[user], stream:true}
  const resp = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', stop_id: stopId, stream: true,
      messages: [{ role: 'user', content: 'flash probe start' }] }),
    signal: controller.signal,
  });

  const reader = resp.body.getReader();   // same getReader() the browser uses

  // Read at least ONE token frame (proves real streaming got through to us).
  const first = await reader.read();
  if (!first.done) {
    gotFrames++;                          // content landed -> generation "barely started"
  }

  // Now the user "stops": this is what abortStream() does (busy.controller.abort()).
  controller.abort();

  // The NEXT read must reject with AbortError -- the precise condition app.js uses to set stopped=true.
  try {
    await reader.read();
    console.log('P2_READ_AFTER_ABORT: no throw -> FAIL (channel did not honor cancel)');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      console.log('P2_ABORT_ERROR_OK  -> app.js L7266 sets m.stopped=true here');
      abortErrorSeen = true;
    } else {
      console.log('P2_READ_AFTER_ABORT: threw name=' + (e && e.name) + ' msg=' + String(e).slice(0,80));
    }
  }

  console.log('client summary: gotFrames=' + gotFrames + ' abortErrorSeen=' + abortErrorSeen);
}

main().catch((e) => { console.log('client top-level error:', e && (e.name||''), String(e).slice(0,120)); });
