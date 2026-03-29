import WebSocket from 'ws';
import nodeDatachannel from 'node-datachannel';

// Polyfill browser globals for WebRTC in Node.js
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = WebSocket;
}
if (typeof globalThis.RTCPeerConnection === 'undefined') {
    globalThis.RTCPeerConnection = nodeDatachannel.PeerConnection;
    globalThis.RTCSessionDescription = nodeDatachannel.SessionDescription;
    globalThis.RTCIceCandidate = nodeDatachannel.IceCandidate;
}

import { replicateWebRTC, getConnectionHandlerSimplePeer } from 'rxdb/plugins/replication-webrtc';
import { debug } from './debug.js';
import { OVCSSETTINGS } from './const.js';

let p2pReplicationState = null;
let p2pPresenceReplicationState = null;

/**
 * Initialize P2P WebRTC replication for a collection.
 * Connects to the signaling server and discovers peers with the same teamId.
 */
async function initP2P(options) {
    const { filesCollection, presenceCollection, signalingServerUrl, teamId } = options;

    if (!filesCollection) {
        throw new Error('filesCollection is required for P2P replication');
    }

    if (!signalingServerUrl) {
        throw new Error('signalingServerUrl is required for P2P replication');
    }

    if (!teamId) {
        throw new Error('teamId is required for P2P replication');
    }

    console.log(`[P2P] Starting replication (team: ${teamId}, signaling: ${signalingServerUrl})`);

    try {
        // Replicate files collection via WebRTC
        p2pReplicationState = await replicateWebRTC({
            collection: filesCollection,
            topic: `ovcs-files-${teamId}`,
            connectionHandlerCreator: getConnectionHandlerSimplePeer({
                signalingServerUrl: signalingServerUrl
            }),
            pull: {},
            push: {}
        });

        // Log errors
        p2pReplicationState.error$.subscribe(err => {
            console.error('[P2P] Replication error:', err.message || err);
            debug('P2P error details:', err);
        });

        // Log peer connections/disconnections
        let previousPeerCount = 0;
        p2pReplicationState.peerStates$.subscribe(peerStates => {
            const currentCount = peerStates.size;
            if (currentCount !== previousPeerCount) {
                console.log(`[P2P] Peer count changed: ${previousPeerCount} -> ${currentCount}`);
                for (const [peerId, peerState] of peerStates.entries()) {
                    const sub = peerState.subscription;
                    if (sub) {
                        // Log activity from individual peer replication states
                        sub.error$.subscribe(err => {
                            console.error(`[P2P] Peer ${peerId} error:`, err.message || err);
                        });
                    }
                    console.log(`[P2P]   Peer ${peerId} connected`);
                }
                previousPeerCount = currentCount;
            }
        });

        // Watch collection for changes from replication
        filesCollection.$.subscribe(changeEvent => {
            if (changeEvent.isLocal) return; // skip local writes
            const op = changeEvent.operation;
            const file = changeEvent.documentData?.file || changeEvent.documentId;
            console.log(`[P2P] Received ${op}: ${file}`);
        });

        console.log('[P2P] Files replication started');

        // Optionally replicate presence collection too
        if (presenceCollection) {
            p2pPresenceReplicationState = await replicateWebRTC({
                collection: presenceCollection,
                topic: `ovcs-presence-${teamId}`,
                connectionHandlerCreator: getConnectionHandlerSimplePeer({
                    signalingServerUrl: signalingServerUrl
                }),
                pull: {},
                push: {}
            });

            p2pPresenceReplicationState.error$.subscribe(err => {
                console.error('[P2P] Presence replication error:', err.message || err);
            });

            console.log('[P2P] Presence replication started');
        }
    } catch (err) {
        console.error('[P2P] Error starting replication:', err);
        throw err;
    }
}

async function stopP2P() {
    if (p2pReplicationState) {
        await p2pReplicationState.cancel();
        p2pReplicationState = null;
        console.log('[P2P] Files replication stopped');
    }
    if (p2pPresenceReplicationState) {
        await p2pPresenceReplicationState.cancel();
        p2pPresenceReplicationState = null;
        console.log('[P2P] Presence replication stopped');
    }
}

function getP2PStatus() {
    if (!p2pReplicationState) {
        return { state: 'disconnected', peers: 0 };
    }
    return {
        state: 'active',
        peers: p2pReplicationState.peerStates$?.getValue()?.size || 0
    };
}

export { initP2P, stopP2P, getP2PStatus };
