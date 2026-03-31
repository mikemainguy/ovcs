import fs, {existsSync} from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
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
    },
    'tls': {
        'rejectUnauthorized': true,
        'caCert': ''
    }
}
function detectGitInfo(pwd) {
    try {
        const root = execSync('git rev-parse --show-toplevel', { cwd: pwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: pwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
        const commitHash = execSync('git rev-parse HEAD', { cwd: pwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
        debug(`Git detected: ${root} (${branch} @ ${commitHash.substring(0, 8)})`);
        return { inRepo: true, root, branch, commitHash };
    } catch (e) {
        debug('Not a git repository');
        return { inRepo: false, root: null, branch: null, commitHash: null };
    }
}

function setupMetadata(override, pwd) {
    const dir = `${pwd}/${OVCSSETTINGS.ROOT_DIR}`;
    const configFile = `${dir}/ovcs.json`;
    const configExists = existsSync(configFile);
    let metadata;
    if (configExists && !override) {
        debug('.ovcs config already exists');
        metadata = JSON.parse(fs.readFileSync(configFile).toString('utf-8'));
        debug(metadata);
    } else {
        fs.mkdirSync(dir, { recursive: true });
        debug('.ovcs directory created');
        fs.writeFileSync(configFile, JSON.stringify(defaultMetadata, null, 2));
        metadata = { ...defaultMetadata };
    }
    // Detect git info (always fresh, not persisted)
    metadata.git = detectGitInfo(pwd);
    return metadata;
}

function configureTls(metadata) {
    const tlsConfig = metadata.tls;
    if (!tlsConfig) return;

    if (tlsConfig.caCert) {
        // NODE_EXTRA_CA_CERTS must be set before the first TLS connection
        process.env.NODE_EXTRA_CA_CERTS = tlsConfig.caCert;
        debug(`TLS: trusting CA cert from ${tlsConfig.caCert}`);
    }

    if (tlsConfig.rejectUnauthorized === false) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const remote = metadata.remote || '';
        const signaling = metadata.p2p?.signalingServer || '';
        if (remote.startsWith('https://') || signaling.startsWith('wss://')) {
            console.warn('[WARNING] TLS certificate verification is disabled (rejectUnauthorized=false). This makes connections vulnerable to man-in-the-middle attacks. Consider using tls.caCert to trust a specific certificate instead.');
        }
        debug('TLS: certificate verification disabled (rejectUnauthorized=false)');
    }
}

export {setupMetadata, configureTls};