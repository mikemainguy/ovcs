import { createRxDatabase } from "rxdb";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

function getStorage() {
    return wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
}
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import {debug} from "./debug.js";
import {OVCSSETTINGS} from "./const.js";
import { replicateServer } from 'rxdb-server/plugins/replication-server';

let presenceDb = null;
let presenceCollection = null;
let presenceSyncHandler = null;
let heartbeatTimer = null;
let nodeId = null;
let metadata = null;

const presenceSchema = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id:          { type: 'string', maxLength: 100 },
        email:       { type: 'string' },
        hostname:    { type: 'string' },
        projectPath: { type: 'string' },
        nodeType:    { type: 'string' },
        lastSeen:    { type: 'string' },
        startedAt:   { type: 'string' },
        status:      { type: 'string' },
        activeFiles: { type: 'array', items: { type: 'string' } },
        teamId:      { type: 'string' },
        updatedAt:   { type: 'number' }
    },
    required: ['id', 'email', 'status']
};

const presenceConflictHandler = {
    isEqual(a, b) {
        return a.lastSeen === b.lastSeen && a.status === b.status;
    },
    resolve(input) {
        return new Date(input.newDocumentState.lastSeen || 0) >= new Date(input.assumedMasterState.lastSeen || 0)
            ? input.newDocumentState
            : input.assumedMasterState;
    }
};

function generateNodeId(clientId) {
    return 'node-' + crypto.createHash('sha256').update(clientId).digest('hex').substring(0, 16);
}

async function initPresence(meta, pwd) {
    metadata = meta;

    if (!metadata.presence?.enabled) {
        debug('Presence disabled');
        return;
    }

    if (!metadata.teamId) {
        debug('Presence requires a teamId');
        return;
    }

    nodeId = generateNodeId(metadata.clientId || `${metadata.email}:${os.hostname()}:${pwd}`);

    // Create a separate RxDB database for presence
    presenceDb = await createRxDatabase({
        name: `${OVCSSETTINGS.ROOT_DIR}/presencedb`,
        storage: getStorage(),
        multiInstance: false
    });

    await presenceDb.addCollections({
        nodes: {
            schema: presenceSchema,
            conflictHandler: presenceConflictHandler
        }
    });

    presenceCollection = presenceDb.nodes;

    // Load persisted presence data
    const PERSIST_FILE = `${OVCSSETTINGS.ROOT_DIR}/rxdb-presence.json`;
    try {
        if (fs.existsSync(PERSIST_FILE)) {
            const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
            if (data.length > 0) await presenceCollection.bulkInsert(data);
        }
    } catch (err) {
        debug('Error loading persisted presence data:', err);
    }

    // Create/update local node presence document
    const now = new Date().toISOString();
    try {
        await presenceCollection.upsert({
            id: nodeId,
            email: metadata.email,
            hostname: os.hostname(),
            projectPath: pwd,
            nodeType: 'client',
            lastSeen: now,
            startedAt: now,
            status: 'active',
            activeFiles: [],
            teamId: metadata.teamId,
            updatedAt: Date.now()
        });
        debug('Presence document created:', nodeId);
    } catch (err) {
        debug('Error creating presence document:', err);
        return;
    }

    // Start replication to server if remote is configured
    if (metadata.remote && metadata.sync?.enabled) {
        const serverUrl = metadata.remote.replace(/\/[^/]*$/, '');
        try {
            presenceSyncHandler = replicateServer({
                collection: presenceCollection,
                replicationIdentifier: 'ovcs-presence-sync',
                url: `${serverUrl}/replication/presence/0`,
                live: true,
                push: {},
                pull: {}
            });

            presenceSyncHandler.error$.subscribe(err => {
                debug('Presence sync error:', err.message || err);
            });

            debug('Presence sync started');
        } catch (err) {
            debug('Error starting presence sync:', err);
        }
    }

    // Start heartbeat
    const interval = metadata.presence.heartbeatInterval || OVCSSETTINGS.HEARTBEAT_INTERVAL;
    heartbeatTimer = setInterval(() => heartbeat(), interval);
    debug(`Heartbeat started (${interval}ms interval)`);

    console.log(`Presence active as ${metadata.email} (team: ${metadata.teamId})`);
}

