# Starting Daniel Locally

Use this from the repository root:

```bash
npx npm-run-all --parallel start dev:convex dev:debug
```

This starts the product stack:

- API/iMessage server: http://localhost:3456
- Debug dashboard: http://localhost:5173
- Convex dev watcher/functions

Do not use `npm run dev` in this environment unless the watcher issue has been fixed. It can fail with `EMFILE: too many open files` because it starts the server through Node watch mode.

## Verify

```bash
curl -sS http://localhost:3456/health
curl -sS -I http://localhost:5173/
```

Expected server health:

```json
{"ok":true,"service":"daniel"}
```

Expected startup log lines:

```text
daniel server listening on :3456
[spectrum.lifecycle] Spectrum started
[imessage] Photon Spectrum bridge listening
Convex functions ready
```

## Stop

Find the running stack:

```bash
pgrep -fl 'convex dev|npm-run-all|node --import tsx server/index.ts|vite --config debug/vite.config.ts'
```

Then kill the listed PIDs, or stop the terminal session with `Ctrl-C`.

Verify ports are closed:

```bash
lsof -nP -iTCP:3456 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

No output means the local stack is stopped.
