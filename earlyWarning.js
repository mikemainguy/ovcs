import { EventEmitter } from 'node:events';
import { debug } from './debug.js';
import { OVCSSETTINGS } from './const.js';

const emitter = new EventEmitter();

// Map<fileId, { nodes: Map<nodeId, {email, gitBranch, lastSeen}>, firstSeen, severity }>
let overlaps = new Map();
let presenceCollectionRef = null;
let filesCollectionRef = null;
let localNodeId = null;
let presenceSub = null;
let fallbackTimer = null;

function initEarlyWarning(presenceCollection, filesCollection, nodeId) {
    presenceCollectionRef = presenceCollection;
    filesCollectionRef = filesCollection;
    localNodeId = nodeId;

    // Subscribe to all presence changes
    if (presenceCollection) {
        presenceSub = presenceCollection.$.subscribe(() => {
            computeOverlaps();
        });
    }

    // Periodic fallback in case presence changes are missed
    fallbackTimer = setInterval(
        () => computeOverlaps(),
        OVCSSETTINGS.OVERLAP_CHECK_INTERVAL
    );

    debug('Early warning system initialized');
    computeOverlaps();
}

async function computeOverlaps() {
    if (!presenceCollectionRef) return;

    try {
        const docs = await presenceCollectionRef.find().exec();
        const activeNodes = docs
            .map(d => d.toJSON())
            .filter(d => d.status === 'active' && d.id !== localNodeId);

        // Include local node too — we need to detect when WE overlap with others
        const localDoc = localNodeId
            ? docs.find(d => d.toJSON().id === localNodeId)
            : null;
        const localData = localDoc?.toJSON();

        const allNodes = localData
            ? [localData, ...activeNodes]
            : activeNodes;

        // Build fileId -> [nodes] map
        const fileToNodes = new Map();
        for (const node of allNodes) {
            const files = node.activeFiles || [];
            for (const fileId of files) {
                if (!fileToNodes.has(fileId)) {
                    fileToNodes.set(fileId, []);
                }
                fileToNodes.set(fileId, [
                    ...fileToNodes.get(fileId),
                    {
                        nodeId: node.id,
                        email: node.email,
                        gitBranch: node.gitBranch || null,
                        lastSeen: node.lastSeen || null
                    }
                ]);
            }
        }

        const previousOverlaps = new Set(overlaps.keys());
        const newOverlaps = new Map();

        for (const [fileId, nodes] of fileToNodes) {
            if (nodes.length < 2) continue;

            // This file has 2+ nodes editing it
            const severity = computeSeverity(fileId, nodes);
            const existing = overlaps.get(fileId);

            newOverlaps.set(fileId, {
                nodes: new Map(nodes.map(n => [n.nodeId, n])),
                firstSeen: existing?.firstSeen || Date.now(),
                severity
            });

            // Emit event if this is a new overlap
            if (!previousOverlaps.has(fileId)) {
                const event = {
                    type: 'overlap-detected',
                    fileId,
                    nodes: nodes.map(n => ({ email: n.email, gitBranch: n.gitBranch })),
                    severity
                };
                debug('Overlap detected:', fileId, nodes.map(n => n.email));
                emitter.emit('warning', event);
            }
        }

        // Detect resolved overlaps
        for (const fileId of previousOverlaps) {
            if (!newOverlaps.has(fileId)) {
                const event = { type: 'overlap-resolved', fileId };
                debug('Overlap resolved:', fileId);
                emitter.emit('warning', event);
            }
        }

        overlaps = newOverlaps;
    } catch (err) {
        debug('Early warning overlap check error:', err);
    }
}

function computeSeverity(fileId, nodes) {
    // Base: number of overlapping users minus 1
    let severity = nodes.length - 1;

    // Check if nodes are on different git branches
    const branches = new Set(nodes.map(n => n.gitBranch).filter(Boolean));
    if (branches.size > 1) {
        severity *= 2;
    }

    // Boost if multiple nodes edited very recently (active collision)
    const now = Date.now();
    const activeWindow = OVCSSETTINGS.OVERLAP_ACTIVE_WINDOW;
    const recentCount = nodes.filter(n => {
        if (!n.lastSeen) return false;
        return (now - new Date(n.lastSeen).getTime()) < activeWindow;
    }).length;
    if (recentCount >= 2) {
        severity *= 1.5;
    }

    return Math.round(severity * 10) / 10;
}

function getWarnings() {
    const result = [];
    for (const [fileId, data] of overlaps) {
        const nodes = [];
        for (const [nodeId, nodeData] of data.nodes) {
            nodes.push({ nodeId, ...nodeData });
        }
        result.push({
            fileId,
            nodes,
            firstSeen: data.firstSeen,
            severity: data.severity
        });
    }
    // Sort by severity descending
    result.sort((a, b) => b.severity - a.severity);
    return { overlaps: result, count: result.length };
}

function getHotspots(limit = 10) {
    const { overlaps: warnings } = getWarnings();
    return warnings.slice(0, limit);
}

function onWarning(callback) {
    emitter.on('warning', callback);
}

function removeWarningListener(callback) {
    emitter.off('warning', callback);
}

function shutdown() {
    if (presenceSub) {
        presenceSub.unsubscribe();
        presenceSub = null;
    }
    if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
    }
    overlaps.clear();
    debug('Early warning system shut down');
}

export {
    initEarlyWarning,
    computeOverlaps,
    getWarnings,
    getHotspots,
    onWarning,
    removeWarningListener,
    shutdown
};
