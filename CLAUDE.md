## Description
This is an online version control and file modification toole.
It's intent is to enable teams to share real time updates on a shared codebase.
It will allow teams to understand if they are changing the same files at the same time.
The goal is to detect divergent code changes that will result in a merge conflict.
It should have two modes of operation.
* Server mode.  The process runs a web socket server that stores changes and rebroacasts to all connected clienct except the sender.
* Client mode. The process runs and detects changes in the local filesystem (rooted in current workind directory)

## Key Features:
* Minimal web server that shows activity and current conflicts in both modes
* .ovcs directory created if missing and contains ovcs.json (configuration file) and localdb (local copy of filesystem files [not necessarily content of files, hashes should be good enough)
* use mime type lookup to determine how to diff the files between local and remote incoming updates
* MCP agent that enables easy agentic integration

## Use Cases:
* Distributed teams working on different branches in the same codebase
* MCP/Agenting coding tools that need to understand if they're conflicting with each other
