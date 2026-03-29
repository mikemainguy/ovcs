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
import {debug} from "./debug.js";
import express from "express";
import {OVCSSETTINGS} from "./const.js";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
import { syncFileToVectorDB, removeFileFromVectorDB, initVectorSync, isVectorSyncInitialized } from './vectorSync.js';
import { setupSearchRoutes } from './searchApi.js';
import { initPresence, getActiveNodes, updateActiveFiles } from './presence.js';
import { replicateServer } from 'rxdb-server/plugins/replication-server';
import { initP2P, getP2PStatus } from './p2p.js';
import { decompress } from './compression.js';

// Track recently changed files for presence
let recentActiveFiles = [];
const MAX_ACTIVE_FILES = 20;

let db = null;
let filesCollection = null;
let syncHandler = null;
let dbInitPromise = null;
let syncStatus = { state: 'disconnected', lastSync: null, error: null };

function getSyncStatus() {
    return syncStatus;
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// RxDB Schema for file documents
const fileSchema = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id:        { type: 'string', maxLength: 100 },
        file:      { type: 'string' },
        type:      { type: 'string' },
        hash:      { type: 'string' },
        base64:    { type: 'string' },
        revisions: { type: 'object' },
        compression: { type: 'string' },
        updatedAt: { type: 'number' }
    },
    required: ['id', 'file', 'type', 'hash']
};

// Conflict handler: merges per-user revisions, keeps newest content
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

        // Use the most recent content
        if ((incoming.updatedAt || 0) > (master.updatedAt || 0)) {
            merged.hash = incoming.hash;
            merged.base64 = incoming.base64;
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
            const revisions = existing.revisions ? { ...existing.revisions } : {};
            revisions[clientKey] = {
                email: metadata.email,
                hash: data.hash,
                updated: now,
                content: data.base64
            };

            await existing.patch({
                type: data.type,
                hash: data.hash,
                base64: data.base64,
                compression: data.compression || existing.compression || 'none',
                revisions: revisions,
                updatedAt: Date.now()
            });

            debug('Updated document:', docId);
        } else {
            // New file - create document
            debug('new file', data.id);
            await filesCollection.insert({
                id: docId,
                file: data.id,
                type: data.type,
                hash: data.hash,
                base64: data.base64 || '',
                compression: data.compression || 'none',
                revisions: {
                    [metadata.clientId || metadata.email]: {
                        email: metadata.email,
                        hash: data.hash,
                        updated: now,
                        content: data.base64
                    }
                },
                updatedAt: Date.now()
            });
        }

        // Sync to vector DB after successful update
        if (data.type === 'file' && data.base64) {
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
    // Initialize database first - before anything else
    await initDB();

    // Start periodic persistence
    startPersistence();

    // Initialize vector sync
    try {
        await initVectorSync(pwd);
        debug('Vector sync initialized for web');
    } catch (err) {
        debug('Error initializing vector sync:', err);
    }

    if (options.p2p && metadata.teamId) {
        // P2P mode: use WebRTC replication via signaling server
        const signalingUrl = metadata.p2p?.signalingServer || metadata.remote?.replace(/^http/, 'ws').replace(/\/[^/]*$/, '/signaling');
        if (signalingUrl) {
            try {
                await initP2P({
                    filesCollection,
                    presenceCollection: null, // Presence is managed separately in P2P
                    signalingServerUrl: signalingUrl,
                    teamId: metadata.teamId
                });
                debug('P2P replication initialized');
            } catch (err) {
                debug('Error initializing P2P replication:', err);
            }
        } else {
            console.error('P2P mode requires a signaling server URL (set p2p.signalingServer in ovcs.json or provide remote URL)');
        }
    } else if (metadata.sync?.enabled && metadata.remote) {
        // Server mode: use RxDB server replication
        try {
            await initRemoteSync(metadata);
            debug('Remote sync initialized');
        } catch (err) {
            debug('Error initializing remote sync:', err);
        }
    }

    // Initialize presence (works in both modes)
    if (metadata.presence?.enabled && metadata.teamId) {
        try {
            await initPresence(metadata, pwd);
            debug('Presence initialized');
        } catch (err) {
            debug('Error initializing presence:', err);
        }
    }

    console.log('Calling web()...');
    web(port, metadata, options);
    console.log('initWeb complete');
}

