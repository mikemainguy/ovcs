import { fetchAndRender } from './diff-fetch.js';

export function updateMergeBadge(
  el, md, fileId
) {
  const card = el.closest('.conflict-card');
  const hdr = card?.querySelector(
    '.conflict-header'
  );
  if (!md.mergeable || !hdr) return;
  hdr.classList.add('mergeable-header');
  const badge = hdr.querySelector('.badge');
  if (badge) {
    badge.className = 'badge badge-mergeable';
    badge.textContent =
      'Mergeable (' + md.strategy + ')';
  }
  if (!hdr.querySelector('.merge-btn')) {
    const btn = document.createElement('button');
    btn.className = 'merge-btn';
    btn.textContent = 'Merge';
    btn.onclick = (e) => {
      e.stopPropagation();
      mergeFile(fileId, btn);
    };
    badge?.after(btn);
  }
}

function setBtn(btn, text, cls, retry) {
  btn.textContent = text;
  btn.classList.remove('merging');
  if (cls) btn.classList.add(cls);
  if (retry) {
    setTimeout(() => {
      btn.textContent = 'Retry';
      btn.disabled = false;
    }, 3000);
  }
}

export async function mergeFile(fileId, btn) {
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Merging...';
  btn.classList.add('merging');
  try {
    const resp = await fetch(
      '/merge/' + fileId, { method: 'POST' }
    );
    if (resp.ok) {
      const data = await resp.json();
      setBtn(btn, 'Merged', 'merged');
      console.log(
        'Merged ' + data.file +
        ' (' + data.bytesWritten + ' bytes,' +
        ' strategy: ' + data.strategy + ')'
      );
      setTimeout(fetchAndRender, 1000);
    } else {
      const err = await resp.json();
      btn.title = err.error || 'Merge failed';
      setBtn(btn, 'Failed', null, true);
    }
  } catch (err) {
    btn.title = err.message;
    setBtn(btn, 'Error', null, true);
  }
}

window.mergeFile = mergeFile;
