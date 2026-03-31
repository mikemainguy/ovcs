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

The server is the central sync and signaling hub. TLS is enabled by default with an auto-generated self-signed certificate.

```bash
# Any of these work:
ovcs-server                        # global install (TLS on by default)
npm run server                     # from project directory
ovcs --server                      # using the main CLI

# Custom port/host:
ovcs-server --port 4000 --host 0.0.0.0

# Disable TLS (plain HTTP):
ovcs-server --no-tls

# Bring your own certificates:
ovcs-server --cert /path/to/cert.pem --key /path/to/key.pem
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
  "remote": "https://localhost:5984/ovcs",
  "teamId": "my-team",
  "sync": {
    "enabled": true,
    "live": true,
    "retry": true
  }
}
```

If the server uses a self-signed certificate, see the [TLS Configuration](#tls-configuration) section below.

### 4. Start a Client (P2P Mode)

For peer-to-peer replication via WebRTC — no central data server required, just a signaling server:

```bash
ovcs --p2p
```

Configure P2P in `.ovcs/ovcs.json`:

```json
{
  "email": "you@example.com",
  "remote": "https://localhost:5984/ovcs",
  "teamId": "my-team",
  "p2p": {
    "enabled": true,
    "signalingServer": "wss://localhost:5984/signaling"
  }
}
```

The `remote` URL is used to derive the signaling server URL if `p2p.signalingServer` is not set (`https://` becomes `wss://`, `http://` becomes `ws://`). All peers with the same `teamId` will auto-discover each other and replicate directly via WebRTC DataChannels.

## Modes of Operation

| Mode | Command | How it works |
|------|---------|--------------|
| **Server** | `ovcs --server` | Central RxDB replication hub + WebSocket signaling server |
| **Client (server sync)** | `ovcs` | Watches files, syncs to server via HTTP replication |
| **Client (P2P)** | `ovcs --p2p` | Watches files, syncs directly with peers via WebRTC |

## CLI Reference

### Client Flags

| Flag | Description |
|------|-------------|
| `--p2p` | Enable P2P WebRTC replication instead of server sync |
| `--port <port>` | Web dashboard port (default: 3001) |
| `--dir <directory>` | Base directory to watch (default: `.` or `baseDirectory` from config) |
| `--allow-self-signed` | Accept self-signed TLS certificates from the server |

### Server Flags

These apply to both `ovcs --server` and `ovcs-server`:

| Flag | Description |
|------|-------------|
| `--port <port>` | Server port (default: 5984) |
| `--host <host>` | Host/IP to bind to (default: 0.0.0.0) |
| `--no-tls` | Disable TLS, run plain HTTP/WS |
| `--cert <path>` | Path to a PEM certificate file (skips self-signed generation) |
| `--key <path>` | Path to a PEM private key file (used with `--cert`) |

## Configuration (`ovcs.json`)

The configuration file lives at `.ovcs/ovcs.json` in each tracked project directory. It is created on first run.

### Core Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseDirectory` | string | `"."` | Root directory to watch for file changes |
| `clientId` | string | random UUID | Unique identifier for this client instance |
| `email` | string | `"ovcs"` | Your identity for change attribution and presence |
| `remote` | string | `""` | URL of the OVCS server (e.g. `https://host:5984/ovcs`) |
| `teamId` | string | random UUID | Team namespace — peers with the same ID discover each other |
| `ignore` | string[] | `["dist", "node_modules", ".git", ".ovcs", ".idea"]` | Paths to exclude from file watching |

### Sync Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sync.enabled` | boolean | `false` | Enable HTTP replication to the remote server |
| `sync.live` | boolean | `true` | Continuous sync (vs one-time) |
| `sync.retry` | boolean | `true` | Auto-retry on connection failure |

### P2P Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `p2p.enabled` | boolean | `false` | Enable P2P WebRTC replication |
| `p2p.signalingServer` | string | `""` | WebSocket URL for signaling (e.g. `wss://host:5984/signaling`). Derived from `remote` if empty |
| `p2p.iceServers` | array | `[]` | ICE server objects (`{urls, username, credential}`) for STUN/TURN. Uses simple-peer defaults (Google/Twilio STUN) when empty. Required for cross-NAT connectivity |

### TLS Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tls.rejectUnauthorized` | boolean | `true` | Verify server TLS certificates. Set to `false` for self-signed certs |
| `tls.caCert` | string | `""` | Path to a CA certificate PEM file to trust |

### Presence Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `presence.enabled` | boolean | `true` | Announce your presence to the team |
| `presence.heartbeatInterval` | number | `30000` | How often to send heartbeats (ms) |
| `presence.staleTimeout` | number | `120000` | Time before a silent node is marked offline (ms) |

### Compression Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `compression.enabled` | boolean | `true` | Enable data compression |
| `compression.algorithm` | string | `"gzip"` | Compression algorithm |
| `compression.level` | number | `6` | Compression level (1-9) |

### Vector Search Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vector.enabled` | boolean | `true` | Enable semantic code search indexing |
| `vector.fullText` | boolean | `true` | Index full file text for search |
| `vector.ast` | boolean | `true` | Index AST-parsed code chunks |

### Full Example

```json
{
  "baseDirectory": ".",
  "clientId": "auto-generated-uuid",
  "email": "you@example.com",
  "remote": "https://your-server:5984/ovcs",
  "teamId": "my-team-uuid",
  "ignore": ["dist", "node_modules", ".git", ".ovcs", ".idea"],
  "sync": {
    "enabled": true,
    "live": true,
    "retry": true
  },
  "p2p": {
    "enabled": false,
    "signalingServer": "",
    "iceServers": []
  },
  "tls": {
    "rejectUnauthorized": true,
    "caCert": ""
  },
  "presence": {
    "enabled": true,
    "heartbeatInterval": 30000,
    "staleTimeout": 120000
  },
  "compression": {
    "enabled": true,
    "algorithm": "gzip",
    "level": 6
  },
  "vector": {
    "enabled": true,
    "fullText": true,
    "ast": true
  }
}
```

## TLS Configuration

The server enables TLS by default. On first start it generates a self-signed certificate and saves it to `.ovcs/tls/`.

### Using self-signed certificates

**Option 1: CLI flag (quick)**
```bash
ovcs --allow-self-signed
```

**Option 2: Config (persistent)**

Set in `.ovcs/ovcs.json`:
```json
{
  "tls": {
    "rejectUnauthorized": false
  }
}
```

**Option 3: Trust the server's cert (recommended)**

Copy the server's `.ovcs/tls/cert.pem` to the client machine, then set in `.ovcs/ovcs.json`:
```json
{
  "tls": {
    "caCert": "/path/to/server-cert.pem"
  }
}
```

This trusts only that specific certificate without disabling all verification.

### Using your own certificates

```bash
ovcs-server --cert /path/to/cert.pem --key /path/to/key.pem
```

### Disabling TLS

For local development or environments where TLS is handled by a reverse proxy:

```bash
ovcs-server --no-tls
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OVCS_WEB_PORT` | `3001` | Port for the client web dashboard |
| `OVCS_SYNC_PORT` | `5984` | Port for the server sync endpoint |
| `OVCS_SYNC_HOST` | `0.0.0.0` | Host the server binds to |
| `DEBUG_OVCS` | unset | Set to `1` to enable debug output to console |
| `NODE_EXTRA_CA_CERTS` | unset | Path to additional CA certs to trust (set automatically by `tls.caCert`) |

## Data Storage

OVCS stores all local data under the `.ovcs/` directory:

| Path | Description |
|------|-------------|
| `ovcs.json` | Project configuration |
| `rxdb-data.json` | Persisted file metadata |
| `rxdb-presence.json` | Persisted presence data |
| `localdb/` | RxDB local database |
| `presencedb/` | RxDB presence database |
| `vectordb/` | Vector search index |
| `models/` | Downloaded embedding models |
| `tls/` | Auto-generated TLS certificates (server only) |
| `server-data/` | Server-side persistence (server only) |

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
