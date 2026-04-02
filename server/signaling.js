import { WebSocketServer } from "ws";
import { SIMPLE_PEER_PING_INTERVAL } from 'rxdb/plugins/replication-webrtc';
import { debug } from "../debug.js";

const PEER_ID_LENGTH = 12;

function randomToken(length) {
    let result = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function setupSignaling(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/signaling' });
    const peerById = new Map();
    const peersByRoom = new Map();

    function sendMsg(ws, msg) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(msg));
        }
    }

    function disconnectPeer(peerId, reason) {
        debug(`[Signaling] Disconnect peer ${peerId}: ${reason}`);
        const peer = peerById.get(peerId);
        if (peer) {
            peer.rooms.forEach(roomId => {
                const room = peersByRoom.get(roomId);
                if (room) {
                    room.delete(peerId);
                    if (room.size === 0) peersByRoom.delete(roomId);
                }
            });
            try { peer.socket.close(); } catch (e) {}
        }
        peerById.delete(peerId);
    }

    // Clean up stale peers that stopped pinging
    const pingInterval = setInterval(() => {
        const minTime = Date.now() - (SIMPLE_PEER_PING_INTERVAL || 120000);
        for (const [peerId, peer] of peerById) {
            if (peer.lastPing < minTime) {
                disconnectPeer(peerId, 'no ping');
            }
        }
    }, 5000);

    wss.on('close', () => {
        clearInterval(pingInterval);
        peerById.clear();
        peersByRoom.clear();
    });

    wss.on('connection', (ws) => {
        const peerId = randomToken(PEER_ID_LENGTH);
        const peer = { id: peerId, socket: ws, rooms: new Set(), lastPing: Date.now() };
        peerById.set(peerId, peer);

        // Send init with assigned peerId
        sendMsg(ws, { type: 'init', yourPeerId: peerId });
        debug(`[Signaling] Peer connected: ${peerId}`);

        ws.on('error', (err) => {
            console.error(`[Signaling] Peer ${peerId} error:`, err.message);
            disconnectPeer(peerId, 'socket error');
        });

        ws.on('close', () => {
            disconnectPeer(peerId, 'disconnected');
        });

        ws.on('message', (raw) => {
            peer.lastPing = Date.now();
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch (e) {
                return;
            }

            switch (msg.type) {
                case 'join': {
                    const roomId = msg.room;
                    if (!roomId || roomId.length < 5) {
                        disconnectPeer(peerId, 'invalid room id');
                        return;
                    }
                    peer.rooms.add(roomId);
                    if (!peersByRoom.has(roomId)) {
                        peersByRoom.set(roomId, new Set());
                    }
                    const room = peersByRoom.get(roomId);
                    room.add(peerId);

                    debug(`[Signaling] Peer ${peerId} joined room ${roomId} (${room.size} peers)`);

                    // Tell all peers in the room about the current roster
                    for (const otherPeerId of room) {
                        const otherPeer = peerById.get(otherPeerId);
                        if (otherPeer) {
                            sendMsg(otherPeer.socket, {
                                type: 'joined',
                                otherPeerIds: Array.from(room)
                            });
                        }
                    }
                    break;
                }
                case 'signal': {
                    if (msg.senderPeerId !== peerId) {
                        disconnectPeer(peerId, 'spoofed sender');
                        return;
                    }
                    const receiver = peerById.get(msg.receiverPeerId);
                    if (receiver) {
                        sendMsg(receiver.socket, msg);
                    }
                    break;
                }
                case 'ping':
                    break;
                default:
                    debug(`[Signaling] Unknown message type from ${peerId}: ${msg.type}`);
            }
        });
    });

    debug('WebSocket signaling server attached at /signaling');
}

export { setupSignaling };
