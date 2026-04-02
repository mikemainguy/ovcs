import fs from "node:fs";
import os from "node:os";
import selfsigned from "selfsigned";
import { OVCSSETTINGS } from "../const.js";
import { debug } from "../debug.js";

const TLS_DIR = `./${OVCSSETTINGS.ROOT_DIR}/tls`;

function getNetworkAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = new Set(['127.0.0.1', '::1']);
    for (const nets of Object.values(interfaces)) {
        for (const net of nets) {
            addresses.add(net.address);
        }
    }
    return Array.from(addresses);
}

async function loadOrGenerateCert() {
    const certPath = `${TLS_DIR}/cert.pem`;
    const keyPath = `${TLS_DIR}/key.pem`;

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return {
            cert: fs.readFileSync(certPath, 'utf-8'),
            key: fs.readFileSync(keyPath, 'utf-8')
        };
    }

    debug('[TLS] Generating self-signed certificate...');
    const hostname = os.hostname();
    const addresses = getNetworkAddresses();

    const altNames = [
        { type: 2, value: 'localhost' },
        { type: 2, value: hostname },
        ...addresses.map(ip => ({ type: 7, ip }))
    ];

    debug(`[TLS] SANs: localhost, ${hostname}, ${addresses.join(', ')}`);

    const attrs = [{ name: 'commonName', value: hostname }];
    const pems = await selfsigned.generate(attrs, {
        days: 365,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
            { name: 'subjectAltName', altNames }
        ]
    });

    fs.mkdirSync(TLS_DIR, { recursive: true });
    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(keyPath, pems.private);
    debug(`[TLS] Certificate saved to ${TLS_DIR}/`);

    return { cert: pems.cert, key: pems.private };
}

async function getTlsOptions(options) {
    if (options.cert && options.key) {
        return {
            cert: fs.readFileSync(options.cert, 'utf-8'),
            key: fs.readFileSync(options.key, 'utf-8')
        };
    }
    return await loadOrGenerateCert();
}

export { getNetworkAddresses, loadOrGenerateCert, getTlsOptions };
