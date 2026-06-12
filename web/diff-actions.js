import { state } from './diff-state.js';
import { renderDiffInElement } from
  './diff-render.js';
import { updateMergeBadge } from
  './diff-merge.js';

export async function toggleDiff(diffId) {
  const el = document.getElementById(diffId);
  if (!el.classList.contains('collapsed')) {
    el.classList.add('collapsed');
    return;
  }
  if (el.dataset.rendered === 'true') {
    el.classList.remove('collapsed');
    return;
  }
  const filename = el.dataset.filename;
  const fileId = el.dataset.fileId;
  const lh = el.dataset.leftHeader;
  const rh = el.dataset.rightHeader;
  const diffType = el.dataset.diffType;
  if (state.diffContentCache[diffId]) {
    const c = state.diffContentCache[diffId];
    renderDiffInElement(
      el, diffId, filename,
      c.left, c.right, lh, rh
    );
    el.classList.remove('collapsed');
    return;
  }
  el.innerHTML =
    '<div style="padding:20px;color:#666;' +
    'text-align:center;">' +
    'Loading content...</div>';
  el.classList.remove('collapsed');
  try {
    if (diffType === 'conflict') {
      const resp = await fetch(
        '/merge-check/' + fileId
      );
      if (resp.ok) {
        const md = await resp.json();
        updateMergeBadge(el, md, fileId);
        const lc = md.localContent || '';
        const rc = md.remoteContent || '';
        const left = state.localSide === 'left'
          ? lc : rc;
        const right = state.localSide === 'left'
          ? rc : lc;
        state.diffContentCache[diffId] = {
          left, right
        };
        renderDiffInElement(
          el, diffId, filename,
          left, right, lh, rh
        );
        return;
      }
    }
    const resp = await fetch(
      '/content/' + fileId
    );
    if (resp.ok) {
      const data = await resp.json();
      const ml =
        el.dataset.missingLocally === 'true';
      const lc = ml ? '' : (data.content || '');
      const rc = ml ? (data.content || '') : '';
      const left = state.localSide === 'left'
        ? lc : rc;
      const right = state.localSide === 'left'
        ? rc : lc;
      state.diffContentCache[diffId] = {
        left, right
      };
      renderDiffInElement(
        el, diffId, filename,
        left, right, lh, rh
      );
    } else {
      el.innerHTML =
        '<div style="padding:20px;color:#999;' +
        'text-align:center;">' +
        'Content not available.</div>';
    }
  } catch (err) {
    el.innerHTML =
      '<div style="padding:20px;' +
      'color:#dc3545;">' +
      'Error loading content: ' +
      err.message + '</div>';
  }
}

window.toggleDiff = toggleDiff;
