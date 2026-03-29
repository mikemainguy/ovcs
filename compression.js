import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { debug } from './debug.js';
import { OVCSSETTINGS } from './const.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * Compress a Buffer using the configured algorithm.
 * @param {Buffer} buffer - Raw file content
 * @param {Object} config - Compression config from metadata.compression
 * @returns {{ data: Buffer, method: string }} - Compressed data + method identifier
 */
async function compress(buffer, config) {
    if (!config?.enabled) {
        return { data: buffer, method: 'none' };
    }

    const algorithm = config.algorithm || OVCSSETTINGS.DEFAULT_COMPRESSION_ALGORITHM;
    const level = config.level ?? OVCSSETTINGS.DEFAULT_COMPRESSION_LEVEL;

    try {
        if (algorithm === 'brotli') {
            const compressed = await brotliCompress(buffer, {
                params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: Math.min(Math.max(level, 0), 11)
                }
            });
            debug(`Compressed ${buffer.length} -> ${compressed.length} bytes (brotli, level ${level})`);
            return { data: compressed, method: 'brotli' };
        } else {
            // Default: gzip
            const compressed = await gzip(buffer, {
                level: Math.min(Math.max(level, 1), 9)
            });
            debug(`Compressed ${buffer.length} -> ${compressed.length} bytes (gzip, level ${level})`);
            return { data: compressed, method: 'gzip' };
        }
    } catch (err) {
        debug('Compression failed, storing uncompressed:', err.message);
        return { data: buffer, method: 'none' };
    }
}

/**
 * Decompress a base64-encoded string back to the original file content.
 * @param {string} base64 - Base64-encoded (possibly compressed) data
 * @param {string} method - Compression method: "gzip", "brotli", or "none"/undefined
 * @returns {Buffer} - Original file content
 */
async function decompress(base64, method) {
    const buffer = Buffer.from(base64, 'base64');

    if (!method || method === 'none') {
        return buffer;
    }

    try {
        if (method === 'brotli') {
            return await brotliDecompress(buffer);
        } else if (method === 'gzip') {
            return await gunzip(buffer);
        } else {
            debug(`Unknown compression method "${method}", returning raw buffer`);
            return buffer;
        }
    } catch (err) {
        debug(`Decompression failed (${method}):`, err.message);
        // Fall back to treating as raw data
        return buffer;
    }
}

export { compress, decompress };
