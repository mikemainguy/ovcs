import express from "express";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { diff3Merge } from 'node-diff3';
import { diffLines } from 'diff';
import { debug } from "../debug.js";
import { initVectorSync } from '../vectorSync.js';
import { setupSearchRoutes } from '../searchApi.js';
import { initPresence, getActiveNodes, getPresenceCollection } from '../presence.js';
import { fetchContentFromPeer } from '../p2p.js';
import { initEarlyWarning, getWarnings, getHotspots, onWarning, removeWarningListener } from '../earlyWarning.js';
import {
    initDB, getFilesCollection, getStoredMetadata, getWatchBaseDirectory,
    getSyncStatus, getScanStatus, setWatchBaseDirectory, setStoredMetadata
} from './database.js';
import { startPersistence } from './persistence.js';
import { collapseRevisionsAfterResolve } from './reconciliation.js';
import { sha256 } from './operations.js';

const __dirname = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
// Go up one level since we're now in store/
const projectRoot = path.resolve(__dirname, '..');

async function initWeb(metadata, pwd, port, options = {}) {
    setWatchBaseDirectory(path.resolve(options.baseDirectory || metadata.baseDirectory || '.'));
    setStoredMetadata(metadata);

    // 1. Initialize database — loads persisted data
    await initDB();

    // 2. Start periodic persistence
    startPersistence(getFilesCollection);

    // 3. Initialize vector sync (use baseDirectory so file paths resolve correctly)
    try {
        await initVectorSync(getWatchBaseDirectory());
        debug('Vector sync initialized for web');
    } catch (err) {
        debug('Error initializing vector sync:', err);
    }

    // 4. Initialize presence
    if (metadata.presence?.enabled && metadata.teamId) {
        try {
            await initPresence(metadata, pwd, { filesCollection: getFilesCollection(), baseDirectory: getWatchBaseDirectory() });
            debug('Presence initialized');
        } catch (err) {
            debug('Error initializing presence:', err);
        }
    }

    // 5. Initialize early warning system (overlap detection)
    if (metadata.presence?.enabled && metadata.teamId) {
        try {
            const presenceCollection = getPresenceCollection();
            if (presenceCollection) {
                initEarlyWarning(presenceCollection, getFilesCollection(), metadata.clientId || metadata.email);
                debug('Early warning system initialized');
            }
        } catch (err) {
            debug('Error initializing early warning:', err);
        }
    }

    // 6. Start web server (replication deferred until after chokidar scan)
    debug('Calling web()...');
    web(port, metadata, options);
    debug('initWeb complete');
}

