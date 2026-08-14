import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { normalizeE164, startImessageBridge } from "./imessage.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { createMemoryRouter } from "./memory-routes.js";
import { createBrowserRouter } from "./browser-routes.js";
import { closeLocalBrowser } from "./browser/launcher.js";
import { createChangelogRouter } from "./changelog.js";
import {
  getRuntimeConfig,
  resolveModelInput,
  resolveReasoningEffortInput,
  resolveRuntimeInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "./runtime-config.js";
import { startImageCleanup } from "./images/clean.js";
import { convex } from "./convex-client.js";
import {
  startConfiguredMemorySyncWorker,
  type MemorySyncWorker,
} from "./memory/supermemory/sync-worker.js";
import { startCaptureRecoveryReplay } from "./memory/supermemory/capture-recovery.js";
import { normalizeMemoryOwnerId } from "./memory/supermemory/identity.js";
import { isLocalMemoryRouteRequest } from "./memory/supermemory/routes.js";
import type { NextFunction, Request, Response } from "express";

interface ChatMemoryOwnerEnvironment {
  NODE_ENV?: string;
}

/**
 * Resolves the private memory owner at the local HTTP boundary. Direct-message
 * conversation IDs can safely derive the same canonical phone used by the
 * iMessage bridge. Other production callers must supply an explicit owner;
 * the shared local development identity is never accepted in production.
 */
export function resolveChatMemoryOwnerId(
  input: { conversationId: unknown; memoryOwnerId: unknown },
  env: ChatMemoryOwnerEnvironment = process.env,
): string | null {
  const isProduction = env.NODE_ENV?.trim().toLowerCase() === "production";
  if (typeof input.memoryOwnerId === "string" && input.memoryOwnerId.trim()) {
    try {
      const rawOwnerId = input.memoryOwnerId.trim();
      const normalizedPhone = /^[+()\d\s.-]+$/.test(rawOwnerId)
        ? normalizeE164(rawOwnerId)
        : undefined;
      const ownerId = normalizeMemoryOwnerId(normalizedPhone ?? rawOwnerId);
      return isProduction && ownerId === "local-default" ? null : ownerId;
    } catch {
      return null;
    }
  }

  if (typeof input.conversationId === "string" && input.conversationId.startsWith("sms:")) {
    const phone = normalizeE164(input.conversationId.slice("sms:".length));
    if (phone && /^\+[1-9]\d{7,14}$/.test(phone)) return phone;
  }

  return isProduction ? null : "local-default";
}

/** Browser origins allowed to call the local control API. */
export function isAllowedControlOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "0:0:0:0:0:0:0:1" ||
      /^127\./.test(hostname)
    );
  } catch {
    return false;
  }
}

function requireLocalControl(req: Request, res: Response, next: NextFunction): void {
  if (isLocalMemoryRouteRequest(req.headers, req.socket.remoteAddress ?? "")) {
    next();
    return;
  }
  res.status(403).json({
    ok: false,
    error: {
      code: "forbidden",
      message: "Daniel control routes are only available locally.",
    },
  });
}

