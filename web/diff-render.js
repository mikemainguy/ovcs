import {
  state, createUnifiedDiff, renderDiffHtml
} from './diff-state.js';
import { renderCard } from './diff-card.js';

export function renderSummary(summary, total) {
  const el = document.getElementById('summary');
  const chips = [
    { type: null, cls: 'chip-all',
      label: 'All', count: total },
    { type: 'conflict', cls: 'chip-conflict',
      label: 'Differences',
      count: summary.conflicts },
    { type: 'missingLocally',
      cls: 'chip-missing-local',
      label: 'Missing Locally',
      count: summary.missingLocally },
    { type: 'missingRemotely',
      cls: 'chip-missing-remote',
      label: 'Missing Remotely',
      count: summary.missingRemotely }
  ];
  const fv = (t) =>
    t === null ? 'null' : "'" + t + "'";
  el.innerHTML = chips.map(c =>
    '<div class="summary-chip ' + c.cls +
    (state.currentFilter === c.type
      ? ' active' : '') +
    '" onclick="setFilter(' + fv(c.type) + ')">' +
    '<span class="chip-count">' + c.count +
    '</span> ' + c.label + '</div>'
  ).join('');

  if (summary.missingLocally > 0) {
    el.innerHTML +=
      '<button class="pull-all-btn" ' +
      'id="pull-all-btn" ' +
      'onclick="pullAllMissing()">' +
      'Pull All Missing' +
      ' (' + summary.missingLocally + ')' +
      '</button>' +
      '<span class="pull-status" ' +
      'id="pull-all-status"></span>';
  }
  const opts = [10, 20, 50, 100].map(n =>
    '<option value="' + n + '"' +
    (n === state.pageSize ? ' selected' : '') +
    '>' + n + '</option>'
  ).join('');
  el.innerHTML +=
    '<div class="page-size">Per page: ' +
    '<select onchange="setPageSize(this.value)">' +
    opts + '</select></div>';
}

export function renderPagination(
  page, pages, total, id
) {
  const el = document.getElementById(id);
  if (pages <= 1) { el.innerHTML = ''; return; }
  const prev = page <= 1 ? ' disabled' : '';
  const next = page >= pages ? ' disabled' : '';
  el.innerHTML =
    '<button onclick="goPage(' + (page - 1) +
    ')"' + prev + '>Previous</button>' +
    '<span class="page-info">Page ' + page +
    ' of ' + pages +
    ' (' + total + ' items)</span>' +
    '<button onclick="goPage(' + (page + 1) +
    ')"' + next + '>Next</button>';
}

export function renderItems(items) {
  const content = document.getElementById(
    'content'
  );
  if (!items || items.length === 0) {
    content.innerHTML =
      '<div class="no-conflicts">' +
      'No differences in this view.</div>';
    return;
  }
  let html = '';
  items.forEach((item, index) => {
    html += renderCard(item, index);
  });
  content.innerHTML = html ||
    '<div class="no-conflicts">' +
    'No differences in this view.</div>';
}

export function renderDiffInElement(
  el, diffId, filename,
  leftContent, rightContent,
  leftHeader, rightHeader
) {
  const fmt = state.currentView === 'side-by-side'
    ? 'side-by-side' : 'line-by-line';
  const ud = createUnifiedDiff(
    filename, leftContent, rightContent,
    leftHeader, rightHeader
  );
  const diffHtml = renderDiffHtml(ud, fmt);
  const sbs = state.currentView === 'side-by-side'
    ? 'active' : '';
  const lbl = state.currentView === 'line-by-line'
    ? 'active' : '';
  el.innerHTML =
    '<div class="view-toggle">' +
    '<button class="' + sbs +
    '" onclick="event.stopPropagation(); ' +
    "reRenderDiff('" + diffId +
    "', 'side-by-side')\">" +
    'Side by Side</button>' +
    '<button class="' + lbl +
    '" onclick="event.stopPropagation(); ' +
    "reRenderDiff('" + diffId +
    "', 'line-by-line')\">" +
    'Line by Line</button></div>' +
    '<div class="diff-content">' +
    diffHtml + '</div>';
  el.dataset.rendered = 'true';
  el.dataset.left = leftContent;
  el.dataset.right = rightContent;
}

export function reRenderDiff(diffId, view) {
  const el = document.getElementById(diffId);
  const ud = createUnifiedDiff(
    el.dataset.filename,
    el.dataset.left, el.dataset.right,
    el.dataset.leftHeader,
    el.dataset.rightHeader
  );
  const fmt = view === 'side-by-side'
    ? 'side-by-side' : 'line-by-line';
  const diffHtml = renderDiffHtml(ud, fmt);
  el.querySelector('.diff-content')
    .innerHTML = diffHtml;
  el.querySelectorAll('.view-toggle button')
    .forEach(b => b.classList.remove('active'));
  const sel = view === 'side-by-side'
    ? 'first-child' : 'last-child';
  el.querySelector(
    '.view-toggle button:' + sel
  ).classList.add('active');
}

window.reRenderDiff = reRenderDiff;
