import { Buffer } from "node:buffer";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { validateImageHeader, MAX_IMAGE_BYTES, type ImageMediaType } from "./images/mime.js";
import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const MAX_CHUNK = 2900;
const TYPING_INTERVAL_MS = 5000;

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

export type IngestedImage = { storageId: string; mediaType: ImageMediaType };

export interface SpectrumAttachmentLike {
  type: "attachment";
  name?: string;
  mimeType: string;
  size?: number;
  read(): Promise<Buffer | Uint8Array | ArrayBuffer>;
}

interface SendOptions {
  space?: Space;
}

let appPromise: Promise<SpectrumApp | null> | null = null;
let bridgeStarted = false;
const dmSpaceCache = new Map<string, Space>();

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

export function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^\d{11,15}$/.test(digits)) return `+${digits}`;
  return undefined;
}

export function conversationIdForPhone(phone: string): string {
  return `sms:${phone}`;
}

export function messageDedupKey(message: Pick<Message, "id" | "platform">): string {
  return `photon:${message.platform}:${message.id}`;
}

function dedicatedPhone(): string | undefined {
  return normalizeE164(process.env.PHOTON_IMESSAGE_PHONE);
}

function dmCacheKey(toNumber: string, phone?: string): string {
  return `${phone ?? "auto"}:${toNumber}`;
}

function rememberDmSpace(toNumber: string, space: Space): void {
  const narrowed = imessage(space);
  dmSpaceCache.set(dmCacheKey(toNumber, narrowed.phone), space);
  dmSpaceCache.set(dmCacheKey(toNumber, dedicatedPhone()), space);
  dmSpaceCache.set(dmCacheKey(toNumber), space);
}

async function getSpectrumApp(): Promise<SpectrumApp | null> {
  const projectId = process.env.PHOTON_PROJECT_ID;
  const projectSecret = process.env.PHOTON_PROJECT_SECRET;
  if (!projectId || !projectSecret) return null;
  appPromise ??= Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  }).catch((err) => {
    appPromise = null;
    throw err;
  });
  return appPromise;
}

async function resolveDmSpace(toNumber: string): Promise<Space | null> {
  const phone = dedicatedPhone();
  const cached = dmSpaceCache.get(dmCacheKey(toNumber, phone)) ?? dmSpaceCache.get(dmCacheKey(toNumber));
  if (cached) return cached;

  const app = await getSpectrumApp();
  if (!app) return null;

  const im = imessage(app);
  const user = await im.user(toNumber);
  const space = phone ? await im.space(user, { phone }) : await im.space(user);
  rememberDmSpace(toNumber, space);
  return space;
}

export async function sendImessage(
  toNumber: string,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  const to = normalizeE164(toNumber);
  if (!to) {
    console.warn(`[imessage] invalid recipient ${JSON.stringify(toNumber)} - not sending`);
    return;
  }
  let space: Space | null | undefined;
  try {
    space = options.space ?? (await resolveDmSpace(to));
  } catch (err) {
    console.error(`[imessage] failed to resolve DM space for ${to}:`, err);
    return;
  }
  if (!space) {
    console.warn("[imessage] missing Photon credentials - not sending");
    return;
  }

  const plain = stripMarkdown(text);
  for (const part of chunk(plain)) {
    try {
      await space.send(part);
      console.log(`[imessage] -> sent ${part.length} chars to ${to}`);
    } catch (err) {
      console.error(`[imessage] send failed to ${to}:`, err);
    }
  }
}

