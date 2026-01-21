import express from "express";
import PouchDB from "pouchdb";
import expressPouchDB from "express-pouchdb";
import fs from "node:fs";
import { OVCSSETTINGS } from "./const.js";

const DATA_DIR = `./${OVCSSETTINGS.ROOT_DIR}/server-data`;

async function startServer(options = {}) {
    const port = options.port || OVCSSETTINGS.OVCS_SYNC_PORT;

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const ServerPouchDB = PouchDB.defaults({
        prefix: `${DATA_DIR}/`
    });

    const app = express();

    // CORS for cross-origin replication
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, HEAD');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(200);
        }
        next();
    });

    // Helper to get doc count for a database
    async function getDocCount(dbName) {
        try {
            const db = new ServerPouchDB(dbName);
            const info = await db.info();
            return info.doc_count;
        } catch (err) {
            return '?';
        }
    }

    // Sync event logging middleware
    app.use((req, res, next) => {
        const timestamp = new Date().toISOString();
        const clientIp = req.ip || req.connection.remoteAddress;

        // Log replication-related endpoints
        if (req.method !== 'OPTIONS') {
            const path = req.path;
            const dbName = path.split('/')[1];

            if (path.includes('/_changes')) {
                console.log(`[${timestamp}] SYNC: ${clientIp} - Changes feed requested for ${dbName}`);
            } else if (path.includes('/_bulk_docs')) {
                // Log after response completes to get updated count
                res.on('finish', async () => {
                    const count = await getDocCount(dbName);
                    console.log(`[${timestamp}] SYNC: ${clientIp} - Bulk docs pushed to ${dbName} (total docs: ${count})`);
                });
            } else if (path.includes('/_revs_diff')) {
                console.log(`[${timestamp}] SYNC: ${clientIp} - Revs diff for ${dbName}`);
            } else if (path.includes('/_bulk_get')) {
                console.log(`[${timestamp}] SYNC: ${clientIp} - Bulk get from ${dbName}`);
            } else if (req.method === 'PUT' && path.split('/').length === 3) {
                res.on('finish', async () => {
                    const count = await getDocCount(dbName);
                    console.log(`[${timestamp}] SYNC: ${clientIp} - Document updated in ${dbName} (total docs: ${count})`);
                });
            } else if (req.method === 'PUT' && path.split('/').length === 2 && !path.startsWith('/_')) {
                console.log(`[${timestamp}] DB: ${clientIp} - Database created: ${dbName}`);
            }
        }
        next();
    });

    // Health check endpoint
    app.get('/ovcs/status', (req, res) => {
        res.json({
            status: 'ok',
            mode: 'server',
            port: port,
            dataDir: DATA_DIR
        });
    });

    // Mount express-pouchdb in minimumForPouchDB mode
    app.use('/', expressPouchDB(ServerPouchDB, { mode: 'minimumForPouchDB' }));

    app.listen(port, () => {
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║                    OVCS Server Started                     ║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log(`║  Server URL:    http://localhost:${port}/`.padEnd(61) + '║');
        console.log(`║  Data directory: ${DATA_DIR}`.padEnd(61) + '║');
        console.log(`║  Health check:  http://localhost:${port}/ovcs/status`.padEnd(61) + '║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log('║  Client Configuration (.ovcs/ovcs.json):                   ║');
        console.log('║                                                            ║');
        console.log(`║    "remote": "http://localhost:${port}/ovcs",`.padEnd(61) + '║');
        console.log('║    "sync": { "enabled": true }                             ║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log('║  Press Ctrl+C to stop the server                           ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
    });
}

export { startServer };