// Deserialize revisions by decoding and decompressing base64 content to readable text
async function deserializeRevisions(doc) {
    const deserialized = { ...doc };
    const method = doc.compression || 'none';

    // Decode main base64 content if present
    if (doc.base64) {
        try {
            const raw = await decompress(doc.base64, method);
            deserialized.content = raw.toString('utf-8');
        } catch (err) {
            deserialized.content = '[binary content]';
        }
    }

    // Decode revision contents
    if (doc.revisions) {
        deserialized.revisions = {};
        for (const [email, revision] of Object.entries(doc.revisions)) {
            deserialized.revisions[email] = { ...revision };
            if (revision.content) {
                try {
                    const raw = await decompress(revision.content, method);
                    deserialized.revisions[email].content = raw.toString('utf-8');
                } catch (err) {
                    deserialized.revisions[email].content = '[binary content]';
                }
            }
        }
    }
    return deserialized;
}

function web(port, metadata = {}, options = {}) {
    const baseDirectory = path.resolve(options.baseDirectory || metadata.baseDirectory || '.');
    console.log('web() starting...');
    const app = express();

    app.get("/me", (req, res) => {
        res.json({ email: metadata.email || null, clientId: metadata.clientId || null });
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
        const deserialize = req.query.deserialize !== 'false';
        const includeContent = req.query.content === 'true';
        const rows = await Promise.all(docs.map(async doc => {
            const d = doc.toJSON();
            const out = deserialize ? await deserializeRevisions(d) : { ...d };
            // Strip large fields by default to avoid response too large
            if (!includeContent) {
                delete out.base64;
                delete out.content;
                if (out.revisions) {
                    for (const email of Object.keys(out.revisions)) {
                        delete out.revisions[email].content;
                    }
                }
            }
            return { id: d.id, doc: out };
        }));
        res.json({ total_rows: rows.length, rows });
    });

    app.get("/diff", async (req, res) => {
        const docs = await filesCollection.find().exec();
        const deserialize = req.query.deserialize !== 'false';
        const filtered = docs.filter(doc => {
            const d = doc.toJSON();
            if (!d.file || d.type !== 'file') return false;

            // Check if file is missing locally
            const filePath = path.resolve(baseDirectory, d.file);
            if (!fs.existsSync(filePath)) return true;

            // Check for divergent revisions
            if (!d.revisions) return false;
            const revisionKeys = Object.keys(d.revisions);
            if (revisionKeys.length > 1) return true;
            if (revisionKeys.length === 1) {
                const revision = d.revisions[revisionKeys[0]];
                return revision.hash !== d.hash;
            }
            return false;
        });
        const diff = await Promise.all(filtered.map(async doc => {
            const d = doc.toJSON();
            const filePath = path.resolve(baseDirectory, d.file);
            const missingLocally = !fs.existsSync(filePath);
            const out = deserialize ? await deserializeRevisions(d) : d;
            return {
                id: d.id,
                missingLocally,
                doc: out
            };
        }));
        res.json(diff);
    });

    app.get("/", async (req, res) => {
        const file = fs.readFileSync(__dirname + '/web/index.html');
        res.send(file.toString('utf-8'));
    });
    app.get("/diff.html", (req, res) => {
        const file = fs.readFileSync(__dirname + '/web/diff.html');
        res.send(file.toString('utf-8'));
    });
    app.get("/sync-status", (req, res) => {
        res.json(getSyncStatus());
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

export {saveData, initWeb, initRemoteSync, stopRemoteSync, initDB, getSyncStatus, deserializeRevisions, resolveConflicts, stopPersistence, filesCollection};
