import { fetchAndRender } from './diff-fetch.js';

export async function pullFile(fileId, index) {
  const btn = document.getElementById(
    'pull-btn-' + index
  );
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Pulling...';
  btn.classList.add('pulling');
  try {
    const resp = await fetch(
      '/pull/' + fileId, { method: 'POST' }
    );
    if (resp.ok) {
      const data = await resp.json();
      btn.textContent = 'Pulled';
      btn.classList.remove('pulling');
      btn.classList.add('pulled');
      console.log(
        'Pulled ' + data.file +
        ' (' + data.bytesWritten +
        ' bytes from ' + data.source + ')'
      );
      setTimeout(fetchAndRender, 1000);
    } else {
      const err = await resp.json();
      btn.textContent = 'Failed';
      btn.classList.remove('pulling');
      btn.title = err.error || 'Pull failed';
      setTimeout(() => {
        btn.textContent = 'Retry';
        btn.disabled = false;
      }, 3000);
    }
  } catch (err) {
    btn.textContent = 'Error';
    btn.classList.remove('pulling');
    btn.title = err.message;
    setTimeout(() => {
      btn.textContent = 'Retry';
      btn.disabled = false;
    }, 3000);
  }
}

export async function pullAllMissing() {
  const btn = document.getElementById(
    'pull-all-btn'
  );
  const status = document.getElementById(
    'pull-all-status'
  );
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Pulling...';
  try {
    const resp = await fetch(
      '/pull-missing', { method: 'POST' }
    );
    if (resp.ok) {
      const data = await resp.json();
      btn.textContent =
        'Done (' + data.pulled.length + ' pulled)';
      if (status && data.failed.length > 0) {
        status.textContent =
          data.failed.length + ' failed';
      }
      setTimeout(fetchAndRender, 1000);
    } else {
      const err = await resp.json();
      btn.textContent = 'Failed';
      if (status) status.textContent = err.error;
      setTimeout(() => {
        btn.textContent = 'Pull All Missing';
        btn.disabled = false;
      }, 3000);
    }
  } catch (err) {
    btn.textContent = 'Error';
    if (status) status.textContent = err.message;
    setTimeout(() => {
      btn.textContent = 'Pull All Missing';
      btn.disabled = false;
    }, 3000);
  }
}

window.pullFile = pullFile;
window.pullAllMissing = pullAllMissing;
