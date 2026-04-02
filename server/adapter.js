import https from "node:https";
import { RxServerAdapterExpress, HTTP_SERVER_BY_EXPRESS } from "rxdb-server/plugins/adapter-express";
import { getTlsOptions } from "./tls.js";

// Custom adapter — metadata-only payloads are small, default limits are fine
const OvcsExpressAdapter = {
    ...RxServerAdapterExpress
};

function buildAdapter(tls, options) {
    if (!tls) return OvcsExpressAdapter;
    return {
        ...OvcsExpressAdapter,
        async listen(serverApp, listenPort, hostname) {
            const tlsOpts = await getTlsOptions(options);
            const httpsServer = https.createServer(tlsOpts, serverApp);
            await new Promise((resolve, reject) => {
                httpsServer.listen(listenPort, hostname, () => resolve());
                httpsServer.on('error', reject);
            });
            HTTP_SERVER_BY_EXPRESS.set(serverApp, httpsServer);
        }
    };
}

export { OvcsExpressAdapter, buildAdapter };
