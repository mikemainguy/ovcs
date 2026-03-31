console.log('=== dataStore.js loading ===');
import { addRxPlugin, createRxDatabase } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

addRxPlugin(RxDBDevModePlugin);

function getStorage() {
    return wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
}
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import {debug} from "./debug.js";
import express from "express";
import {OVCSSETTINGS} from "./const.js";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
import { syncFileToVectorDB, removeFileFromVectorDB, initVectorSync, isVectorSyncInitialized } from './vectorSync.js';
import { setupSearchRoutes } from './searchApi.js';
import { initPresence, getActiveNodes, updateActiveFiles, getPresenceCollection } from './presence.js';
import { replicateServer } from 'rxdb-server/plugins/replication-server';
import { initP2P, getP2PStatus, fetchContentFromPeer } from './p2p.js';
import { diff3Merge } from 'node-diff3';
import { diffLines } from 'diff';

// Track recently changed files for presence
let recentActiveFiles = [];
const MAX_ACTIVE_FILES = 20;

let db = null;
let filesCollection = null;
let syncHandler = null;
let dbInitPromise = null;
let syncStatus = { state: 'disconnected', lastSync: null, error: null };
let watchBaseDirectory = '.';
let storedMetadata = null;
let reconcileTimer = null;
let scanStatus = { ready: false, fileCount: 0 };

function setScanStatus(ready, fileCount) {
    scanStatus = { ready, fileCount };
}

function getSyncStatus() {
    return syncStatus;
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function getGitHead() {
    if (!storedMetadata?.git?.inRepo) return null;
    try {
        return execSync('git rev-parse HEAD', { cwd: watchBaseDirectory, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    } catch (e) {
        return null;
    }
}

// RxDB Schema for file documents (metadata-only — no content stored)
const fileSchema = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id:        { type: 'string', maxLength: 100 },
        file:      { type: 'string' },
        type:      { type: 'string' },
        hash:      { type: 'string' },
        revisions: { type: 'object' },
        updatedAt: { type: 'number' }
    },
    required: ['id', 'file', 'type', 'hash']
};

// Conflict handler: merges per-user revisions, keeps newest hash
const ovcsConflictHandler = {
    isEqual(a, b) {
        return a.hash === b.hash && a.updatedAt === b.updatedAt;
    },
    resolve(input) {
        const master = input.assumedMasterState;
        const incoming = input.newDocumentState;

        // If no master state, incoming wins
        if (!master) return incoming;
        // If no incoming, master wins
        if (!incoming) return master;

        const merged = { ...master };

        // Merge revisions maps — keep all users' latest revisions
        merged.revisions = { ...(master.revisions || {}), ...(incoming.revisions || {}) };

        // For overlapping users, keep the newer revision
        if (master.revisions && incoming.revisions) {
            for (const email of Object.keys(incoming.revisions)) {
                if (master.revisions[email]) {
                    const masterDate = new Date(master.revisions[email].updated || 0);
                    const incomingDate = new Date(incoming.revisions[email].updated || 0);
                    if (incomingDate > masterDate) {
                        merged.revisions[email] = incoming.revisions[email];
                    } else {
                        merged.revisions[email] = master.revisions[email];
                    }
                }
            }
        }

        // Use the most recent hash
        if ((incoming.updatedAt || 0) > (master.updatedAt || 0)) {
            merged.hash = incoming.hash;
            merged.updatedAt = incoming.updatedAt;
        }

        return merged;
    }
};

// Initialize database once - must be called before any other db operations
async function initDB() {
    if (db) return db;
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = (async () => {
        db = await createRxDatabase({
            name: `${OVCSSETTINGS.ROOT_DIR}/localdb`,
            storage: getStorage(),
            multiInstance: false
        });

        await db.addCollections({
            files: {
                schema: fileSchema,
                conflictHandler: ovcsConflictHandler
            }
        });

        filesCollection = db.files;

        // Load persisted data if it exists
        await loadPersistedData();

        const docs = await filesCollection.find().exec();
        console.log(`Database initialized: localdb (${docs.length} docs)`);
        return db;
    })();

    return dbInitPromise;
}

// Persist data to disk as JSON (since we use memory storage)
const PERSIST_FILE = `${OVCSSETTINGS.ROOT_DIR}/rxdb-data.json`;

async function persistData() {
    if (!filesCollection) return;
    try {
        const docs = await filesCollection.find().exec();
        const data = docs.map(d => d.toJSON());
        fs.writeFileSync(PERSIST_FILE, JSON.stringify(data));
        debug(`Persisted ${data.length} docs to disk`);
    } catch (err) {
        debug('Error persisting data:', err);
    }
}

async function loadPersistedData() {
    if (!filesCollection) return;
    try {
        if (fs.existsSync(PERSIST_FILE)) {
            const raw = fs.readFileSync(PERSIST_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data.length > 0) {
                await filesCollection.bulkInsert(data);
                debug(`Loaded ${data.length} docs from disk`);
            }
        }
    } catch (err) {
        debug('Error loading persisted data:', err);
    }
}

// Periodic persistence (every 30 seconds)
let persistTimer = null;
function startPersistence() {
    if (persistTimer) return;
    persistTimer = setInterval(() => persistData(), 30000);
}

function stopPersistence() {
    if (persistTimer) {
        clearInterval(persistTimer);
        persistTimer = null;
    }
    // Final persist on stop
    persistData();
}

// Reconcile DB state against the local filesystem.
// For every file doc, ensures this client has a revision reflecting current disk state.
// Never mutates doc.type or doc.hash — only updates the local client's revision entry.
async function reconcileFilesystem(metadata, baseDirectory) {
    if (!filesCollection) return;
    const docs = await filesCollection.find().exec();
    let updated = 0, unchanged = 0;
    const clientKey = metadata.clientId || metadata.email;

    for (const doc of docs) {
        const d = doc.toJSON();
        if (!d.file || d.type === 'dir') continue;

        // Compute current local disk state
        const filePath = path.resolve(baseDirectory, d.file);
        let localHash = '';
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath);
                localHash = sha256(content);
            } catch (err) {
                debug('Reconcile read error:', d.file, err.message);
                continue;
            }
        }

        // Skip if our revision already matches
        if (d.revisions?.[clientKey]?.hash === localHash) {
            unchanged++;
            continue;
        }

        // Update only our revision entry
        const commitHash = getGitHead();
        const revisions = d.revisions ? JSON.parse(JSON.stringify(d.revisions)) : {};
        revisions[clientKey] = {
            email: metadata.email,
            hash: localHash,
            updated: new Date().toISOString(),
            ...(commitHash && { commitHash })
        };
        await doc.patch({
            revisions,
            updatedAt: Date.now()
        });
        updated++;
    }
    console.log(`Reconciliation: ${updated} updated, ${unchanged} unchanged (${docs.length} total)`);
}

