import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain02Icon,
  CancelCircleIcon,
  Clock02Icon,
  Delete02Icon,
  FileSearchIcon,
  GlobalSearchIcon,
  MailSend02Icon,
  NoteEditIcon,
  Robot02Icon,
} from "@hugeicons/core-free-icons";

type ToolBrand = {
  key: string;
  displayName: string;
  aliases: string[];
};

const TOOL_BRANDS: ToolBrand[] = [
  { key: "gmail", displayName: "Gmail", aliases: ["gmail"] },
  {
    key: "googlecalendar",
    displayName: "Google Calendar",
    aliases: ["googlecalendar", "google-calendar"],
  },
  {
    key: "googledrive",
    displayName: "Google Drive",
    aliases: ["googledrive", "google-drive"],
  },
  {
    key: "googlesheets",
    displayName: "Google Sheets",
    aliases: ["googlesheets", "google-sheets"],
  },
  {
    key: "googledocs",
    displayName: "Google Docs",
    aliases: ["googledocs", "google-docs"],
  },
  { key: "slack", displayName: "Slack", aliases: ["slack"] },
  { key: "notion", displayName: "Notion", aliases: ["notion"] },
  { key: "github", displayName: "GitHub", aliases: ["github"] },
  { key: "linear", displayName: "Linear", aliases: ["linear"] },
  { key: "hubspot", displayName: "HubSpot", aliases: ["hubspot"] },
  {
    key: "salesforce",
    displayName: "Salesforce",
    aliases: ["salesforce"],
  },
  { key: "discord", displayName: "Discord", aliases: ["discord"] },
  { key: "twitter", displayName: "Twitter", aliases: ["twitter", "x"] },
  { key: "linkedin", displayName: "LinkedIn", aliases: ["linkedin"] },
  { key: "instagram", displayName: "Instagram", aliases: ["instagram"] },
  { key: "youtube", displayName: "YouTube", aliases: ["youtube"] },
  { key: "trello", displayName: "Trello", aliases: ["trello"] },
  { key: "asana", displayName: "Asana", aliases: ["asana"] },
  { key: "jira", displayName: "Jira", aliases: ["jira"] },
  { key: "airtable", displayName: "Airtable", aliases: ["airtable"] },
  { key: "figma", displayName: "Figma", aliases: ["figma"] },
  { key: "dropbox", displayName: "Dropbox", aliases: ["dropbox"] },
  { key: "stripe", displayName: "Stripe", aliases: ["stripe"] },
  { key: "supabase", displayName: "Supabase", aliases: ["supabase"] },
  { key: "granola", displayName: "Granola", aliases: ["granola", "granola_mcp"] },
  { key: "imessage", displayName: "iMessage", aliases: ["imessage", "messages"] },
];

function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, "-");
}

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function findBrand(identifier?: string | null): ToolBrand | null {
  if (!identifier) return null;
  const n = normalize(identifier);
  return (
    TOOL_BRANDS.find((brand) => brand.aliases.some((alias) => n.includes(alias))) ??
    null
  );
}

function parseToolParts(raw?: string | null): {
  server: string | null;
  action: string | null;
} {
  if (!raw) return { server: null, action: null };
  const parts = raw.split("__");
  if (parts.length >= 3) {
    return { server: parts[1] ?? null, action: parts.slice(2).join("__") || null };
  }
  return { server: null, action: raw };
}

export function getIntegrationBrand(raw?: string | null): ToolBrand | null {
  const { server } = parseToolParts(raw);
  return findBrand(server) ?? findBrand(raw);
}

export function prettyToolName(raw?: string | null): string {
  if (!raw) return "";
  const { server, action } = parseToolParts(raw);
  if (server && action) {
    const prettyAction = humanize(action);
    if (normalize(server).startsWith("daniel-")) return prettyAction;
    const brand = findBrand(server);
    if (brand) return `${brand.displayName} · ${prettyAction}`;
    return `${humanize(server)} · ${prettyAction}`;
  }
  return humanize(raw);
}

