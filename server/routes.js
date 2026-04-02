import { debug } from "../debug.js";

function addPushLoggingMiddleware(app) {
    app.use((req, res, next) => {
        if (req.path.includes('/push')) {
            const origJson = res.json.bind(res);
            res.json = (data) => {
                if (Array.isArray(data) && data.length > 0) {
                    debug(`[PUSH RESPONSE] ${data.length} conflicts returned`);
                }
                return origJson(data);
            };
        }
        next();
    });
}

function addCustomRoutes(app, db, config) {
    // Health check endpoint
    app.get('/ovcs/status', (req, res) => {
        res.json({
            status: 'ok',
            mode: 'server',
            port: config.port,
            dataDir: config.dataDir
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
}

function addErrorHandler(app) {
    app.use((err, req, res, next) => {
        console.error(`[EXPRESS ERROR] ${req.method} ${req.path}:`, err.message || err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });
}

export { addPushLoggingMiddleware, addCustomRoutes, addErrorHandler };
