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

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function saveData(data, metadata) {
    if (!db) {
        db = new PouchDB(`leveldb://${OVCSSETTINGS.ROOT_DIR}/localdb`);
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
async function initWeb(metadata, pwd) {
    // Initialize vector sync
    try {
        await initVectorSync(pwd);
        debug('Vector sync initialized for web');
    } catch (err) {
        debug('Error initializing vector sync:', err);
    }
    web(metadata);
}
function web() {
    const app = express();
    if (!db) {
        db = new PouchDB(`leveldb://${OVCSSETTINGS.ROOT_DIR}/localdb`);
    }

    //const db = new PouchDB(`leveldb://${OVCSSETTINGS.ROOT_DIR}/localdb`);


    app.get("/info", async (req, res) => {
        const count = await db.info();
        res.header('content-type', 'application/json').send(JSON.stringify(count));
    });
    app.get("/data", async (req, res) => {
        const data = await db.allDocs({include_docs: true});
        res.header('content-type', 'application/json').send(JSON.stringify(data));
    });
    app.get("/diff", async (req, res) => {
        const data = await db.allDocs({include_docs: true});
        const diff = data.rows.filter(doc => {
            if (doc.doc.revisions) {
                return Object.keys(doc.doc.revisions).length > 1;
            }})
        res.header('content-type', 'application/json').send(JSON.stringify(diff));
    });
    app.get("/", async (req, res) => {
        const file = fs.readFileSync(import.meta.dirname + '/web/index.html')
       res.send(file.toString('utf-8'));
    });

    // Setup vector search routes
    setupSearchRoutes(app, db);

    const WEB_PORT = process.env.OVCS_WEB_PORT || 3001;
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

export {saveData, initWeb};