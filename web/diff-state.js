import { createTwoFilesPatch } from 'diff';
import { html as diff2Html } from 'diff2html';

export const state = {
  currentView: 'side-by-side',
  currentUserEmail: null,
  currentClientId: null,
  currentFilter: null,
  currentPage: 1,
  pageSize: 20,
  activeOverlaps: {},
  localSide: 'right',
  diffContentCache: {},
  lastItemIds: [],
  updatePending: false,
  evtSource: null
};

export function createUnifiedDiff(
  filename, oldText, newText,
  oldHeader, newHeader
) {
  return createTwoFilesPatch(
    'a/' + filename, 'b/' + filename,
    oldText || '', newText || '',
    oldHeader, newHeader
  );
}

export function renderDiffHtml(
  diffString, outputFormat
) {
  return diff2Html(diffString, {
    drawFileList: false,
    matching: 'lines',
    outputFormat,
    renderNothingWhenEmpty: false
  });
}

export function formatTimestamp(isoString) {
  if (!isoString) return 'Unknown';
  return new Date(isoString).toLocaleString();
}
