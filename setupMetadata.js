import fs, {existsSync} from "node:fs";
import crypto from "node:crypto";
import {debug} from "./debug.js";
import {OVCSSETTINGS} from "./const.js";
const defaultMetadata = {
    'baseDirectory': '.',
    'clientId': crypto.randomUUID(),
    'email': 'ovcs',
    'remote': '',
    'teamId': crypto.randomUUID(),
    'compression': {
        'enabled': true,
        'algorithm': OVCSSETTINGS.DEFAULT_COMPRESSION_ALGORITHM,
        'level': OVCSSETTINGS.DEFAULT_COMPRESSION_LEVEL
    },
    'ignore': ['dist', 'node_modules', '.git', '.ovcs', '.idea'],
    'vector': {
        'enabled': true,
        'fullText': true,
        'ast': true
    },
    'sync': {
        'enabled': false,
        'live': true,
        'retry': true
    },
    'presence': {
        'enabled': true,
        'heartbeatInterval': OVCSSETTINGS.HEARTBEAT_INTERVAL,
        'staleTimeout': OVCSSETTINGS.STALE_TIMEOUT
    },
    'p2p': {
        'enabled': false,
        'signalingServer': ''
    }
}
function setupMetadata(override, pwd) {
    const dir = `${pwd}/${OVCSSETTINGS.ROOT_DIR}`;
    const exists = existsSync(dir);
    if (exists && !override) {
        debug('.ovcs directory already exists');
        const metadata = JSON.parse(fs.readFileSync(`${dir}/ovcs.json`).toString('utf-8'));
        debug(metadata);
        return metadata;
    } else {
        fs.mkdirSync(dir);
        debug('.ovc directory created');
        fs.writeFileSync(`${dir}/ovcs.json`, JSON.stringify(defaultMetadata));
        return defaultMetadata;
    }
}

export {setupMetadata};