// Handle incoming remote doc changes — add local revision showing current disk state
async function onRemoteDocChange(changeEvent) {
    if (changeEvent.isLocal) return;
    if (!storedMetadata || !filesCollection) return;

    const docData = changeEvent.documentData;
    if (!docData?.file || docData.type === 'dir') return;

    const clientKey = storedMetadata.clientId || storedMetadata.email;

    // Compute current local state
    const filePath = path.resolve(watchBaseDirectory, docData.file);
    let localHash = '';
    if (fs.existsSync(filePath)) {
        try {
            const content = fs.readFileSync(filePath);
            localHash = sha256(content);
        } catch (err) {
            debug('[Reconcile] Error reading file:', docData.file, err.message);
            return;
        }
    }

    // If our revision already matches current disk hash, skip (prevents replication loops)
    if (docData.revisions?.[clientKey]?.hash === localHash) {
        return;
    }

    const doc = await filesCollection.findOne(docData.id).exec();
    if (!doc) return;

    // Deep-copy to strip RxDB proxy objects (avoids structured clone errors)
    const commitHash = getGitHead();
    const revisions = doc.revisions ? JSON.parse(JSON.stringify(doc.revisions)) : {};
    revisions[clientKey] = {
        email: storedMetadata.email,
        hash: localHash,
        updated: new Date().toISOString(),
        ...(commitHash && { commitHash })
    };

    await doc.patch({
        revisions,
        updatedAt: Date.now()
    });
    debug(`[Reconcile] Added local revision for ${docData.file} (local: ${localHash.substring(0, 8) || 'missing'})`);
}

// Periodic reconciliation — safety net for missed chokidar events
function startReconciliationTimer(metadata, baseDirectory) {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(async () => {
        try {
            await reconcileFilesystem(metadata, baseDirectory);
        } catch (err) {
            debug('Periodic reconciliation error:', err);
        }
    }, OVCSSETTINGS.RECONCILE_INTERVAL);
}

function stopReconciliationTimer() {
    if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
    }
}

