import PouchDB from "pouchdb";
import crypto from "node:crypto";
import {debug} from "./debug.js";
import express from "express";
import {OVCSSETTINGS} from "./const.js";
import fs from "node:fs";
import * as path from "node:path";


let db = null;

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function saveData(data) {
    if (!db) {
        db = new PouchDB(`leveldb://${OVCSSETTINGS.ROOT_DIR}/localdb`);
    }
    try {
        const existing = await db.get(sha256(data.id))
        debug('existing', existing);
        if (existing.type === data.type && existing.hash === data.hash) {
            return;
        }
        const newDoc = {...existing, type: data.type, hash: data.hash};
        debug(newDoc);
        await db.put(newDoc);
    } catch (err) {
        debug('error', err);
        if (err.status === 404) {
            try {
                await db.put({...data, _id: sha256(data.id), file: data.id});
            } catch (err) {
                debug('error saving data', err);
            }
        }
        if (err.status === 409) {
            debug('conflict', data.id);
        }
    }

}
function initWeb() {
    web();
}
function web() {
    if (!db) {
        db = new PouchDB(`leveldb://${OVCSSETTINGS.ROOT_DIR}/localdb`);
    }
    //const db = new PouchDB(`leveldb://${OVCSSETTINGS.ROOT_DIR}/localdb`);
    const app = express();
    app.get("/info", async (req, res) => {
        const count = await db.info();
        res.header('content-type', 'application/json').send(JSON.stringify(count));
    });
    app.get("/", async (req, res) => {

        console.log(import.meta.dirname);
        const file = fs.readFileSync('web/index.html')
       res.send(file.toString('utf-8'));
    });
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