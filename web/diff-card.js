import { state, formatTimestamp } from
  './diff-state.js';
import {
  computeSides, buildOverlapBanner, buildBadge
} from './diff-helpers.js';

export function renderCard(item, index) {
  const doc = item.doc;
  const revisions = doc.revisions || {};
  const revKeys = Object.keys(revisions);
  const displayName = (key) =>
    revisions[key]?.email || key;
  const localKey = revKeys.find(k =>
    k === state.currentClientId ||
    revisions[k]?.email ===
      state.currentUserEmail ||
    k === state.currentUserEmail
  );
  const otherKeys = revKeys.filter(
    k => k !== localKey
  );
  const sides = computeSides(
    item, revisions, revKeys,
    localKey, otherKeys, displayName
  );
  if (!sides) return '';
  const { leftLabel, rightLabel,
    leftTimestamp, rightTimestamp } = sides;

  const headerCls = item.missingLocally
    ? 'missing-local-header'
    : item.missingRemotely
      ? 'missing-remote-header' : '';
  const overlapHtml = buildOverlapBanner(
    doc, item
  );
  const badgeHtml = buildBadge(item, index);
  const diffId = 'diff-' + index;
  const fmtL = leftTimestamp
    ? ' (' + formatTimestamp(leftTimestamp) + ')'
    : '';
  const fmtR = rightTimestamp
    ? ' (' + formatTimestamp(rightTimestamp) + ')'
    : '';
  const leftTs = leftTimestamp
    ? '<span class="timestamp">' +
      formatTimestamp(leftTimestamp) + '</span>'
    : '';
  const rightTs = rightTimestamp
    ? '<span class="timestamp">' +
      formatTimestamp(rightTimestamp) + '</span>'
    : '';
  const moreHtml = otherKeys.length > 1
    ? '<div class="revision-item"><strong>+' +
      (otherKeys.length - 1) +
      ' more</strong></div>' : '';
  const fp = encodeURIComponent(doc.file);
  const fileLink =
    '<a href="/file.html?path=' + fp +
    '" onclick="event.stopPropagation()" ' +
    'style="color:inherit;' +
    'text-decoration:none;' +
    'border-bottom:1px dashed #999;" ' +
    'title="Open file viewer">' +
    doc.file + '</a>';

  return '<div class="conflict-card">' +
    overlapHtml +
    '<div class="conflict-header ' + headerCls +
    '" onclick="toggleDiff(\'' + diffId +
    '\')">' +
    '<h2>' + fileLink + ' ' + badgeHtml +
    ' <span class="expand-hint">' +
    'click to expand</span></h2>' +
    '<div class="revision-info">' +
    '<div class="revision-item">' +
    '<strong>Left:</strong> ' +
    leftLabel + ' ' + leftTs + '</div>' +
    '<div class="revision-item">' +
    '<strong>Right:</strong> ' +
    rightLabel + ' ' + rightTs + '</div>' +
    moreHtml + '</div></div>' +
    '<div class="diff-body collapsed" ' +
    'id="' + diffId + '" ' +
    'data-file-id="' + item.id + '" ' +
    'data-filename="' + doc.file + '" ' +
    'data-left-label="' + leftLabel + '" ' +
    'data-right-label="' + rightLabel + '" ' +
    'data-left-header="' +
    leftLabel + fmtL + '" ' +
    'data-right-header="' +
    rightLabel + fmtR + '" ' +
    'data-diff-type="' + item.diffType + '" ' +
    'data-missing-locally="' +
    item.missingLocally + '" ' +
    'data-missing-remotely="' +
    item.missingRemotely + '">' +
    '</div></div>';
}