function web(port, metadata = {}, options = {}) {
    const baseDirectory = path.resolve(options.baseDirectory || metadata.baseDirectory || '.');
    debug('web() starting...');
    const app = express();
    const filesCollection = getFilesCollection();

    app.get("/me", (req, res) => {
        res.json({
            email: metadata.email || null,
            clientId: metadata.clientId || null,
            teamId: metadata.teamId || null,
            mode: options.p2p ? 'p2p' : (metadata.sync?.enabled ? 'server' : 'local'),
            remote: metadata.remote || null,
            baseDirectory: baseDirectory,
            sync: metadata.sync || {},
            presence: { enabled: metadata.presence?.enabled || false },
            p2p: metadata.p2p || {}
        });
    });

    app.get("/info", async (req, res) => {
        const docs = await filesCollection.find().exec();
        const info = {
            db_name: 'localdb',
            doc_count: docs.length,
            storage: 'memory'
        };
        res.json(info);
    });

    app.get("/data", async (req, res) => {
        const docs = await filesCollection.find().exec();
        const rows = docs.map(doc => {
            const d = doc.toJSON();
            return { id: d.id, doc: d };
        });
        res.json({ total_rows: rows.length, rows });
    });

    app.get("/diff", async (req, res) => {
        const docs = await filesCollection.find().exec();
        const localClientId = metadata.clientId || metadata.email;

        // Build set of active clientIds from presence for filtering revisions.
        // Revision keys are raw clientId UUIDs; presence now stores clientId too.
        const activeNodes = await getActiveNodes();
        const activeClientIds = new Set();
        activeClientIds.add(localClientId); // Always include ourselves
        for (const n of activeNodes) {
            if (n.clientId) activeClientIds.add(n.clientId);
        }

        // Classify each document using revision hashes as source of truth.
        // Only considers revisions from nodes currently active in presence.
        function classifyDoc(doc) {
            const d = doc.toJSON ? doc.toJSON() : doc;
            if (!d.file || d.type !== 'file') return null;
            if (!d.revisions) return null;

            // Filter to only active nodes' revisions (revision keys are clientIds)
            const revKeys = Object.keys(d.revisions).filter(k => activeClientIds.has(k));
            if (revKeys.length === 0) return null;

            const hashes = new Set(revKeys.map(k => d.revisions[k].hash));
            if (hashes.size <= 1) return null;

            // Sub-classify: is local hash empty, remote hash empty, or both present but different?
            const localHash = d.revisions[localClientId]?.hash;
            const otherKeys = revKeys.filter(k => k !== localClientId);
            const remoteHasEmpty = otherKeys.some(k => d.revisions[k].hash === '');

            let diffType = 'conflict';
            if (localHash === '') {
                diffType = 'missingLocally';
            } else if (remoteHasEmpty) {
                diffType = 'missingRemotely';
            }

            return { doc: d, diffType };
        }

        const classified = docs.map(classifyDoc).filter(Boolean);

        // Summary mode
        if (req.query.summary === 'true') {
            const summary = { total: classified.length, missingLocally: 0, missingRemotely: 0, conflicts: 0 };
            const files = classified.map(c => {
                summary[c.diffType === 'conflict' ? 'conflicts' : c.diffType]++;
                return { file: c.doc.file, type: c.diffType };
            });
            return res.json({ ...summary, files });
        }

        // Filtering
        const filterType = req.query.type;
        const filtered = filterType ? classified.filter(c => c.diffType === filterType) : classified;

        // Summary counts
        const summary = { missingLocally: 0, missingRemotely: 0, conflicts: 0 };
        classified.forEach(c => { summary[c.diffType === 'conflict' ? 'conflicts' : c.diffType]++; });

        // Pagination
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const total = filtered.length;
        const pages = Math.ceil(total / limit);
        const start = (page - 1) * limit;
        const paged = filtered.slice(start, start + limit);

        const items = paged.map(c => ({
            id: c.doc.id,
            missingLocally: c.diffType === 'missingLocally',
            missingRemotely: c.diffType === 'missingRemotely',
            diffType: c.diffType,
            doc: c.doc
        }));

        res.json({ total, page, limit, pages, summary, items });
    });

    app.get("/", async (req, res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        const file = fs.readFileSync(projectRoot + '/web/index.html');
        res.send(file.toString('utf-8'));
    });
    app.get("/diff.html", (req, res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        const file = fs.readFileSync(projectRoot + '/web/diff.html');
        res.send(file.toString('utf-8'));
    });
    app.get("/ready", (req, res) => {
        res.json(getScanStatus());
    });
    app.get("/sync-status", (req, res) => {
        res.json(getSyncStatus());
    });
    app.get("/diff-events", (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        // Send initial keepalive
        res.write('data: {"type":"connected"}\n\n');

        const sub = filesCollection.$.subscribe(changeEvent => {
            const file = changeEvent.documentData?.file || changeEvent.documentId;
            const data = JSON.stringify({ file, operation: changeEvent.operation });
            res.write(`data: ${data}\n\n`);
        });

        req.on('close', () => sub.unsubscribe());
    });

    // Early warning endpoints
    app.get("/warnings", (req, res) => {
        res.json(getWarnings());
    });
    app.get("/hotspots", (req, res) => {
        const limit = Math.max(1, parseInt(req.query.limit) || 10);
        res.json(getHotspots(limit));
    });
    app.get("/warning-events", (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write('data: {"type":"connected"}\n\n');

        const handler = (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        onWarning(handler);

        req.on('close', () => removeWarningListener(handler));
    });

    app.get("/content/:fileId", async (req, res) => {
        const { fileId } = req.params;
        debug(`[Content] Request for ${fileId}`);
        try {
            const doc = await filesCollection.findOne(fileId).exec();
            const d = doc?.toJSON();

            // 1. Check local filesystem
            if (d?.file) {
                const filePath = path.resolve(baseDirectory, d.file);
                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    debug(`[Content] Serving from local disk (${content.length} chars)`);
                    return res.json({ fileId, content, source: 'local-disk' });
                }
            }

            // 2. Try fetching from P2P peer
            const peerContent = await fetchContentFromPeer(fileId);
            if (peerContent) {
                debug(`[Content] Serving from peer`);
                return res.json({ fileId, content: peerContent, source: 'peer' });
            }

            res.status(404).json({ error: 'Content not available' });
        } catch (err) {
            console.error(`[Content] Error:`, err.message);
            res.status(500).json({ error: err.message });
        }
    });
    // Helper: fetch content for a file from any available source
    async function getFileContent(fileId) {
        const doc = await filesCollection.findOne(fileId).exec();
        const d = doc?.toJSON();
        if (!d?.file) return null;

        // 1. Disk
        const filePath = path.resolve(baseDirectory, d.file);
        if (fs.existsSync(filePath)) {
            return { file: d.file, content: fs.readFileSync(filePath), source: 'local-disk' };
        }
        // 2. Peer
        const peerContent = await fetchContentFromPeer(fileId);
        if (peerContent) {
            return { file: d.file, content: Buffer.from(peerContent, 'utf-8'), source: 'peer' };
        }
        return null;
    }

    // 3-way merge check using git (with 2-way heuristic fallback)
    async function performMergeCheck(fileId) {
        const doc = await filesCollection.findOne(fileId).exec();
        if (!doc) return { error: 'File not found' };
        const d = doc.toJSON();
        if (!d.revisions) return { error: 'No revisions' };

        const localClientId = metadata.clientId || metadata.email;
        const localRev = d.revisions[localClientId];
        const otherKeys = Object.keys(d.revisions).filter(k => k !== localClientId);
        if (otherKeys.length === 0) return { error: 'No remote revisions' };

        // Get local content from disk
        const filePath = path.resolve(baseDirectory, d.file);
        let localContent = '';
        if (fs.existsSync(filePath)) {
            localContent = fs.readFileSync(filePath, 'utf-8');
        }

        // Get remote content from peer
        let remoteContent = '';
        const peerContent = await fetchContentFromPeer(fileId);
        if (peerContent) {
            remoteContent = peerContent;
        }

        // If one side is empty (missing), it's not mergeable in the traditional sense
        if (!localContent && !remoteContent) return { mergeable: false, reason: 'Both sides empty', localContent, remoteContent };
        if (!localContent || !remoteContent) return { mergeable: false, reason: 'One side missing', localContent, remoteContent };

        // Try git 3-way merge if both revisions have commitHash
        const storedMetadata = getStoredMetadata();
        const remoteRev = d.revisions[otherKeys[0]];
        if (storedMetadata?.git?.inRepo && localRev?.commitHash && remoteRev?.commitHash) {
            try {
                const baseCommit = execSync(
                    `git merge-base ${localRev.commitHash} ${remoteRev.commitHash}`,
                    { cwd: baseDirectory, stdio: ['pipe', 'pipe', 'pipe'] }
                ).toString().trim();

                const baseContent = execSync(
                    `git show ${baseCommit}:${d.file}`,
                    { cwd: baseDirectory, stdio: ['pipe', 'pipe', 'pipe'] }
                ).toString();

                const result = diff3Merge(
                    localContent.split('\n'),
                    baseContent.split('\n'),
                    remoteContent.split('\n')
                );

                const hasConflict = result.some(r => r.conflict);
                if (!hasConflict) {
                    const mergedContent = result.flatMap(r => r.ok || []).join('\n');
                    return { mergeable: true, mergedContent, strategy: 'git-3way', localContent, remoteContent };
                }
                return { mergeable: false, strategy: 'git-3way', conflictCount: result.filter(r => r.conflict).length, localContent, remoteContent };
            } catch (err) {
                debug('[MergeCheck] Git 3-way merge failed, falling back to heuristic:', err.message);
            }
        }

        // Fallback: 2-way heuristic using diff
        const changes = diffLines(localContent, remoteContent);
        // Check if changes are non-overlapping (all purely added or purely removed)
        const hasOverlap = changes.some(c => c.added && changes.some(o => o.removed && o !== c));
        // Simple heuristic: if there are both additions and removals, assume not cleanly mergeable
        const addedOnly = changes.every(c => !c.removed || !c.added);
        if (addedOnly) {
            // Reconstruct merged content (keep all lines)
            const mergedContent = changes.map(c => c.value).join('');
            return { mergeable: true, mergedContent, strategy: 'heuristic-2way', localContent, remoteContent };
        }
        return { mergeable: false, strategy: 'heuristic-2way', localContent, remoteContent };
    }

    app.get("/merge-check/:fileId", async (req, res) => {
        const { fileId } = req.params;
        try {
            const result = await performMergeCheck(fileId);
            res.json(result);
        } catch (err) {
            console.error('[MergeCheck] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/merge/:fileId", async (req, res) => {
        const { fileId } = req.params;
        try {
            const result = await performMergeCheck(fileId);
            if (!result.mergeable) {
                return res.status(409).json({ error: 'Not mergeable', ...result });
            }

            const doc = await filesCollection.findOne(fileId).exec();
            const d = doc?.toJSON();
            if (!d?.file) return res.status(404).json({ error: 'File not found' });

            const filePath = path.resolve(baseDirectory, d.file);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, result.mergedContent);
            debug(`[Merge] Wrote merged ${d.file} (${result.mergedContent.length} bytes, strategy: ${result.strategy})`);

            // Collapse revisions now that conflict is resolved
            await collapseRevisionsAfterResolve(fileId);

            res.json({
                success: true,
                file: d.file,
                strategy: result.strategy,
                bytesWritten: result.mergedContent.length
            });
        } catch (err) {
            console.error('[Merge] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Pull a single file from peer and write to local disk
    app.post("/pull/:fileId", async (req, res) => {
        const { fileId } = req.params;
        debug(`[Pull] Pulling file ${fileId}`);
        try {
            const result = await getFileContent(fileId);
            if (!result) {
                return res.status(404).json({ error: 'Content not available from any source' });
            }

            const filePath = path.resolve(baseDirectory, result.file);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, result.content);
            debug(`[Pull] Wrote ${result.file} (${result.content.length} bytes, source: ${result.source})`);

            // Collapse revisions now that we have the pulled content
            await collapseRevisionsAfterResolve(fileId);

            res.json({
                fileId,
                file: result.file,
                source: result.source,
                bytesWritten: result.content.length
            });
        } catch (err) {
            console.error(`[Pull] Error:`, err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Pull all files missing locally
    app.post("/pull-missing", async (req, res) => {
        debug(`[Pull] Pulling all missing files`);
        try {
            const docs = await filesCollection.find().exec();
            const localClientId = metadata.clientId || metadata.email;
            const pulled = [];
            const failed = [];

            for (const doc of docs) {
                const d = doc.toJSON();
                if (!d.file || d.type !== 'file') continue;

                const filePath = path.resolve(baseDirectory, d.file);
                if (fs.existsSync(filePath)) continue; // Not missing

                try {
                    const result = await getFileContent(d.id);
                    if (result) {
                        const dir = path.dirname(filePath);
                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }
                        fs.writeFileSync(filePath, result.content);
                        pulled.push({ file: d.file, source: result.source, bytes: result.content.length });
                        debug(`[Pull] Wrote ${d.file} (${result.content.length} bytes)`);
                    } else {
                        failed.push({ file: d.file, reason: 'Content not available' });
                    }
                } catch (err) {
                    failed.push({ file: d.file, reason: err.message });
                }
            }

            debug(`[Pull] Done: ${pulled.length} pulled, ${failed.length} failed`);
            res.json({ total: pulled.length + failed.length, pulled, failed });
        } catch (err) {
            console.error(`[Pull] Error:`, err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.get("/presence", async (req, res) => {
        const nodes = await getActiveNodes();
        res.json(nodes);
    });

    // Setup vector search routes (pass a compatibility wrapper)
    const dbCompat = {
        allDocs: async (opts) => {
            const docs = await filesCollection.find().exec();
            return {
                rows: docs.map(d => ({ id: d.id, doc: d.toJSON() }))
            };
        }
    };
    setupSearchRoutes(app, dbCompat);

    const WEB_PORT = port || process.env.OVCS_WEB_PORT || 3001;
    try {
        app.listen(WEB_PORT, () => {
            console.log('');
            console.log('╔════════════════════════════════════════════════════════════╗');
            console.log('║                    OVCS Client Started                     ║');
            console.log('╠════════════════════════════════════════════════════════════╣');
            console.log(`║  Dashboard:     http://localhost:${WEB_PORT}/`.padEnd(61) + '║');
            console.log(`║  Diff viewer:   http://localhost:${WEB_PORT}/diff.html`.padEnd(61) + '║');
            console.log(`║  Data:          http://localhost:${WEB_PORT}/data`.padEnd(61) + '║');
            console.log(`║  Diff JSON:     http://localhost:${WEB_PORT}/diff`.padEnd(61) + '║');
            console.log(`║  Presence:      http://localhost:${WEB_PORT}/presence`.padEnd(61) + '║');
            console.log(`║  Sync status:   http://localhost:${WEB_PORT}/sync-status`.padEnd(61) + '║');
            console.log('╚════════════════════════════════════════════════════════════╝');
            console.log('');
        });
    } catch (err) {
        console.error('error starting web server', err);
        console.error('is the port already in use?');
        console.error('try setting OVCS_WEB_PORT to a different port');
    }
}

export { web, initWeb };
