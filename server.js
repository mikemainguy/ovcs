import express from "express";
import { addRxPlugin, createRxDatabase } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

addRxPlugin(RxDBDevModePlugin);

function getStorage() {
    return wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
}
import { createRxServer } from "rxdb-server/plugins/server";
import { RxServerAdapterExpress, HTTP_SERVER_BY_EXPRESS } from "rxdb-server/plugins/adapter-express";

// Custom adapter that overrides the default 100KB body limit
const OvcsExpressAdapter = {
    ...RxServerAdapterExpress,
    async create() {
        const app = express();
        app.use(express.json({ limit: '50mb' }));
        return app;
    }
};
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { OVCSSETTINGS } from "./const.js";

const DATA_DIR = `./${OVCSSETTINGS.ROOT_DIR}/server-data`;

// Schemas (same as client)
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

const ovcsConflictHandler = {
    isEqual(a, b) {
        return a.hash === b.hash && a.updatedAt === b.updatedAt;
    },
    resolve(input) {
        const master = input.assumedMasterState;
        const incoming = input.newDocumentState;
        if (!master) return incoming;
        if (!incoming) return master;
        const merged = { ...master };
        merged.revisions = { ...(master.revisions || {}), ...(incoming.revisions || {}) };
        if (master.revisions && incoming.revisions) {
            for (const email of Object.keys(incoming.revisions)) {
                if (master.revisions[email]) {
                    const masterDate = new Date(master.revisions[email].updated || 0);
                    const incomingDate = new Date(incoming.revisions[email].updated || 0);
                    merged.revisions[email] = incomingDate > masterDate
                        ? incoming.revisions[email]
                        : master.revisions[email];
                }
            }
        }
        if ((incoming.updatedAt || 0) > (master.updatedAt || 0)) {
            merged.hash = incoming.hash;
            merged.base64 = incoming.base64;
            merged.updatedAt = incoming.updatedAt;
        }
        return merged;
    }
};

const presenceConflictHandler = {
    isEqual(a, b) {
        return a.lastSeen === b.lastSeen && a.status === b.status;
    },
    resolve(input) {
        // Keep the most recently seen document
        return new Date(input.newDocumentState.lastSeen || 0) >= new Date(input.assumedMasterState.lastSeen || 0)
            ? input.newDocumentState
            : input.assumedMasterState;
    }
};

// Signaling server for WebRTC P2P
const signalingPeers = new Map(); // teamId -> Map(nodeId -> ws)

function setupSignaling(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/signaling' });

    wss.on('connection', (ws) => {
        let peerTeamId = null;
        let peerNodeId = null;

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());

                if (msg.type === 'register') {
                    peerTeamId = msg.teamId;
                    peerNodeId = msg.nodeId;
                    if (!signalingPeers.has(peerTeamId)) {
                        signalingPeers.set(peerTeamId, new Map());
                    }
                    const team = signalingPeers.get(peerTeamId);
                    team.set(peerNodeId, ws);

                    // Notify existing peers about the new peer
                    for (const [existingId, existingWs] of team) {
                        if (existingId !== peerNodeId && existingWs.readyState === 1) {
                            existingWs.send(JSON.stringify({ type: 'peer-joined', nodeId: peerNodeId }));
                            // Also tell the new peer about existing peers
                            ws.send(JSON.stringify({ type: 'peer-joined', nodeId: existingId }));
                        }
                    }
                    console.log(`[Signaling] Peer registered: ${peerNodeId} (team: ${peerTeamId})`);
                }
                else if (msg.type === 'signal' && peerTeamId) {
                    // Relay WebRTC signaling data (SDP/ICE) to target peer
                    const team = signalingPeers.get(peerTeamId);
                    const targetWs = team?.get(msg.target);
                    if (targetWs && targetWs.readyState === 1) {
                        targetWs.send(JSON.stringify({
                            type: 'signal',
                            from: peerNodeId,
                            data: msg.data
                        }));
                    }
                }
            } catch (err) {
                // Ignore malformed messages
            }
        });

        ws.on('close', () => {
            if (peerTeamId && peerNodeId) {
                const team = signalingPeers.get(peerTeamId);
                if (team) {
                    team.delete(peerNodeId);
                    // Notify remaining peers
                    for (const [id, existingWs] of team) {
                        if (existingWs.readyState === 1) {
                            existingWs.send(JSON.stringify({ type: 'peer-left', nodeId: peerNodeId }));
                        }
                    }
                    if (team.size === 0) signalingPeers.delete(peerTeamId);
                }
                console.log(`[Signaling] Peer disconnected: ${peerNodeId}`);
            }
        });
    });
    console.log('WebSocket signaling server attached at /signaling');
}

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
});
process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err);
});

