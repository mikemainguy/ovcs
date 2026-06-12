import { state } from './diff-state.js';
import { fetchAndRender } from './diff-fetch.js';
// Side-effect imports: these modules register
// their functions on window when loaded.
import './diff-pull.js';
import './diff-search.js';

function setOrientation(side) {
  state.localSide = side;
  const cache = state.diffContentCache;
  Object.keys(cache).forEach(
    k => delete cache[k]
  );
  document.getElementById('orient-left')
    .classList.toggle(
      'active', side === 'left'
    );
  document.getElementById('orient-right')
    .classList.toggle(
      'active', side === 'right'
    );
  fetchAndRender();
}

function setFilter(type) {
  state.currentFilter = type;
  state.currentPage = 1;
  fetchAndRender();
}

function goPage(p) {
  state.currentPage = p;
  fetchAndRender();
}

function setPageSize(size) {
  state.pageSize = parseInt(size);
  state.currentPage = 1;
  fetchAndRender();
}

window.setOrientation = setOrientation;
window.setFilter = setFilter;
window.goPage = goPage;
window.setPageSize = setPageSize;

async function init() {
  try {
    const meResp = await fetch('/me');
    const me = await meResp.json();
    state.currentUserEmail = me.email;
    state.currentClientId = me.clientId;
  } catch (err) {
    console.warn(
      'Could not fetch user:', err
    );
  }

  let ready = false;
  while (!ready) {
    try {
      const resp = await fetch('/ready');
      const data = await resp.json();
      ready = data.ready;
      if (!ready) {
        const el = document.getElementById(
          'content'
        );
        el.innerHTML =
          '<div class="loading">' +
          'Scanning files... (' +
          data.fileCount + ' found)</div>';
        await new Promise(
          r => setTimeout(r, 500)
        );
      }
    } catch (e) {
      console.error('Ready check failed:', e);
      break;
    }
  }
  fetchAndRender();
}

init();

state.evtSource = new EventSource(
  '/diff-events'
);
state.evtSource.onmessage = (event) => {
  try {
    const parsed = JSON.parse(event.data);
    if (parsed.type === 'connected') return;
  } catch (e) {
    console.error('SSE parse error:', e);
  }
  if (!state.updatePending) {
    state.updatePending = true;
    setTimeout(() => {
      fetchAndRender(false);
      state.updatePending = false;
    }, 500);
  }
};
state.evtSource.onerror = () => {
  console.warn('SSE lost, will auto-reconnect');
};
