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

// Custom adapter — metadata-only payloads are small, default limits are fine
const OvcsExpressAdapter = {
    ...RxServerAdapterExpress
};
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { OVCSSETTINGS } from "./const.js";

const DATA_DIR = `./${OVCSSETTINGS.ROOT_DIR}/server-data`;

// Schemas (same as client — metadata only, no content stored)
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
        fileFilter:  { type: 'object' },
        teamId:      { type: 'string' },
        gitBranch:   { type: 'string' },
        gitCommitHash: { type: 'string' },
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
            merged.updatedAt = incoming.updatedAt;
        }
        return merged;
    }
};

const presenceConflictHandler = {
    isEqual(a, b) {
        return a?.lastSeen === b?.lastSeen && a?.status === b?.status;
    },
    resolve(input) {
        const master = input.assumedMasterState;
        const incoming = input.newDocumentState;
        if (!master) return incoming;
        if (!incoming) return master;
        return new Date(incoming.lastSeen || 0) >= new Date(master.lastSeen || 0)
            ? incoming
            : master;
    }
};

// Signaling server for WebRTC P2P — implements RxDB's simple-peer signaling protocol
import { SIMPLE_PEER_PING_INTERVAL } from 'rxdb/plugins/replication-webrtc';

const PEER_ID_LENGTH = 12;

function randomToken(length) {
    let result = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function setupSignaling(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/signaling' });
    const peerById = new Map();
    const peersByRoom = new Map();

    function sendMsg(ws, msg) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(msg));
        }
    }

    function disconnectPeer(peerId, reason) {
        console.log(`[Signaling] Disconnect peer ${peerId}: ${reason}`);
        const peer = peerById.get(peerId);
        if (peer) {
            peer.rooms.forEach(roomId => {
                const room = peersByRoom.get(roomId);
                if (room) {
                    room.delete(peerId);
                    if (room.size === 0) peersByRoom.delete(roomId);
                }
            });
            try { peer.socket.close(); } catch (e) {}
        }
        peerById.delete(peerId);
    }

    // Clean up stale peers that stopped pinging
    const pingInterval = setInterval(() => {
        const minTime = Date.now() - (SIMPLE_PEER_PING_INTERVAL || 120000);
        for (const [peerId, peer] of peerById) {
            if (peer.lastPing < minTime) {
                disconnectPeer(peerId, 'no ping');
            }
        }
    }, 5000);

    wss.on('close', () => {
        clearInterval(pingInterval);
        peerById.clear();
        peersByRoom.clear();
    });

    wss.on('connection', (ws) => {
        const peerId = randomToken(PEER_ID_LENGTH);
        const peer = { id: peerId, socket: ws, rooms: new Set(), lastPing: Date.now() };
        peerById.set(peerId, peer);

        // Send init with assigned peerId
        sendMsg(ws, { type: 'init', yourPeerId: peerId });
        console.log(`[Signaling] Peer connected: ${peerId}`);

        ws.on('error', (err) => {
            console.error(`[Signaling] Peer ${peerId} error:`, err.message);
            disconnectPeer(peerId, 'socket error');
        });

        ws.on('close', () => {
            disconnectPeer(peerId, 'disconnected');
        });

        ws.on('message', (raw) => {
            peer.lastPing = Date.now();
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch (e) {
                return;
            }

            switch (msg.type) {
                case 'join': {
                    const roomId = msg.room;
                    if (!roomId || roomId.length < 5) {
                        disconnectPeer(peerId, 'invalid room id');
                        return;
                    }
                    peer.rooms.add(roomId);
                    if (!peersByRoom.has(roomId)) {
                        peersByRoom.set(roomId, new Set());
                    }
                    const room = peersByRoom.get(roomId);
                    room.add(peerId);

                    console.log(`[Signaling] Peer ${peerId} joined room ${roomId} (${room.size} peers)`);

                    // Tell all peers in the room about the current roster
                    for (const otherPeerId of room) {
                        const otherPeer = peerById.get(otherPeerId);
                        if (otherPeer) {
                            sendMsg(otherPeer.socket, {
                                type: 'joined',
                                otherPeerIds: Array.from(room)
                            });
                        }
                    }
                    break;
                }
                case 'signal': {
                    if (msg.senderPeerId !== peerId) {
                        disconnectPeer(peerId, 'spoofed sender');
                        return;
                    }
                    const receiver = peerById.get(msg.receiverPeerId);
                    if (receiver) {
                        sendMsg(receiver.socket, msg);
                    }
                    break;
                }
                case 'ping':
                    break;
                default:
                    console.log(`[Signaling] Unknown message type from ${peerId}: ${msg.type}`);
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

    // Log push results for debugging
    app.use((req, res, next) => {
        if (req.path.includes('/push')) {
            const origJson = res.json.bind(res);
            res.json = (data) => {
                if (Array.isArray(data) && data.length > 0) {
                    console.log(`[PUSH RESPONSE] ${data.length} conflicts returned`);
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