async function saveData(data, metadata) {
    if (!filesCollection) {
        throw new Error('Database not initialized. Call initDB() first.');
    }

    // Handle delete immediately - remove from vector DB
    if (data.type === 'delete') {
        removeFileFromVectorDB(data.id).catch(err => {
            debug('Vector delete error:', err);
        });
    }

    const docId = sha256(data.id);
    const now = new Date().toISOString();

    try {
        const existing = await filesCollection.findOne(docId).exec();

        if (existing) {
            debug('existing', existing.toJSON());
            if (existing.type === data.type && existing.hash === data.hash) {
                debug('no change', data.id);
                return;
            }

            // Build updated revisions — keyed by clientId for uniqueness
            const clientKey = metadata.clientId || metadata.email;
            const revisions = existing.revisions ? JSON.parse(JSON.stringify(existing.revisions)) : {};
            const commitHash = getGitHead();
            revisions[clientKey] = {
                email: metadata.email,
                hash: data.hash,
                updated: now,
                ...(commitHash && { commitHash })
            };

            await existing.patch({
                type: data.type,
                hash: data.hash,
                revisions: revisions,
                updatedAt: Date.now()
            });

            debug('Updated document:', docId);
        } else {
            // New file - create document
            debug('new file', data.id);
            const commitHash = getGitHead();
            await filesCollection.insert({
                id: docId,
                file: data.id,
                type: data.type,
                hash: data.hash,
                revisions: {
                    [metadata.clientId || metadata.email]: {
                        email: metadata.email,
                        hash: data.hash,
                        updated: now,
                        ...(commitHash && { commitHash })
                    }
                },
                updatedAt: Date.now()
            });
        }

        // Sync to vector DB after successful update (read content from disk)
        if (data.type === 'file') {
            syncFileToVectorDB(data, metadata).catch(err => {
                debug('Vector sync error:', err);
            });
        }
    } catch (err) {
        debug('error saving data', err);
    }

    // Update presence with recently changed files
    if (data.id) {
        recentActiveFiles = recentActiveFiles.filter(f => f !== data.id);
        recentActiveFiles.unshift(data.id);
        if (recentActiveFiles.length > MAX_ACTIVE_FILES) {
            recentActiveFiles = recentActiveFiles.slice(0, MAX_ACTIVE_FILES);
        }
        updateActiveFiles(recentActiveFiles).catch(err => {
            debug('Presence active files update error:', err);
        });
    }
}

async function initWeb(metadata, pwd, port, options = {}) {
    watchBaseDirectory = path.resolve(options.baseDirectory || metadata.baseDirectory || '.');
    storedMetadata = metadata;

    // 1. Initialize database — loads persisted data
    await initDB();

    // 2. Start periodic persistence
    startPersistence();

    // 3. Initialize vector sync (use baseDirectory so file paths resolve correctly)
    try {
        await initVectorSync(watchBaseDirectory);
        debug('Vector sync initialized for web');
    } catch (err) {
        debug('Error initializing vector sync:', err);
    }

    // 4. Initialize presence
    if (metadata.presence?.enabled && metadata.teamId) {
        try {
            await initPresence(metadata, pwd, { filesCollection, baseDirectory: watchBaseDirectory });
            debug('Presence initialized');
        } catch (err) {
            debug('Error initializing presence:', err);
        }
    }

    // 5. Start web server (replication deferred until after chokidar scan)
    console.log('Calling web()...');
    web(port, metadata, options);
    console.log('initWeb complete');
}

// Start replication — called AFTER chokidar initial scan completes
async function startReplication(options = {}) {
    const metadata = storedMetadata;
    if (!metadata) return;

    // Reconcile DB against filesystem now that scan is done
    await reconcileFilesystem(metadata, watchBaseDirectory);

    // Start P2P or server replication
    if (options.p2p && metadata.teamId) {
        const signalingUrl = metadata.p2p?.signalingServer || metadata.remote?.replace(/^https/, 'wss').replace(/^http/, 'ws').replace(/\/[^/]*$/, '/signaling');
        if (signalingUrl) {
            try {
                await initP2P({
                    filesCollection,
                    presenceCollection: getPresenceCollection(),
                    signalingServerUrl: signalingUrl,
                    teamId: metadata.teamId,
                    baseDirectory: watchBaseDirectory,
                    metadata
                });
                debug('P2P replication initialized');
            } catch (err) {
                debug('Error initializing P2P replication:', err);
            }
        } else {
            console.error('P2P mode requires a signaling server URL (set p2p.signalingServer in ovcs.json or provide remote URL)');
        }
    } else if (metadata.sync?.enabled && metadata.remote) {
        try {
            await initRemoteSync(metadata);
            debug('Remote sync initialized');
        } catch (err) {
            debug('Error initializing remote sync:', err);
        }
    }

    // Start periodic reconciliation timer (safety net)
    startReconciliationTimer(metadata, watchBaseDirectory);
    console.log('Replication started');
}