async function heartbeat() {
    if (!presenceCollection || !nodeId) return;

    try {
        const doc = await presenceCollection.findOne(nodeId).exec();
        if (doc) {
            await doc.patch({
                lastSeen: new Date().toISOString(),
                status: 'active',
                updatedAt: Date.now()
            });
            debug('Heartbeat sent');
        }
    } catch (err) {
        debug('Heartbeat error:', err);
    }

    await cleanupStaleNodes();
}

async function cleanupStaleNodes() {
    if (!presenceCollection) return;

    const staleTimeout = metadata?.presence?.staleTimeout || OVCSSETTINGS.STALE_TIMEOUT;
    const cutoff = new Date(Date.now() - staleTimeout).toISOString();

    try {
        const docs = await presenceCollection.find().exec();
        for (const doc of docs) {
            const d = doc.toJSON();
            if (d.id === nodeId) continue;
            if (d.status === 'active' && d.lastSeen < cutoff) {
                debug(`Marking stale node: ${d.email} (${d.hostname})`);
                await doc.patch({ status: 'offline', updatedAt: Date.now() });
            }
        }
    } catch (err) {
        debug('Stale cleanup error:', err);
    }
}

async function stopPresence() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    // Mark ourselves as offline
    if (presenceCollection && nodeId) {
        try {
            const doc = await presenceCollection.findOne(nodeId).exec();
            if (doc) {
                await doc.patch({
                    status: 'offline',
                    lastSeen: new Date().toISOString(),
                    updatedAt: Date.now()
                });
                debug('Marked as offline');

                // Give replication a moment to push
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (err) {
            debug('Error marking offline:', err);
        }
    }

    // Persist presence data
    if (presenceCollection) {
        const PERSIST_FILE = `${OVCSSETTINGS.ROOT_DIR}/rxdb-presence.json`;
        try {
            const docs = await presenceCollection.find().exec();
            fs.writeFileSync(PERSIST_FILE, JSON.stringify(docs.map(d => d.toJSON())));
        } catch (err) {
            debug('Error persisting presence:', err);
        }
    }

    if (presenceSyncHandler) {
        await presenceSyncHandler.cancel();
        presenceSyncHandler = null;
    }

    debug('Presence stopped');
}

async function getActiveNodes() {
    if (!presenceCollection) return [];

    const staleTimeout = metadata?.presence?.staleTimeout || OVCSSETTINGS.STALE_TIMEOUT;
    const cutoff = new Date(Date.now() - staleTimeout).toISOString();

    try {
        const docs = await presenceCollection.find().exec();
        return docs
            .filter(doc => {
                const d = doc.toJSON();
                return d.status === 'active' && d.lastSeen >= cutoff;
            })
            .map(doc => {
                const d = doc.toJSON();
                return {
                    id: d.id,
                    email: d.email,
                    hostname: d.hostname,
                    projectPath: d.projectPath,
                    nodeType: d.nodeType,
                    lastSeen: d.lastSeen,
                    startedAt: d.startedAt,
                    activeFiles: d.activeFiles || []
                };
            });
    } catch (err) {
        debug('Error getting active nodes:', err);
        return [];
    }
}

async function updateActiveFiles(files) {
    if (!presenceCollection || !nodeId) return;

    try {
        const doc = await presenceCollection.findOne(nodeId).exec();
        if (doc) {
            await doc.patch({
                activeFiles: files,
                lastSeen: new Date().toISOString(),
                updatedAt: Date.now()
            });
        }
    } catch (err) {
        debug('Error updating active files:', err);
    }
}

export {initPresence, stopPresence, getActiveNodes, updateActiveFiles};
