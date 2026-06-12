export async function navSearch() {
  const input = document.getElementById(
    'nav-search-input'
  );
  const q = input.value.trim();
  if (!q) return;
  const type = document.getElementById(
    'nav-search-type'
  ).value;
  const panel = document.getElementById(
    'search-results'
  );
  panel.style.display = 'block';
  panel.innerHTML =
    '<div class="sr-header">' +
    '<h3>Searching...</h3></div>';

  try {
    const url = '/search?q=' +
      encodeURIComponent(q) +
      '&type=' + type + '&limit=20';
    const resp = await fetch(url);
    if (!resp.ok) {
      const err = await resp.json();
      panel.innerHTML =
        '<div class="sr-header">' +
        '<h3>Error: ' + err.error + '</h3>' +
        '<button class="sr-close" ' +
        'onclick="closeSearch()">' +
        '\u2715</button></div>';
      return;
    }
    const data = await resp.json();
    let html =
      '<div class="sr-header"><h3>' +
      data.count + ' results for "' +
      data.query + '" (' + data.type + ')' +
      '</h3><button class="sr-close" ' +
      'onclick="closeSearch()">' +
      '\u2715</button></div>';

    if (data.results.length === 0) {
      html +=
        '<div class="search-result-item">' +
        'No results found.</div>';
    } else {
      data.results.forEach(r => {
        html += renderSearchResult(r);
      });
    }
    panel.innerHTML = html;
  } catch (err) {
    panel.innerHTML =
      '<div class="sr-header">' +
      '<h3>Error: ' + err.message + '</h3>' +
      '<button class="sr-close" ' +
      'onclick="closeSearch()">' +
      '\u2715</button></div>';
  }
}

function renderSearchResult(r) {
  const score = r.score !== null
    ? '<span class="sr-score">' +
      (r.score * 100).toFixed(1) + '%</span>'
    : '';
  const meta = r.node_name
    ? r.node_type + ': ' + r.node_name + ' ' +
      (r.signature || '') + ' (' +
      r.language + ', lines ' +
      r.start_line + '-' + r.end_line + ')'
    : (r.language || 'unknown') +
      ', lines ' + r.start_line +
      '-' + r.end_line;
  const content = r.content
    ? '<div class="sr-content">' +
      escapeHtml(r.content.substring(0, 500)) +
      '</div>' : '';
  const path = encodeURIComponent(r.file_path);
  return '<div class="search-result-item">' +
    score +
    '<div class="sr-file">' +
    '<a href="/file.html?path=' + path + '" ' +
    'style="color:inherit;' +
    'text-decoration:none;' +
    'border-bottom:1px dashed #999;" ' +
    'title="Open file viewer">' +
    r.file_path + '</a></div>' +
    '<div class="sr-meta">' + meta + '</div>' +
    content + '</div>';
}

export function closeSearch() {
  document.getElementById('search-results')
    .style.display = 'none';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

window.navSearch = navSearch;
window.closeSearch = closeSearch;
