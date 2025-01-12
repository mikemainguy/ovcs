import {watch} from "chokidar";
import fs from "node:fs";
import * as crypto from "node:crypto";
import {initWeb, saveData} from "./dataStore.js";
import {debug} from "./debug.js";

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}
function watchDir(metadata, pwd) {
    initWeb();
    debug('metadata', metadata);
    if (metadata.ignore?.length > 0) {
        debug('Ignoring:', metadata.ignore);
    }
    const watcher = watch('.',
        {
            ignored: metadata.ignore,
            ignoreInitial: false,
            persistent: true
        });
    watcher.on('all', (event, path) => {
        let type = ""
        try {
            type = fs.lstatSync(path).isDirectory() ? 'dir' : 'file';
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('Error', path, err);
            }
            type = "delete"
        }
        switch (event) {
            case 'add':
            case 'change':
                if (type === 'file') {
                    fs.readFile(path, function (err, data) {
                        if (err) {
                            console.error('Error reading file:', path, err);
                        }
                        const hash = sha256(data);
                        saveData({id: path, type: type, hash: hash})
                        debug('add', path, hash);
                    });
                } else {
                    saveData({id: path, type: type})
                    debug('add', path);
                }
                break;
            case 'addDir':
                saveData({id: path, type: type})
                debug('addDir', path);
                break;
            case 'unlink':
                saveData({id: path, type: type})
                debug('unlink', path);
                break;
            default:
                debug('Unhandled event:', event);
        }
        debug(event, path);
    });
}
export {watchDir};