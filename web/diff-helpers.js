import { state } from './diff-state.js';

export function computeSides(
  item, revisions, revKeys,
  localKey, otherKeys, displayName
) {
  let lLabel, lTs, rLabel, rTs;
  if (item.missingRemotely) {
    const lr = localKey
      ? revisions[localKey] : null;
    lLabel = 'Local';
    lTs = lr?.updated || null;
    rLabel = 'Remote (missing)';
    rTs = null;
  } else if (item.missingLocally) {
    lLabel = 'Local (missing)';
    lTs = null;
    if (otherKeys.length > 0) {
      rLabel = displayName(otherKeys[0]);
      rTs = revisions[otherKeys[0]]?.updated
        || null;
    } else if (revKeys.length > 0) {
      rLabel = displayName(revKeys[0]);
      rTs = revisions[revKeys[0]]?.updated
        || null;
    } else {
      rLabel = 'Remote'; rTs = null;
    }
  } else {
    const lr = localKey
      ? revisions[localKey] : null;
    if (lr && otherKeys.length > 0) {
      const ok = otherKeys[0];
      lLabel = 'Local'; lTs = lr.updated;
      rLabel = displayName(ok);
      rTs = revisions[ok].updated;
    } else if (lr) {
      lLabel = 'Local'; lTs = lr.updated;
      rLabel = 'Base'; rTs = null;
    } else if (revKeys.length >= 1) {
      const ok = revKeys[0];
      lLabel = 'Base'; lTs = null;
      rLabel = displayName(ok);
      rTs = revisions[ok].updated;
    } else {
      return null;
    }
  }
  if (state.localSide === 'left') {
    return {
      leftLabel: lLabel, leftTimestamp: lTs,
      rightLabel: rLabel, rightTimestamp: rTs
    };
  }
  return {
    leftLabel: rLabel, leftTimestamp: rTs,
    rightLabel: lLabel, rightTimestamp: lTs
  };
}

export function buildOverlapBanner(doc, item) {
  const key = Object.keys(
    state.activeOverlaps
  ).find(
    k => k === doc.file || k === item.id
  );
  if (!key) return '';
  const o = state.activeOverlaps[key];
  const cls = o.severity >= 3
    ? 'overlap-sev-high'
    : o.severity >= 2
      ? 'overlap-sev-medium'
      : 'overlap-sev-low';
  const users = o.nodes.map(n => n.email)
    .filter(e => e !== state.currentUserEmail)
    .join(', ');
  return '<div class="overlap-banner">' +
    '<span class="overlap-icon">&#9888;</span>' +
    '<span class="overlap-sev ' + cls + '">' +
    o.severity.toFixed(1) + '</span>' +
    ' Active overlap &mdash; also being' +
    ' edited by: ' +
    (users || 'others') + '</div>';
}

export function buildBadge(item, index) {
  if (item.missingLocally) {
    const btn =
      '<button class="pull-btn" ' +
      'id="pull-btn-' + index + '" ' +
      'onclick="event.stopPropagation(); ' +
      "pullFile('" + item.id + "', " +
      index + ')">Pull</button>';
    return '<span class="badge ' +
      'badge-missing-local">' +
      'Missing locally</span>' + btn;
  }
  if (item.missingRemotely) {
    return '<span class="badge ' +
      'badge-missing-remote">' +
      'Missing on remote peers</span>';
  }
  return '<span class="badge badge-conflict">' +
    'Conflict</span>';
}
