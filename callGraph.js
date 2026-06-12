import { debug } from './debug.js';

class CallGraph {
    constructor() {
        // Forward edges: caller_id -> Set<callee_id>
        this.callees = new Map();
        // Reverse edges: callee_id -> Set<caller_id>
        this.callers = new Map();
        // Node metadata: id -> { name, file, type }
        this.nodeInfo = new Map();
        // File -> edge IDs for incremental cleanup: file_id -> Set<edge_id>
        this.fileEdges = new Map();
        // Edge metadata: edge_id -> { caller_id, callee_id, call_line, call_type }
        this.edgeInfo = new Map();
    }

    addNode(id, name, file, type, sourceModule = '') {
        this.nodeInfo.set(id, { name, file, type, sourceModule });
    }

    addEdge(edgeId, callerId, calleeId, fileId, metadata = {}) {
        // Forward edge
        if (!this.callees.has(callerId)) {
            this.callees.set(callerId, new Set());
        }
        this.callees.get(callerId).add(calleeId);

        // Reverse edge
        if (!this.callers.has(calleeId)) {
            this.callers.set(calleeId, new Set());
        }
        this.callers.get(calleeId).add(callerId);

        // Track edge by file for incremental cleanup
        if (!this.fileEdges.has(fileId)) {
            this.fileEdges.set(fileId, new Set());
        }
        this.fileEdges.get(fileId).add(edgeId);

        // Store edge metadata
        this.edgeInfo.set(edgeId, { callerId, calleeId, fileId, ...metadata });
    }

    removeEdgesForFile(fileId) {
        const edges = this.fileEdges.get(fileId);
        if (!edges) return;

        for (const edgeId of edges) {
            const edge = this.edgeInfo.get(edgeId);
            if (!edge) continue;

            const { callerId, calleeId } = edge;

            // Remove forward edge
            const calleeSet = this.callees.get(callerId);
            if (calleeSet) {
                calleeSet.delete(calleeId);
                if (calleeSet.size === 0) this.callees.delete(callerId);
            }

            // Remove reverse edge
            const callerSet = this.callers.get(calleeId);
            if (callerSet) {
                callerSet.delete(callerId);
                if (callerSet.size === 0) this.callers.delete(calleeId);
            }

            this.edgeInfo.delete(edgeId);
        }

        this.fileEdges.delete(fileId);
    }

    getDirectCallers(nodeId) {
        return this.callers.get(nodeId) || new Set();
    }

    getDirectCallees(nodeId) {
        return this.callees.get(nodeId) || new Set();
    }

    getTransitiveCallers(nodeId, maxDepth = 10) {
        return this._bfs(nodeId, this.callers, maxDepth);
    }

    getTransitiveCallees(nodeId, maxDepth = 10) {
        return this._bfs(nodeId, this.callees, maxDepth);
    }

    _bfs(startId, adjacency, maxDepth) {
        const result = [];
        const visited = new Set([startId]);
        let frontier = [startId];

        for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
            const nextFrontier = [];
            for (const nodeId of frontier) {
                const neighbors = adjacency.get(nodeId);
                if (!neighbors) continue;
                for (const neighbor of neighbors) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        nextFrontier.push(neighbor);
                        const info = this.nodeInfo.get(neighbor) || { name: neighbor, file: '', type: '' };
                        result.push({ id: neighbor, depth, ...info });
                    }
                }
            }
            frontier = nextFrontier;
        }

        return result;
    }

    getCallPaths(fromId, toId, maxDepth = 10) {
        const paths = [];
        const currentPath = [fromId];

        const dfs = (nodeId, depth) => {
            if (depth > maxDepth) return;
            if (nodeId === toId) {
                paths.push([...currentPath]);
                return;
            }

            const neighbors = this.callees.get(nodeId);
            if (!neighbors) return;

            for (const neighbor of neighbors) {
                if (currentPath.includes(neighbor)) continue; // cycle detection
                currentPath.push(neighbor);
                dfs(neighbor, depth + 1);
                currentPath.pop();
            }
        };

        dfs(fromId, 0);
        return paths.map(p => p.map(id => ({
            id,
            ...(this.nodeInfo.get(id) || { name: id, file: '', type: '' })
        })));
    }

    findNodeByName(name) {
        const matches = [];
        for (const [id, info] of this.nodeInfo) {
            if (info.name === name) {
                matches.push({ id, ...info });
            }
        }
        return matches;
    }

    getStats() {
        let resolvedEdges = 0;
        let unresolvedEdges = 0;
        for (const edge of this.edgeInfo.values()) {
            if (edge.resolved) resolvedEdges++;
            else unresolvedEdges++;
        }

        return {
            nodes: this.nodeInfo.size,
            edges: this.edgeInfo.size,
            resolvedEdges,
            unresolvedEdges,
            files: this.fileEdges.size
        };
    }

    clear() {
        this.callees.clear();
        this.callers.clear();
        this.nodeInfo.clear();
        this.fileEdges.clear();
        this.edgeInfo.clear();
    }
}

// Singleton instance
const callGraph = new CallGraph();

export { CallGraph, callGraph };
