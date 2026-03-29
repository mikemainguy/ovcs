# OVCS - Online Version Control System

**Experimental - do not use in production codebases!**

Real-time collaborative version control that detects divergent code changes before they become merge conflicts. OVCS watches your local filesystem, tracks file changes across your team, and alerts you when teammates are editing the same files.

## Use Cases

- Distributed teams working on different branches in the same codebase
- MCP/agentic coding tools that need to know if they're conflicting with each other
- Any workflow where early conflict detection saves time

## Quick Start

### 1. Install

```bash
npm install -g ovcs
```

Or clone and link locally:

```bash
git clone <repo-url>
cd ovcs
npm install
npm link
```

### 2. Start the Server

The server is the central sync and signaling hub.

```bash
# Any of these work:
ovcs-server                        # global install
npm run server                     # from project directory
ovcs --server                      # using the main CLI

# Custom port/host:
ovcs-server --port 4000 --host 0.0.0.0
```

The server runs on port **5984** by default. On startup it prints connection instructions for clients.

### 3. Start a Client (Server Mode)

Run from any project directory you want to track:

```bash
cd /path/to/your/project
ovcs
```

On first run, OVCS creates a `.ovcs` directory. Edit `.ovcs/ovcs.json` to configure sync:

```json
{
  "email": "you@example.com",
  "remote": "http://localhost:5984/ovcs",
  "teamId": "my-team",
  "sync": {
    "enabled": true,
    "live": true,
    "retry": true
  }
}
```

### 4. Start a Client (P2P Mode)

For peer-to-peer replication via WebRTC — no central data server required, just a signaling server:

```bash
ovcs --p2p
```

Configure P2P in `.ovcs/ovcs.json`:

```json
{
  "email": "you@example.com",
  "remote": "http://localhost:5984/ovcs",
  "teamId": "my-team",
  "p2p": {
    "enabled": true,
    "signalingServer": "ws://localhost:5984/signaling"
  }
}
```

The `remote` URL is used to derive the signaling server URL if `p2p.signalingServer` is not set. All peers with the same `teamId` will auto-discover each other and replicate directly via WebRTC DataChannels.

## Modes of Operation

| Mode | Command | How it works |
|------|---------|--------------|
| **Server** | `ovcs --server` | Central RxDB replication hub + WebSocket signaling server |
| **Client (server sync)** | `ovcs` | Watches files, syncs to server via HTTP replication |
| **Client (P2P)** | `ovcs --p2p` | Watches files, syncs directly with peers via WebRTC |

## Configuration

The configuration file lives at `.ovcs/ovcs.json` in each tracked project directory.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `email` | string | `"ovcs"` | Your identity for change attribution |
| `remote` | string | `""` | URL of the OVCS server (e.g. `http://host:5984/ovcs`) |
| `teamId` | string | random UUID | Team namespace for peer discovery |
| `sync.enabled` | boolean | `false` | Enable replication to the remote server |
| `sync.live` | boolean | `true` | Continuous sync (vs one-time) |
| `sync.retry` | boolean | `true` | Auto-retry on connection failure |
| `p2p.enabled` | boolean | `false` | Enable P2P WebRTC replication |
| `p2p.signalingServer` | string | `""` | WebSocket URL for signaling (derived from `remote` if empty) |
| `presence.enabled` | boolean | `true` | Announce your presence to the team |
| `presence.heartbeatInterval` | number | `30000` | Heartbeat interval in ms |
| `presence.staleTimeout` | number | `120000` | Time before a node is considered offline |
| `vector.enabled` | boolean | `true` | Enable semantic code search indexing |
| `vector.fullText` | boolean | `true` | Index full file text |
| `vector.ast` | boolean | `true` | Index AST-parsed code chunks |
| `ignore` | string[] | `["dist", "node_modules", ".git", ".ovcs", ".idea"]` | Paths to ignore |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OVCS_WEB_PORT` | `3001` | Port for the client web dashboard |
| `OVCS_SYNC_PORT` | `5984` | Port for the server sync endpoint |
| `OVCS_SYNC_HOST` | `0.0.0.0` | Host the server binds to |
| `DEBUG_OVCS` | unset | Set to `1` to enable debug output to console |

## Team Presence

When presence is enabled, OVCS tracks who is online and what files they are editing. All team members with the same `teamId` can see each other (in both server and P2P modes).

Presence information includes:
- Who is online (email, hostname)
- What files they are currently editing
- When they were last active

Nodes that stop sending heartbeats are automatically marked offline after the stale timeout (default: 2 minutes).

## Web Dashboard

Each client serves a web dashboard on `OVCS_WEB_PORT` (default: 3001):

| Endpoint | Description |
|----------|-------------|
| `/` | Dashboard with team presence, DB info, and sync status |
| `/diff.html` | Visual diff viewer showing conflicts between revisions |
| `/presence` | JSON list of active team members |
| `/data` | All tracked documents |
| `/diff` | Documents with divergent revisions |
| `/info` | Database info |
| `/sync-status` | Current sync state |

The server also exposes:

| Endpoint | Description |
|----------|-------------|
| `/ovcs/status` | Server health check |
| `/ovcs/presence` | All active nodes across all teams |
| `/replication/files` | RxDB replication endpoint for file data |
| `/replication/presence` | RxDB replication endpoint for presence data |
| `/signaling` | WebSocket signaling server for P2P peer discovery |

## Architecture

### Server Mode
```
  Local Files
      |
  [chokidar watcher]
      |
  Local RxDB  <-- RxDB HTTP replication -->  Server (RxDB Server + Express)
      |                                              |
  Web Dashboard                                 Other Clients
```

### P2P Mode
```
  Local Files                                    Local Files
      |                                              |
  [chokidar]                                    [chokidar]
      |                                              |
  Local RxDB  <-- WebRTC DataChannel -->       Local RxDB
      |              (signaling via server)           |
  Web Dashboard                                 Web Dashboard
```

- **Client mode**: Watches the filesystem, hashes files, stores metadata in a local RxDB database, and replicates to the server or peers
- **Server mode**: Runs an RxDB Server with Express that provides replication endpoints and WebSocket signaling for P2P
- **P2P mode**: Peers discover each other through the signaling server, then sync directly via WebRTC DataChannels — data never passes through the server
- **Conflict resolution**: RxDB's built-in conflict handler merges per-user revisions, keeping the most recent changes from each team member

## License

MIT
