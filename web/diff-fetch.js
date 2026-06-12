import { state } from './diff-state.js';
import {
  renderSummary, renderPagination, renderItems
} from './diff-render.js';
import { toggleDiff } from './diff-actions.js';

export async function fetchAndRender(
  fullRender = true
) {
  try {
    let url = '/diff?page=' + state.currentPage +
      '&limit=' + state.pageSize;
    if (state.currentFilter) {
      url += '&type=' + state.currentFilter;
    }
    const [response, warningsResp] =
      await Promise.all([
        fetch(url),
        fetch('/warnings').catch(() => null)
      ]);
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const data = await response.json();

    if (warningsResp?.ok) {
      const wData = await warningsResp.json();
      state.activeOverlaps = {};
      (wData.overlaps || []).forEach(w => {
        state.activeOverlaps[w.fileId] = w;
      });
    }

    renderSummary(data.summary, data.total);
    renderPagination(
      data.page, data.pages,
      data.total, 'pagination-top'
    );
    renderPagination(
      data.page, data.pages,
      data.total, 'pagination-bottom'
    );

    const newIds = buildItemIds(data.items);
    if (fullRender ||
        newIds !== state.lastItemIds.join(',')) {
      const expandedIds = new Set();
      document.querySelectorAll(
        '.diff-body:not(.collapsed)'
      ).forEach(el => {
        expandedIds.add(el.dataset.fileId);
      });

      renderItems(data.items);
      state.lastItemIds = (
        data.items || []
      ).map(i => {
        const rh = Object.values(
          i.doc?.revisions || {}
        ).map(r => r.hash || '').join('|');
        return i.id + ':' + i.diffType +
          ':' + rh;
      });

      if (expandedIds.size > 0) {
        document.querySelectorAll(
          '.diff-body'
        ).forEach(el => {
          if (!expandedIds.has(el.dataset.fileId))
            return;
          delete state.diffContentCache[el.id];
          el.dataset.rendered = '';
          toggleDiff(el.id);
        });
      }
    }
  } catch (error) {
    document.getElementById('content').innerHTML =
      '<div class="error">' +
      'Error loading diff data: ' +
      error.message + '</div>';
  }
}

function buildItemIds(items) {
  return (items || []).map(i => {
    const rh = Object.values(
      i.doc?.revisions || {}
    ).map(r => r.hash || '').join('|');
    return i.id + ':' + i.diffType + ':' + rh;
  }).join(',');
}
