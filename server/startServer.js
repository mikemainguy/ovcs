import os from "node:os";
import crypto from "node:crypto";
import { createRxServer } from "rxdb-server/plugins/server";
import { HTTP_SERVER_BY_EXPRESS } from "rxdb-server/plugins/adapter-express";
import { OVCSSETTINGS } from "../const.js";
import { createServerDatabase, DATA_DIR } from "./database.js";
import { loadPersistedData, startPersistence } from "./persistence.js";
import { buildAdapter } from "./adapter.js";
import { addPushLoggingMiddleware, addCustomRoutes, addErrorHandler } from "./routes.js";
import { setupSignaling } from "./signaling.js";

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
});
process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err);
});

async function startServer(options = {}) {
    const port = options.port || OVCSSETTINGS.OVCS_SYNC_PORT;
    const host = options.host || process.env.OVCS_SYNC_HOST || '0.0.0.0';
    const tls = options.tls !== false; // TLS on by default

    // Create RxDB database for the server
    const db = await createServerDatabase();

    // Load persisted server data
    await loadPersistedData(db);

    // Build adapter — override listen to use HTTPS when TLS is enabled
    const adapter = buildAdapter(tls, options);

    // Create RxDB Server with Express adapter
    const rxServer = await createRxServer({
        database: db,
        adapter,
        port: port,
        hostname: host,
        cors: '*'
    });

    const app = rxServer.serverApp;

    // Log push results for debugging
    addPushLoggingMiddleware(app);

    // Add replication endpoints
    rxServer.addReplicationEndpoint({
        collection: db.files,
        name: 'replication/files'
    });

    rxServer.addReplicationEndpoint({
        collection: db.presence,
        name: 'replication/presence'
    });

    // Add custom routes
    addCustomRoutes(app, db, { port, dataDir: DATA_DIR });

    // Error handler (must be after all routes)
    addErrorHandler(app);

    await rxServer.start();

    // Attach WebSocket signaling server for P2P
    const httpServer = HTTP_SERVER_BY_EXPRESS.get(rxServer.serverApp);
    if (httpServer) {
        setupSignaling(httpServer);
    } else {
        console.warn('Warning: Could not attach WebSocket signaling server');
    }

    // Periodic persistence
    const persistInterval = startPersistence(db);

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
    const httpProto = tls ? 'https' : 'http';
    const wsProto = tls ? 'wss' : 'ws';
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                    OVCS Server Started                     ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Listening on:  ${host}:${port}`.padEnd(61) + '║');
    console.log(`║  Server URL:    ${httpProto}://${displayHost}:${port}/`.padEnd(61) + '║');
    console.log(`║  TLS:           ${tls ? 'enabled' : 'disabled'}`.padEnd(61) + '║');
    console.log(`║  Data directory: ${DATA_DIR}`.padEnd(61) + '║');
    console.log(`║  Health check:  ${httpProto}://${displayHost}:${port}/ovcs/status`.padEnd(61) + '║');
    console.log(`║  Presence:      ${httpProto}://${displayHost}:${port}/ovcs/presence`.padEnd(61) + '║');
    console.log(`║  Signaling:     ${wsProto}://${displayHost}:${port}/signaling`.padEnd(61) + '║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Replication Endpoints:                                    ║');
    console.log(`║    Files:    ${httpProto}://${displayHost}:${port}/replication/files`.padEnd(61) + '║');
    console.log(`║    Presence: ${httpProto}://${displayHost}:${port}/replication/presence`.padEnd(61) + '║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Press Ctrl+C to stop the server                           ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    return { rxServer, db, persistInterval };
}

export { startServer };
