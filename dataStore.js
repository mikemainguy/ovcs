console.log('=== dataStore.js loading ===');
import PouchDB from "pouchdb";
import crypto from "node:crypto";
import {debug} from "./debug.js";
import express from "express";
import {OVCSSETTINGS} from "./const.js";
import fs from "node:fs";
import * as path from "node:path";
import { syncFileToVectorDB, removeFileFromVectorDB, initVectorSync, isVectorSyncInitialized } from './vectorSync.js';
import { setupSearchRoutes } from './searchApi.js';


let db = null;
let syncHandler = null;
let dbInitPromise = null;
let syncStatus = { state: 'disconnected', lastSync: null, error: null };

function getSyncStatus() {
    return syncStatus;
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// Initialize database once - must be called before any other db operations
async function initDB() {
    if (db) return db;
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = (async () => {
        db = new PouchDB(`leveldb://${OVCSSETTINGS.ROOT_DIR}/localdb`);
        const info = await db.info();
        console.log(`Database initialized: ${info.db_name} (${info.doc_count} docs)`);
        return db;
    })();

    return dbInitPromise;
}

async function saveData(data, metadata) {
    if (!db) {
        throw new Error('Database not initialized. Call initDB() first.');
    }

    // Handle delete immediately - remove from vector DB
    if (data.type === 'delete') {
        removeFileFromVectorDB(data.id).catch(err => {
            debug('Vector delete error:', err);
        });
    }

    try {
        const existing = await db.get(sha256(data.id))
        debug('existing', existing);
        if (existing.type === data.type && existing.hash === data.hash) {
            debug('no change', data.id);
            return;
        }
        if (existing.revisions) {
            if (existing.revisions[metadata.email]) {
                debug('Found Revision', data.id);
                existing.revisions[metadata.email].hash = data.hash;
                existing.revisions[metadata.email].updated = new Date().toISOString();
                existing.revisions[metadata.email].content = data.base64;
            } else {
                debug('Adding Revision', data.id);
                existing.revisions[metadata.email] = {
                    hash: data.hash,
                    updated: new Date().toISOString(),
                    content: data.base64
                };

            }
        } else {
            debug('no revisions', data.id);
            existing.revisions = {
                [metadata.email]: {
                    hash: data.hash,
                    updated: new Date().toISOString(),
                    content: data.base64
                }
            }
        }
        const newDoc = {...existing, ...{type: data.type, hash: data.hash}};
        debug(JSON.stringify(newDoc));
        await db.put(newDoc);

        // Sync to vector DB after successful PouchDB update
        if (data.type === 'file' && data.base64) {
            syncFileToVectorDB(data, metadata).catch(err => {
                debug('Vector sync error:', err);
            });
        }
    } catch (err) {
        if (err.status === 404) {
            // New file - create document
            debug('new file', data.id);
            try {
                await db.put({...data, _id: sha256(data.id), file: data.id});

                // Sync to vector DB after successful PouchDB insert
                if (data.type === 'file' && data.base64) {
                    syncFileToVectorDB(data, metadata).catch(err => {
                        debug('Vector sync error:', err);
                    });
                }
            } catch (putErr) {
                debug('error saving data', putErr);
            }
        } else if (err.status === 409) {
            debug('conflict', data.id);
        } else {
            debug('error', err);
        }
    }

}
async function initWeb(metadata, pwd, port) {
    // Initialize database first - before anything else
    await initDB();

    // Initialize vector sync
    try {
        await initVectorSync(pwd);
        debug('Vector sync initialized for web');
    } catch (err) {
        debug('Error initializing vector sync:', err);
    }

    // Initialize remote PouchDB sync if enabled
    if (metadata.sync?.enabled && metadata.remote) {
        try {
            await initRemoteSync(metadata);
            debug('Remote sync initialized');
        } catch (err) {
            debug('Error initializing remote sync:', err);
        }
    }

    console.log('Calling web()...');
    web(port);
    console.log('initWeb complete');
}
// Deserialize revisions by decoding base64 content to readable text
function deserializeRevisions(doc) {
    if (!doc.revisions) return doc;

    const deserialized = { ...doc, revisions: {} };
    for (const [email, revision] of Object.entries(doc.revisions)) {
        deserialized.revisions[email] = { ...revision };
        if (revision.content) {
            try {
                deserialized.revisions[email].content = Buffer.from(revision.content, 'base64').toString('utf-8');
            } catch (err) {
                // Keep original if decode fails (binary content)
                deserialized.revisions[email].content = '[binary content]';
            }
        }
    }
    return deserialized;
}

function web(port) {
    console.log('web() starting...');
    const app = express();


    app.get("/info", async (req, res) => {
        const count = await db.info();
        res.header('content-type', 'application/json').send(JSON.stringify(count));
    });
    app.get("/data", async (req, res) => {
        const data = await db.allDocs({include_docs: true});
        const deserialize = req.query.deserialize !== 'false';
        if (deserialize) {
            data.rows = data.rows.map(row => ({
                ...row,
                doc: deserializeRevisions(row.doc)
            }));
        }
        res.header('content-type', 'application/json').send(JSON.stringify(data));
    });
    app.get("/diff", async (req, res) => {
        const data = await db.allDocs({include_docs: true});
        const deserialize = req.query.deserialize !== 'false';
        let diff = data.rows.filter(doc => {
            if (doc.doc.revisions) {
                return Object.keys(doc.doc.revisions).length > 1;
            }});
        if (deserialize) {
            diff = diff.map(row => ({
                ...row,
                doc: deserializeRevisions(row.doc)
            }));
        }
        res.header('content-type', 'application/json').send(JSON.stringify(diff));
    });
    app.get("/", async (req, res) => {
        const file = fs.readFileSync(import.meta.dirname + '/web/index.html')
       res.send(file.toString('utf-8'));
    });
    app.get("/diff.html", (req, res) => {
        const file = fs.readFileSync(import.meta.dirname + '/web/diff.html');
        res.send(file.toString('utf-8'));
    });
    app.get("/sync-status", (req, res) => {
        res.json(getSyncStatus());
    });

    // Setup vector search routes
    setupSearchRoutes(app, db);

    const WEB_PORT = port || process.env.OVCS_WEB_PORT || 3001;
    try {
        app.listen(WEB_PORT, () => {
            console.log('listening on port', WEB_PORT);
        })
    } catch (err) {
        console.error('error starting web server', err);
        console.error('is the port already in use?');
        console.error('try setting OVCS_WEB_PORT to a different port');
    }

}

async function initRemoteSync(metadata, retryCount = 0) {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = Math.pow(2, retryCount) * 1000; // exponential backoff: 1s, 2s, 4s, 8s, 16s

    if (!metadata.remote || !metadata.sync?.enabled) {
        console.log('Remote sync disabled or no remote configured');
        return;
    }

    if (!db) {
        throw new Error('Database not initialized. Call initDB() first.');
    }

    syncStatus.state = 'connecting';
    syncStatus.error = null;
    console.log(`Connecting to remote: ${metadata.remote}`);

    const remoteDb = new PouchDB(metadata.remote);

    // Test connection to remote with retry logic
    try {
        const remoteInfo = await remoteDb.info();
        console.log(`Remote DB connected: ${remoteInfo.db_name} (${remoteInfo.doc_count} docs)`);
    } catch (err) {
        if (retryCount < MAX_RETRIES) {
            console.log(`Connection failed, retrying in ${RETRY_DELAY/1000}s... (${retryCount + 1}/${MAX_RETRIES})`);
            syncStatus.state = 'connecting';
            syncStatus.error = `Retry ${retryCount + 1}/${MAX_RETRIES}: ${err.message}`;
            setTimeout(() => initRemoteSync(metadata, retryCount + 1), RETRY_DELAY);
            return;
        }
        console.error(`Failed to connect after ${MAX_RETRIES} attempts: ${err.message}`);
        console.error('Make sure the server is running and the URL is correct');
        syncStatus.state = 'error';
        syncStatus.error = `Failed after ${MAX_RETRIES} attempts: ${err.message}`;
        return;
    }

    const localInfo = await db.info();
    console.log(`Local DB: ${localInfo.db_name} (${localInfo.doc_count} docs)`);

    const syncOptions = {
        live: metadata.sync.live !== false,
        retry: metadata.sync.retry !== false
    };

    console.log(`Starting sync with options:`, syncOptions);

    syncHandler = db.sync(remoteDb, syncOptions)
        .on('change', info => {
            console.log(`Sync ${info.direction}: ${info.change?.docs?.length || 0} docs`);
            debug('Sync change details:', info);
        })
        .on('paused', err => {
            if (err) {
                console.error('Sync paused with error:', err.message);
                syncStatus.state = 'error';
                syncStatus.error = err.message;
            } else {
                console.log('Sync paused (up to date)');
                syncStatus.state = 'synced';
                syncStatus.lastSync = new Date().toISOString();
                syncStatus.error = null;
            }
        })
        .on('active', () => {
            console.log('Sync active');
            syncStatus.state = 'syncing';
        })
        .on('denied', err => {
            console.error('Sync denied:', err);
            syncStatus.state = 'error';
            syncStatus.error = `Denied: ${err.message || err}`;
        })
        .on('complete', info => {
            console.log('Sync complete');
            debug('Sync complete details:', info);
            syncStatus.state = 'synced';
            syncStatus.lastSync = new Date().toISOString();
        })
        .on('error', err => {
            console.error('Sync error:', err.message || err);
            syncStatus.state = 'error';
            syncStatus.error = err.message || String(err);
        });

    console.log('initRemoteSync() setup complete');
    // Don't return syncHandler - it's thenable and would block await
    // The handler is stored in the module-level syncHandler variable
}

function stopRemoteSync() {
    if (syncHandler) {
        syncHandler.cancel();
        syncHandler = null;
        debug('Remote sync stopped');
    }
}

export {saveData, initWeb, initRemoteSync, stopRemoteSync, initDB, getSyncStatus, deserializeRevisions};