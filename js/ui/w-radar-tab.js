// Lazy, same-origin W view. Keep each scanner's DOM and state independent.
export function initWRadarTab({ document: doc = document, window: win = window,
  isMainBusy, pauseMain, resumeMain, shouldResumeMain }) {
  const frame = doc.getElementById('w-radar-frame');
  let active = false, busy = false, blocking = false, loaded = false;
  function sync() {
    const next = active || busy;
    if (next && !blocking) pauseMain();
    if (!next && blocking && shouldResumeMain()) resumeMain();
    blocking = next;
    if (loaded) frame.contentWindow?.postMessage({ type: 'qar:w-context', active, mainBusy: isMainBusy() }, win.location.origin);
  }
  function onMessage(event) {
    if (!loaded || event.origin !== win.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'qar:w-ready') sync();
    if (event.data?.type === 'qar:w-busy' && typeof event.data.busy === 'boolean') {
      busy = event.data.busy; sync();
    }
  }
  win.addEventListener('message', onMessage);
  frame.addEventListener('load', () => { busy = false; sync(); });
  return {
    select(value) {
      active = value;
      if (active && !loaded) { loaded = true; frame.src = frame.dataset.src; }
      sync();
    },
    sync,
    isBusy: () => busy,
    isBlocking: () => blocking,
  };
}
