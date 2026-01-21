import {watch} from "chokidar";
import fs from "node:fs";
import * as crypto from "node:crypto";
import {initWeb, saveData} from "./dataStore.js";
import {debug} from "./debug.js";

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}
async function watchDir(metadata, pwd, port) {
    if (!metadata.email) {
        console.error('Email not set in .ovcs/ovcs.json');
        process.exit(1);
    }
    await initWeb(metadata, pwd, port);
    debug('metadata', metadata);
    if (metadata.ignore?.length > 0) {
        debug('Ignoring:', metadata.ignore);
    }
    console.log('Starting file watcher...');
    console.log('Ignored patterns:', metadata.ignore);

    const watcher = watch('.',
        {
            ignored: metadata.ignore,
            ignoreInitial: false,
            persistent: true
        });

    let initialScanCount = 0;
    let initialScanDone = false;

    watcher.on('ready', () => {
        initialScanDone = true;
        console.log(`Initial scan complete: ${initialScanCount} files found`);
    });

    watcher.on('all', async (event, path) => {
        let type = ""
        try {
            type = fs.lstatSync(path).isDirectory() ? 'dir' : 'file';
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('Error', path, err);
            }
            type = "delete"
        }
        try {
            switch (event) {
                case 'add':
                case 'change':
                    if (!initialScanDone) {
                        initialScanCount++;
                    }
                    if (type === 'file') {
                        try {
                            const data = await fs.promises.readFile(path);
                            const hash = sha256(data);
                            const base64 = data.toString('base64');
                            await saveData({id: path, type: type, hash: hash, base64: base64}, metadata);
                            if (initialScanDone) {
                                console.log(`File ${event}: ${path}`);
                            }
                            debug('add', path, hash);
                        } catch (err) {
                            if (err.code !== 'ENOENT') {
                                console.error('Error reading/saving file:', path, err.message);
                            }
                        }
                    } else {
                        await saveData({id: path, type: type}, metadata);
                        debug('add', path);
                    }
                    break;
                case 'addDir':
                    if (!initialScanDone) {
                        initialScanCount++;
                    }
                    await saveData({id: path, type: type}, metadata);
                    debug('addDir', path);
                    break;
                case 'unlink':
                    await saveData({id: path, type: type}, metadata);
                    debug('unlink', path);
                    break;
                default:
                    debug('Unhandled event:', event);
            }
        } catch (err) {
            console.error(`Error handling ${event} for ${path}:`, err.message);
        }
        debug(event, path);
    });
}
export {watchDir};