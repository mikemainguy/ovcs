import WebSocket from 'ws';

// Polyfill WebSocket for Node.js
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = WebSocket;
}

// Import wrtc for Node.js WebRTC support, with simple-peer compatibility patches
let wrtc;
try {
    const ndc = await import('node-datachannel/polyfill');

    function patchDescription(desc) {
        return { type: desc.type, sdp: desc.sdp };
    }

    const OriginalRTCPeerConnection = ndc.RTCPeerConnection;
    class PatchedRTCPeerConnection extends OriginalRTCPeerConnection {
        async createOffer(options) {
            return patchDescription(await super.createOffer(options));
        }
        async createAnswer(options) {
            return patchDescription(await super.createAnswer(options));
        }
    }

    class PatchedRTCSessionDescription {
        constructor(init) { this.type = init?.type; this.sdp = init?.sdp; }
        toJSON() { return { type: this.type, sdp: this.sdp }; }
    }

    wrtc = {
        RTCPeerConnection: PatchedRTCPeerConnection,
        RTCSessionDescription: PatchedRTCSessionDescription,
        RTCIceCandidate: ndc.RTCIceCandidate
    };
    debug('[P2P] node-datachannel polyfill loaded');
} catch (e) {
    try {
        wrtc = (await import('wrtc')).default;
        debug('[P2P] wrtc loaded');
    } catch (e2) {
        console.warn('[P2P] No WebRTC implementation found. P2P will not work in Node.js.');
    }
}

import { replicateWebRTC, getConnectionHandlerSimplePeer } from 'rxdb/plugins/replication-webrtc';
import { debug } from './debug.js';
import { OVCSSETTINGS } from './const.js';
import { onRemoteDocChange } from './dataStore.js';
import fs from 'node:fs';
import * as path from 'node:path';

let p2pReplicationState = null;
let p2pPresenceReplicationState = null;
let localFilesCollection = null;
let localBaseDirectory = '.';

// Content request state
const CHUNK_SIZE = 64 * 1024;
const CONTENT_PREFIX = 'OVCS_CONTENT:';
const connectedPeers = new Map(); // peerId -> simple-peer instance
const pendingContentRequests = new Map(); // requestId -> { resolve, reject, chunks: [], total }

// --- Content Protocol (over simple-peer data channel with prefix) ---

function sendContentMessage(peer, msg) {
    const raw = CONTENT_PREFIX + JSON.stringify(msg);
    try {
        peer.send(raw);
    } catch (err) {
        debug('[P2P] Error sending content message:', err.message);
    }
}

function handleContentData(peerId, peer, raw) {
    // Only handle our prefixed messages
    if (typeof raw !== 'string') raw = raw.toString();
    if (!raw.startsWith(CONTENT_PREFIX)) return false; // Not ours — let RxDB handle it

    try {
        const msg = JSON.parse(raw.slice(CONTENT_PREFIX.length));
        if (msg.type === 'req') {
            handleContentRequest(msg, peer);
        } else if (msg.type === 'res') {
            handleContentResponse(msg);
        }
    } catch (err) {
        console.error('[P2P] Content message parse error:', err.message);
    }
    return true; // We handled it
}

async function handleContentRequest(msg, peer) {
    const { id, fileId } = msg;
    debug(`[P2P] Content request received for ${fileId}`);

    if (!localFilesCollection) {
        sendContentMessage(peer, { type: 'res', id, total: 1, index: 0, data: '' });
        return;
    }

    try {
        const doc = await localFilesCollection.findOne(fileId).exec();
        const d = doc?.toJSON();
        let content = '';

        // Read from local disk
        if (d?.file) {
            const filePath = path.resolve(localBaseDirectory, d.file);
            if (fs.existsSync(filePath)) {
                content = fs.readFileSync(filePath, 'utf-8');
                debug(`[P2P] Read ${d.file} from disk (${Math.round(content.length / 1024)}KB)`);
            }
        }

        if (!content) {
            debug(`[P2P] No content available for ${fileId}`);
            sendContentMessage(peer, { type: 'res', id, total: 1, index: 0, data: '' });
            return;
        }

        // Chunk and send
        const totalChunks = Math.ceil(content.length / CHUNK_SIZE) || 1;
        debug(`[P2P] Sending ${totalChunks} chunks for ${fileId} (${Math.round(content.length / 1024)}KB)`);

        for (let i = 0; i < totalChunks; i++) {
            const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            sendContentMessage(peer, { type: 'res', id, total: totalChunks, index: i, data: chunk });
        }
    } catch (err) {
        console.error('[P2P] Error handling content request:', err);
        sendContentMessage(peer, { type: 'res', id, total: 1, index: 0, data: '' });
    }
}

function handleContentResponse(msg) {
    const { id, total, index, data } = msg;
    const pending = pendingContentRequests.get(id);
    if (!pending) return;

    pending.chunks[index] = data;
    pending.total = total;

    const received = pending.chunks.filter(c => c !== undefined).length;
    if (received === total) {
        const assembled = pending.chunks.join('');
        pendingContentRequests.delete(id);
        pending.resolve(assembled);
        debug(`[P2P] Content received: ${Math.round(assembled.length / 1024)}KB in ${total} chunks`);
    }
}