export async function sendTypingIndicator(space: Space): Promise<void> {
  try {
    await space.startTyping();
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(space: Space): () => void {
  sendTypingIndicator(space);
  const timer = setInterval(() => sendTypingIndicator(space), TYPING_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    space.stopTyping().catch(() => undefined);
  };
}

async function uploadImageToConvex(bytes: Buffer, mediaType: ImageMediaType): Promise<string> {
  const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": mediaType },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!upload.ok) {
    throw new Error(`HTTP ${upload.status}`);
  }
  const { storageId } = (await upload.json()) as { storageId: string };
  return storageId;
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function ingestSpectrumAttachment(
  attachment: SpectrumAttachmentLike,
  uploadImage: (bytes: Buffer, mediaType: ImageMediaType) => Promise<string> = uploadImageToConvex,
): Promise<{ ok: true; image: IngestedImage } | { ok: false; reason: string }> {
  const check = validateImageHeader({
    contentType: attachment.mimeType,
    contentLength: attachment.size,
  });
  if (!check.ok) return { ok: false, reason: check.reason };

  let bytes: Buffer;
  try {
    bytes = toBuffer(await attachment.read());
  } catch (err) {
    return { ok: false, reason: `read failed: ${String(err)}` };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `image too large: >${MAX_IMAGE_BYTES} bytes` };
  }

  try {
    const storageId = await uploadImage(bytes, check.mediaType);
    return { ok: true, image: { storageId, mediaType: check.mediaType } };
  } catch (err) {
    return { ok: false, reason: `upload failed: ${String(err)}` };
  }
}

function collectMessageParts(message: Message): {
  textParts: string[];
  attachments: SpectrumAttachmentLike[];
} {
  const textParts: string[] = [];
  const attachments: SpectrumAttachmentLike[] = [];

  const visit = (m: Message) => {
    const content = m.content;
    switch (content.type) {
      case "text":
        textParts.push(content.text);
        break;
      case "attachment":
        attachments.push(content as SpectrumAttachmentLike);
        break;
      case "group":
        for (const item of content.items) visit(item);
        break;
      case "reply":
        visit({ ...m, content: content.content });
        break;
      case "richlink":
        textParts.push(content.url);
        break;
      default:
        break;
    }
  };

  visit(message);
  return { textParts, attachments };
}

async function handleSpectrumMessage(space: Space, message: Message): Promise<void> {
  if (message.direction !== "inbound") return;
  if (!imessage.is(space) || !imessage.is(message)) return;
  if (space.type !== "dm") {
    console.log(`[imessage] skipping non-DM space ${space.id}`);
    return;
  }

  const fromNumber = normalizeE164(message.sender?.id);
  if (!fromNumber) {
    console.log(`[imessage] skipping unsupported sender ${JSON.stringify(message.sender?.id)}`);
    return;
  }

  const dedupKey = messageDedupKey(message);
  const { claimed } = await convex.mutation(api.messageDedup.claim, {
    key: dedupKey,
  });
  if (!claimed) return;

  rememberDmSpace(fromNumber, space);

  const { textParts, attachments } = collectMessageParts(message);
  if (textParts.length === 0 && attachments.length === 0) return;

  const ingestResults = await Promise.all(attachments.map((a) => ingestSpectrumAttachment(a)));
  const ingested: IngestedImage[] = [];
  const ingestErrors: string[] = [];
  for (const result of ingestResults) {
    if (result.ok) ingested.push(result.image);
    else ingestErrors.push(result.reason);
  }

  const conversationId = conversationIdForPhone(fromNumber);
  const turnTag = Math.random().toString(36).slice(2, 8);
  const textForLog = textParts.join("\n").trim();
  const preview = textForLog.length > 100 ? textForLog.slice(0, 100) + "..." : textForLog;
  console.log(`[turn ${turnTag}] <- ${fromNumber}: ${JSON.stringify(preview)}`);
  const start = Date.now();

  broadcast("message_in", {
    conversationId,
    content: textForLog,
    from_number: fromNumber,
    handle: message.id,
  });

  const stopTyping = startTypingLoop(space);
  try {
    const reply = await handleUserMessage({
      conversationId,
      content: textForLog,
      turnTag,
      images: ingested,
      mediaError: ingestErrors.length > 0 ? ingestErrors.join("; ") : undefined,
      onThinking: (t) => broadcast("thinking", { conversationId, t }),
    });
    if (reply) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "..." : reply;
      console.log(
        `[turn ${turnTag}] -> reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
      );
      await sendImessage(fromNumber, reply, { space });
      await convex.mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content: reply,
      });
    } else {
      console.log(`[turn ${turnTag}] -> (no reply)`);
    }
  } catch (err) {
    console.error(`[turn ${turnTag}] handler error`, err);
  } finally {
    stopTyping();
  }
}

export async function startImessageBridge(): Promise<(() => Promise<void>) | undefined> {
  if (bridgeStarted) return undefined;
  const app = await getSpectrumApp();
  if (!app) {
    console.warn("[imessage] PHOTON_PROJECT_ID/PHOTON_PROJECT_SECRET not set - bridge disabled");
    return undefined;
  }

  bridgeStarted = true;
  const run = (async () => {
    console.log("[imessage] Photon Spectrum bridge listening");
    for await (const [space, message] of app.messages) {
      handleSpectrumMessage(space, message).catch((err) =>
        console.error("[imessage] message handler failed", err),
      );
    }
  })();
  run.catch((err) => {
    bridgeStarted = false;
    console.error("[imessage] bridge stopped", err);
  });

  return async () => {
    bridgeStarted = false;
    await app.stop();
  };
}
