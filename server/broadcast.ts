import type { WebSocket } from "ws";

type Client = WebSocket;
const clients = new Set<Client>();

export function addClient(ws: Client): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

export function broadcast(event: string, data: unknown): void {
  const payload = JSON.stringify({ event, data, at: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}
