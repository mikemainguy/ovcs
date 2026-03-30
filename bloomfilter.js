import crypto from 'node:crypto';

/**
 * Simple Bloom filter implementation for detecting file presence across peers.
 *
 * False positive rate is tunable via bitsPerElement:
 *   7 bits/element  = ~1% false positive
 *  10 bits/element  = ~0.1% false positive
 *  14 bits/element  = ~0.01% false positive
 *  20 bits/element  = ~0.0001% false positive
 */

const DEFAULT_BITS_PER_ELEMENT = 14; // 0.01% false positive rate
const LN2 = Math.log(2);

function optimalHashCount(bitsPerElement) {
    return Math.max(1, Math.round(bitsPerElement * LN2));
}

/**
 * Create a Bloom filter from a set of items.
 * @param {string[]} items - Array of item IDs (e.g. file hashes)
 * @param {number} bitsPerElement - Bits per element (default 14)
 * @returns {{ bits: string, size: number, hashCount: number, itemCount: number }}
 */
function createBloomFilter(items, bitsPerElement = DEFAULT_BITS_PER_ELEMENT) {
    const itemCount = items.length;
    if (itemCount === 0) {
        return { bits: '', size: 0, hashCount: 0, itemCount: 0 };
    }

    const size = itemCount * bitsPerElement;
    const hashCount = optimalHashCount(bitsPerElement);
    const bitArray = new Uint8Array(Math.ceil(size / 8));

    for (const item of items) {
        const positions = getHashPositions(item, hashCount, size);
        for (const pos of positions) {
            bitArray[pos >> 3] |= (1 << (pos & 7));
        }
    }

    // Encode as base64 for compact storage in JSON
    const bits = Buffer.from(bitArray).toString('base64');
    return { bits, size, hashCount, itemCount };
}

/**
 * Check if an item might be in the Bloom filter.
 * @param {object} filter - Bloom filter object from createBloomFilter
 * @param {string} item - Item ID to check
 * @returns {boolean} true = probably in set, false = definitely NOT in set
 */
function bloomFilterContains(filter, item) {
    if (!filter || !filter.bits || filter.size === 0) return false;

    const bitArray = Buffer.from(filter.bits, 'base64');
    const positions = getHashPositions(item, filter.hashCount, filter.size);

    for (const pos of positions) {
        if (!(bitArray[pos >> 3] & (1 << (pos & 7)))) {
            return false; // Definitely not in set
        }
    }
    return true; // Probably in set
}

/**
 * Generate hash positions for an item.
 * Uses double hashing: h(i) = (h1 + i * h2) % size
 */
function getHashPositions(item, hashCount, size) {
    const hash = crypto.createHash('sha256').update(item).digest();
    const h1 = hash.readUInt32BE(0);
    const h2 = hash.readUInt32BE(4);
    const positions = [];
    for (let i = 0; i < hashCount; i++) {
        positions.push(((h1 + i * h2) >>> 0) % size);
    }
    return positions;
}

export { createBloomFilter, bloomFilterContains };