function web(port, metadata = {}, options = {}) {
    const baseDirectory = path.resolve(options.baseDirectory || metadata.baseDirectory || '.');
    console.log('web() starting...');
    const app = express();

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

        // Classify each document using revision hashes as source of truth
        function classifyDoc(doc) {
            const d = doc.toJSON ? doc.toJSON() : doc;
            if (!d.file || d.type !== 'file') return null;
            if (!d.revisions) return null;

            const revKeys = Object.keys(d.revisions);
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
        const file = fs.readFileSync(__dirname + '/web/index.html');
        res.send(file.toString('utf-8'));
    });
    app.get("/diff.html", (req, res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        const file = fs.readFileSync(__dirname + '/web/diff.html');
        res.send(file.toString('utf-8'));
    });
    app.get("/ready", (req, res) => {
        res.json(scanStatus);
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
            console.log(`[Merge] Wrote merged ${d.file} (${result.mergedContent.length} bytes, strategy: ${result.strategy})`);

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
        console.log(`[Pull] Pulling file ${fileId}`);
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
            console.log(`[Pull] Wrote ${result.file} (${result.content.length} bytes, source: ${result.source})`);

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
        console.log(`[Pull] Pulling all missing files`);
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
                        console.log(`[Pull] Wrote ${d.file} (${result.content.length} bytes)`);
                    } else {
                        failed.push({ file: d.file, reason: 'Content not available' });
                    }
                } catch (err) {
                    failed.push({ file: d.file, reason: err.message });
                }
            }

            console.log(`[Pull] Done: ${pulled.length} pulled, ${failed.length} failed`);
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

async function initRemoteSync(metadata, retryCount = 0) {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = Math.pow(2, retryCount) * 1000;

    if (!metadata.remote || !metadata.sync?.enabled) {
        console.log('Remote sync disabled or no remote configured');
        return;
    }

    if (!filesCollection) {
        throw new Error('Database not initialized. Call initDB() first.');
    }

    syncStatus.state = 'connecting';
    syncStatus.error = null;

    // Derive server base URL from metadata.remote
    // metadata.remote is like "http://localhost:5984/ovcs" — use the base URL
    const serverUrl = metadata.remote.replace(/\/[^/]*$/, '');
    console.log(`Connecting to remote: ${serverUrl}`);

    try {
        // Test connection
        const response = await fetch(`${serverUrl}/ovcs/status`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        console.log(`Remote server connected: ${status.status}`);
    } catch (err) {
        if (retryCount < MAX_RETRIES) {
            console.log(`Connection failed, retrying in ${RETRY_DELAY/1000}s... (${retryCount + 1}/${MAX_RETRIES})`);
            syncStatus.state = 'connecting';
            syncStatus.error = `Retry ${retryCount + 1}/${MAX_RETRIES}: ${err.message}`;
            setTimeout(() => initRemoteSync(metadata, retryCount + 1), RETRY_DELAY);
            return;
        }
        console.error(`Failed to connect after ${MAX_RETRIES} attempts: ${err.message}`);
        syncStatus.state = 'error';
        syncStatus.error = `Failed after ${MAX_RETRIES} attempts: ${err.message}`;
        return;
    }

    // Start RxDB server replication for files
    const replicationUrl = `${serverUrl}/replication/files/0`;
    console.log(`Replication URL: ${replicationUrl}`);
    try {
        syncHandler = replicateServer({
            collection: filesCollection,
            replicationIdentifier: 'ovcs-files-sync',
            url: replicationUrl,
            live: metadata.sync.live !== false,
            push: {},
            pull: {}
        });

        syncHandler.error$.subscribe(err => {
            console.error('Sync error:', JSON.stringify({
                message: err.message,
                direction: err.direction,
                code: err.code,
                errors: err.innerErrors ? err.innerErrors.map(e => ({ name: e.name, message: e.message?.substring(0, 200) })) : undefined
            }, null, 2));
            syncStatus.state = 'error';
            syncStatus.error = err.message || String(err);
        });

        syncHandler.active$.subscribe(active => {
            if (active) {
                syncStatus.state = 'syncing';
                console.log('Sync active');
            } else {
                syncStatus.state = 'synced';
                syncStatus.lastSync = new Date().toISOString();
                syncStatus.error = null;
                console.log('Sync paused (up to date)');
            }
        });

        // Listen for incoming remote docs and add local revision
        filesCollection.$.subscribe(changeEvent => onRemoteDocChange(changeEvent));

        console.log('RxDB server replication started');
    } catch (err) {
        console.error('Error starting replication:', err);
        syncStatus.state = 'error';
        syncStatus.error = err.message;
    }
}

function stopRemoteSync() {
    if (syncHandler) {
        syncHandler.cancel();
        syncHandler = null;
        debug('Remote sync stopped');
    }
}

// Conflict resolution is now handled by RxDB's conflictHandler on the schema
async function resolveConflicts() {
    // No-op: RxDB handles conflicts via the conflictHandler defined on the collection
    debug('Conflict resolution is handled by RxDB conflictHandler');
}

export {saveData, initWeb, startReplication, initRemoteSync, stopRemoteSync, initDB, getSyncStatus, resolveConflicts, stopPersistence, stopReconciliationTimer, onRemoteDocChange, setScanStatus, filesCollection};