async function fetchContentFromPeer(fileId) {
    for (const [peerId, peer] of connectedPeers) {
        if (peer.destroyed) continue;

        try {
            const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const promise = new Promise((resolve, reject) => {
                pendingContentRequests.set(requestId, { resolve, reject, chunks: [], total: 0 });
                setTimeout(() => {
                    if (pendingContentRequests.has(requestId)) {
                        pendingContentRequests.delete(requestId);
                        debug(`[P2P] Content request ${requestId} timed out`);
                        reject(new Error('Content request timeout'));
                    }
                }, 30000);
            });

            debug(`[P2P] Requesting content for ${fileId} from peer ${peerId}`);
            sendContentMessage(peer, { type: 'req', id: requestId, fileId });

            const result = await promise;
            if (result) return result;
        } catch (err) {
            debug(`[P2P] Content fetch from peer ${peerId} failed:`, err.message);
        }
    }

    return '';
}

// --- P2P Replication Setup ---

async function initP2P(options) {
    const { filesCollection, presenceCollection, signalingServerUrl, teamId, baseDirectory, iceServers } = options;
    localFilesCollection = filesCollection;
    localBaseDirectory = baseDirectory || '.';

    if (!filesCollection) throw new Error('filesCollection is required');
    if (!signalingServerUrl) throw new Error('signalingServerUrl is required');
    if (!teamId) throw new Error('teamId is required');

    const peerConfig = (iceServers && iceServers.length > 0)
        ? { config: { iceServers } }
        : {};

    debug(`[P2P] Starting replication (team: ${teamId}, signaling: ${signalingServerUrl})`);

    try {
        // Create a custom connection handler that intercepts content messages
        const baseCreator = getConnectionHandlerSimplePeer({
            signalingServerUrl,
            wrtc,
            webSocketConstructor: WebSocket,
            ...peerConfig
        });

        const wrappedCreator = async (opts) => {
            const handler = await baseCreator(opts);

            // Intercept connect$ to hook into each peer's data events
            const originalConnect$ = handler.connect$;
            const { Subject } = await import('rxjs');
            const wrappedConnect$ = new Subject();

            originalConnect$.subscribe(peer => {
                const peerId = peer.id || 'unknown';
                connectedPeers.set(peerId, peer);
                debug(`[P2P] Peer ${peerId} data channel connected — hooking content handler`);

                // Hook into the raw data event to intercept content messages
                // simple-peer emits 'data' for all incoming messages
                const originalEmit = peer.emit.bind(peer);
                peer.emit = function(event, ...args) {
                    if (event === 'data' && args[0]) {
                        const raw = typeof args[0] === 'string' ? args[0] : args[0].toString();
                        if (raw.startsWith(CONTENT_PREFIX)) {
                            handleContentData(peerId, peer, raw);
                            return true; // Swallow — don't pass to RxDB
                        }
                    }
                    return originalEmit(event, ...args);
                };

                wrappedConnect$.next(peer);
            });

            // Intercept disconnect$ to clean up
            handler.disconnect$.subscribe(peer => {
                const peerId = peer?.id || 'unknown';
                connectedPeers.delete(peerId);
            });

            return {
                ...handler,
                connect$: wrappedConnect$
            };
        };

        // Replicate files metadata
        p2pReplicationState = await replicateWebRTC({
            collection: filesCollection,
            topic: `ovcs-files-${teamId}`,
            connectionHandlerCreator: wrappedCreator,
            pull: {},
            push: {}
        });

        p2pReplicationState.error$.subscribe(err => {
            console.error('[P2P] Replication error:', err.message || err);
            debug('P2P error details:', err);
        });

        // Log peer state changes
        let previousPeerCount = 0;
        p2pReplicationState.peerStates$.subscribe(peerStates => {
            const currentCount = peerStates.size;
            if (currentCount !== previousPeerCount) {
                debug(`[P2P] Peer count changed: ${previousPeerCount} -> ${currentCount}`);
                previousPeerCount = currentCount;
            }
        });

        // Listen for incoming remote docs and add local revision
        filesCollection.$.subscribe(changeEvent => onRemoteDocChange(changeEvent));

        debug('[P2P] Files replication started');

        // Replicate presence if provided
        if (presenceCollection) {
            p2pPresenceReplicationState = await replicateWebRTC({
                collection: presenceCollection,
                topic: `ovcs-presence-${teamId}`,
                connectionHandlerCreator: getConnectionHandlerSimplePeer({
                    signalingServerUrl,
                    wrtc,
                    webSocketConstructor: WebSocket,
                    ...peerConfig
                }),
                pull: {},
                push: {}
            });

            p2pPresenceReplicationState.error$.subscribe(err => {
                console.error('[P2P] Presence replication error:', err.message || err);
            });

            debug('[P2P] Presence replication started');
        }
    } catch (err) {
        console.error('[P2P] Error starting replication:', err);
        throw err;
    }
}

async function stopP2P() {
    connectedPeers.clear();
    pendingContentRequests.clear();

    if (p2pReplicationState) {
        await p2pReplicationState.cancel();
        p2pReplicationState = null;
        debug('[P2P] Files replication stopped');
    }
    if (p2pPresenceReplicationState) {
        await p2pPresenceReplicationState.cancel();
        p2pPresenceReplicationState = null;
        debug('[P2P] Presence replication stopped');
    }
}

function getP2PStatus() {
    if (!p2pReplicationState) {
        return { state: 'disconnected', peers: 0, contentPeers: 0 };
    }
    return {
        state: 'active',
        peers: p2pReplicationState.peerStates$?.getValue()?.size || 0,
        contentPeers: connectedPeers.size
    };
}

export { initP2P, stopP2P, getP2PStatus, fetchContentFromPeer };