async function startServer(options = {}) {
    const port = options.port || OVCSSETTINGS.OVCS_SYNC_PORT;
    const host = options.host || process.env.OVCS_SYNC_HOST || '0.0.0.0';

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Create RxDB database for the server
    const db = await createRxDatabase({
        name: `${DATA_DIR}/serverdb`,
        storage: getStorage(),
        multiInstance: false
    });

    await db.addCollections({
        files: {
            schema: fileSchema,
            conflictHandler: ovcsConflictHandler
        },
        presence: {
            schema: presenceSchema,
            conflictHandler: presenceConflictHandler
        }
    });

    // Load persisted server data
    const PERSIST_FILES = `${DATA_DIR}/rxdb-files.json`;
    const PERSIST_PRESENCE = `${DATA_DIR}/rxdb-presence.json`;
    try {
        if (fs.existsSync(PERSIST_FILES)) {
            const data = JSON.parse(fs.readFileSync(PERSIST_FILES, 'utf-8'));
            if (data.length > 0) await db.files.bulkInsert(data);
            console.log(`Loaded ${data.length} file docs from disk`);
        }
        if (fs.existsSync(PERSIST_PRESENCE)) {
            const data = JSON.parse(fs.readFileSync(PERSIST_PRESENCE, 'utf-8'));
            if (data.length > 0) await db.presence.bulkInsert(data);
            console.log(`Loaded ${data.length} presence docs from disk`);
        }
    } catch (err) {
        console.log('No persisted data found, starting fresh');
    }

    // Create RxDB Server with Express adapter
    const rxServer = await createRxServer({
        database: db,
        adapter: OvcsExpressAdapter,
        port: port,
        host: host,
        cors: '*'
    });

    const app = rxServer.serverApp;

    // Log requests and capture responses for debugging
    app.use((req, res, next) => {
        const sizeKB = req.headers['content-length'] ? Math.round(parseInt(req.headers['content-length']) / 1024) : 0;
        if (sizeKB > 10) {
            console.log(`[${req.method}] ${req.path} - ${sizeKB}KB`);
        }

        // Intercept response to log push results
        if (req.path.includes('/push')) {
            const origJson = res.json.bind(res);
            res.json = (data) => {
                if (Array.isArray(data) && data.length > 0) {
                    console.log(`[PUSH RESPONSE] ${data.length} conflicts returned:`, JSON.stringify(data).substring(0, 500));
                } else if (Array.isArray(data)) {
                    console.log(`[PUSH RESPONSE] OK - 0 conflicts`);
                } else {
                    console.log(`[PUSH RESPONSE]`, JSON.stringify(data).substring(0, 500));
                }
                return origJson(data);
            };
        }
        next();
    });

    // Add replication endpoints
    rxServer.addReplicationEndpoint({
        collection: db.files,
        name: 'replication/files'
    });

    rxServer.addReplicationEndpoint({
        collection: db.presence,
        name: 'replication/presence'
    });

    // Add custom routes to the Express app

    // Health check endpoint
    app.get('/ovcs/status', (req, res) => {
        res.json({
            status: 'ok',
            mode: 'server',
            port: port,
            dataDir: DATA_DIR
        });
    });

    // Presence summary endpoint
    app.get('/ovcs/presence', async (req, res) => {
        try {
            const docs = await db.presence.find().exec();
            const nodes = docs.map(d => {
                const doc = d.toJSON();
                return {
                    id: doc.id,
                    email: doc.email,
                    hostname: doc.hostname,
                    projectPath: doc.projectPath,
                    nodeType: doc.nodeType,
                    lastSeen: doc.lastSeen,
                    startedAt: doc.startedAt,
                    status: doc.status,
                    activeFiles: doc.activeFiles || [],
                    teamId: doc.teamId
                };
            });
            res.json(nodes);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Start the server
    // Error handler (must be after all routes)
    app.use((err, req, res, next) => {
        console.error(`[EXPRESS ERROR] ${req.method} ${req.path}:`, err.message || err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });

    await rxServer.start();

    // Attach WebSocket signaling server for P2P
    const httpServer = HTTP_SERVER_BY_EXPRESS.get(rxServer.serverApp);
    if (httpServer) {
        setupSignaling(httpServer);
    } else {
        console.warn('Warning: Could not attach WebSocket signaling server');
    }

    // Periodic persistence
    const persistInterval = setInterval(async () => {
        try {
            const fileDocs = await db.files.find().exec();
            fs.writeFileSync(PERSIST_FILES, JSON.stringify(fileDocs.map(d => d.toJSON())));
            const presenceDocs = await db.presence.find().exec();
            fs.writeFileSync(PERSIST_PRESENCE, JSON.stringify(presenceDocs.map(d => d.toJSON())));
        } catch (err) {
            // Ignore persistence errors
        }
    }, 30000);

    // Register server presence
    const hostname = os.hostname();
    const nodeId = 'node-server-' + crypto.createHash('sha256').update(`server:${hostname}:${port}`).digest('hex').substring(0, 16);
    try {
        await db.presence.upsert({
            id: nodeId,
            email: 'server',
            hostname: hostname,
            projectPath: DATA_DIR,
            nodeType: 'server',
            lastSeen: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            status: 'active',
            activeFiles: [],
            teamId: 'server',
            updatedAt: Date.now()
        });
    } catch (err) {
        // Not critical
    }

    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                    OVCS Server Started                     ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Listening on:  ${host}:${port}`.padEnd(61) + '║');
    console.log(`║  Server URL:    http://${displayHost}:${port}/`.padEnd(61) + '║');
    console.log(`║  Data directory: ${DATA_DIR}`.padEnd(61) + '║');
    console.log(`║  Health check:  http://${displayHost}:${port}/ovcs/status`.padEnd(61) + '║');
    console.log(`║  Presence:      http://${displayHost}:${port}/ovcs/presence`.padEnd(61) + '║');
    console.log(`║  Signaling:     ws://${displayHost}:${port}/signaling`.padEnd(61) + '║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Replication Endpoints:                                    ║');
    console.log(`║    Files:    http://${displayHost}:${port}/replication/files`.padEnd(61) + '║');
    console.log(`║    Presence: http://${displayHost}:${port}/replication/presence`.padEnd(61) + '║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Press Ctrl+C to stop the server                           ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    return { rxServer, db, persistInterval };
}

export { startServer };