const DANIEL_ICONS: Record<string, any> = {
  recall: AiBrain02Icon,
  write_memory: AiBrain02Icon,
  WebSearch: GlobalSearchIcon,
  WebFetch: FileSearchIcon,
  save_draft: NoteEditIcon,
  list_drafts: NoteEditIcon,
  send_draft: MailSend02Icon,
  spawn_agent: Robot02Icon,
  create_automation: Clock02Icon,
  list_automations: Clock02Icon,
  toggle_automation: Clock02Icon,
  delete_automation: Delete02Icon,
  reject_draft: CancelCircleIcon,
};

function getDanielToolIcon(raw?: string | null): any | null {
  if (!raw) return null;
  const action = raw.split("__").pop() ?? raw;
  return DANIEL_ICONS[action] ?? null;
}

export { getDanielToolIcon };

export function IntegrationLogo({
  raw,
  logoUrl,
  size = 18,
  className = "",
}: {
  raw?: string | null;
  logoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const brand = getIntegrationBrand(raw);
  const danielIcon = getDanielToolIcon(raw);
  const style = { width: size, height: size };
  const radius = Math.max(8, Math.round(size * 0.4));
  const iconSize = Math.max(12, Math.round(size * 0.72));

  if (danielIcon) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-violet-500/10 text-violet-400 ${className}`}
        style={{ ...style, borderRadius: radius, border: "0.5px solid rgba(139,92,246,0.25)" }}
      >
        <HugeiconsIcon icon={danielIcon} size={iconSize} />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-zinc-500/10 text-zinc-400 ${className}`}
      style={{ ...style, borderRadius: radius, border: "0.5px solid rgba(148,163,184,0.25)" }}
    >
      <span className="text-[10px] font-semibold leading-none">
        {(brand?.displayName ?? logoUrl ?? raw ?? "?").trim().charAt(0).toUpperCase() || "?"}
      </span>
    </span>
  );
}

export function ClaudeLogo({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src="/claude-logo.png"
      alt="Claude"
      className={`shrink-0 rounded-[4px] object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export type RuntimeProvider = "claude" | "codex";

export function CodexLogo({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src="/codex-logo.png"
      alt="Codex"
      className={`shrink-0 rounded-[4px] object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function RuntimeProviderLogo({
  runtime,
  size = 16,
  className = "",
}: {
  runtime: RuntimeProvider;
  size?: number;
  className?: string;
}) {
  return runtime === "codex" ? (
    <CodexLogo size={size} className={className} />
  ) : (
    <ClaudeLogo size={size} className={className} />
  );
}

export function RuntimeProviderBadge({
  runtime,
  model,
  isDark,
  compact = false,
  className = "",
}: {
  runtime: RuntimeProvider;
  model?: string | null;
  isDark: boolean;
  compact?: boolean;
  className?: string;
}) {
  const label = runtime === "codex" ? "Codex" : "Claude";
  return (
    <div
      className={`inline-flex min-w-0 items-center gap-1.5 rounded-2xl border px-2.5 py-1.5 ${
        isDark
          ? "border-white/10 bg-white/5 text-zinc-300"
          : "border-zinc-200 bg-white text-zinc-700"
      } ${className}`}
      title={`Active provider: ${label}${model ? ` (${model})` : ""}`}
    >
      <RuntimeProviderLogo runtime={runtime} size={compact ? 14 : 16} />
      <span className="text-xs font-medium">{label}</span>
      {!compact && model && (
        <span className={`text-[10px] mono truncate ${isDark ? "text-zinc-500" : "text-zinc-400"}`}>
          {model}
        </span>
      )}
    </div>
  );
}

export function BrailleIndicator({ className = "" }: { className?: string }) {
  return (
    <div className={`braille-grid ${className}`}>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="bg-sky-400" />
      ))}
    </div>
  );
}