async function main() {
  await loadIntegrations();
  startAutomationLoop();
  startHeartbeatLoop();
  startImageCleanup();
  const captureRecovery = startCaptureRecoveryReplay();
  let memorySyncWorker: MemorySyncWorker | null = null;
  try {
    const memorySync = await startConfiguredMemorySyncWorker({
      client: convex,
      onError: (err) => console.error("[supermemory-sync] startup/worker error", err),
    });
    memorySyncWorker = memorySync.worker;
    if (memorySync.reason === "started") {
      console.log(`[supermemory-sync] worker started (${memorySync.backlog.total} queued)`);
    }
  } catch (err) {
    // The server and legacy Convex memory path stay available. Any durable
    // jobs already in Convex remain pending for the next successful start.
    console.error("[supermemory-sync] startup failed", err);
  }
  let stopImessageBridge: (() => Promise<void>) | undefined;
  startImessageBridge()
    .then((stop) => {
      stopImessageBridge = stop;
    })
    .catch((err) => console.error("[imessage] startup failed", err));

  // If a stable public URL is configured, register the Composio webhook +
  // Gmail trigger now. For ngrok-based dev, scripts/dev.mjs drives the same
  // function once the ngrok URL is known, so we skip when only the local
  // PORT default is available.
  const stableUrl = process.env.PUBLIC_URL;
  if (stableUrl && !stableUrl.includes("localhost")) {
    ensureProactiveWatcher(stableUrl).catch((err) =>
      console.error("[proactive] startup failed", err),
    );
  }

  const app = express();
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, isAllowedControlOrigin(origin));
      },
    }),
  );
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "daniel" });
  });

  app.get("/runtime-config", requireLocalControl, async (_req, res) => {
    try {
      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/runtime-config", requireLocalControl, async (req, res) => {
    try {
      const body = req.body as {
        runtime?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
      };
      let runtime =
        body.runtime === undefined
          ? undefined
          : resolveRuntimeInput(String(body.runtime));
      if (body.runtime !== undefined && !runtime) {
        res.status(400).json({ error: `Unknown runtime "${String(body.runtime)}"` });
        return;
      }

      if (runtime) {
        await setRuntimeProvider(runtime);
      }

      runtime ??= (await getRuntimeConfig()).runtime;

      if (body.model !== undefined) {
        const model = resolveModelInput(String(body.model), runtime);
        if (!model) {
          res
            .status(400)
            .json({ error: `Unknown ${runtime} model "${String(body.model)}"` });
          return;
        }
        await setRuntimeModel(model, runtime);
      }

      if (body.reasoningEffort !== undefined) {
        const effort = resolveReasoningEffortInput(String(body.reasoningEffort));
        if (!effort) {
          res.status(400).json({
            error: `Unknown Codex reasoning effort "${String(body.reasoningEffort)}"`,
          });
          return;
        }
        await setCodexReasoningEffort(effort);
      }

      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/composio", createComposioRouter({ requireControlAccess: requireLocalControl }));
  app.use("/memory", createMemoryRouter());
  app.use("/browser", requireLocalControl, createBrowserRouter());
  app.use("/changelog", requireLocalControl, createChangelogRouter());

  app.post("/agents/:id/cancel", requireLocalControl, (req, res) => {
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!agentId) {
      res.status(400).json({ error: "agent id required" });
      return;
    }
    const ok = cancelAgent(agentId);
    res.json({ ok });
  });

  app.post("/consolidate", requireLocalControl, (_req, res) => {
    res.status(410).json({
      error: "Legacy Convex memory consolidation was retired after the Supermemory write cutover.",
      code: "legacy_memory_runtime_retired",
    });
  });

  app.post("/agents/:id/retry", requireLocalControl, async (req, res) => {
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!agentId) {
      res.status(400).json({ error: "agent id required" });
      return;
    }
    const result = await retryAgent(agentId);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", requireLocalControl, async (req, res) => {
    const { conversationId, memoryOwnerId, content } = req.body ?? {};
    if (
      typeof conversationId !== "string" ||
      !conversationId.trim() ||
      typeof content !== "string" ||
      !content.trim()
    ) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    const resolvedMemoryOwnerId = resolveChatMemoryOwnerId({
      conversationId,
      memoryOwnerId,
    });
    if (!resolvedMemoryOwnerId) {
      res.status(400).json({
        error:
          "memoryOwnerId is required unless it can be derived from a direct sms conversationId",
      });
      return;
    }
    try {
      const reply = await handleUserMessage({
        conversationId,
        memoryOwnerId: resolvedMemoryOwnerId,
        content,
        persistAssistantReply: true,
      });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, request) => {
    if (!isLocalMemoryRouteRequest(request.headers, request.socket.remoteAddress ?? "")) {
      ws.close(1008, "Daniel control WebSocket is only available locally.");
      return;
    }
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`daniel server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  imessage    Photon Spectrum SDK bridge`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });

  const signalExitCodes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      Promise.resolve(stopImessageBridge?.())
        .catch(() => undefined)
        .then(() => memorySyncWorker?.stop())
        .catch(() => undefined)
        .then(() => captureRecovery.stop())
        .then(() => closeLocalBrowser())
        .catch(() => undefined)
        .finally(() => process.exit(signalExitCodes[sig]));
    });
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  main().catch((err) => {
    console.error("fatal", err);
    process.exit(1);
  });
}
