import {
  Activity01Icon,
  AiBrain02Icon,
  ArrowShrink02Icon,
  DashboardSquare01Icon,
  Link04Icon,
  MachineRobotIcon,
  Settings01Icon,
  WorkflowCircle03Icon,
} from "@hugeicons/core-free-icons";

export type ViewId =
  | "dashboard"
  | "agents"
  | "automations"
  | "memory"
  | "events"
  | "sync"
  | "connections"
  | "settings";

export type ViewGroup = "Overview" | "Work" | "Knowledge" | "System";

export interface ViewDefinition {
  id: ViewId;
  label: string;
  description: string;
  group: ViewGroup;
  shortcut: string;
  icon: any;
}

export const VIEW_DEFINITIONS: ViewDefinition[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Live health, usage, and system activity.",
    group: "Overview",
    shortcut: "⌘1",
    icon: DashboardSquare01Icon,
  },
  {
    id: "events",
    label: "Events",
    description: "Recent runtime and memory events.",
    group: "Overview",
    shortcut: "⌘5",
    icon: Activity01Icon,
  },
  {
    id: "agents",
    label: "Agents",
    description: "Top-level and delegated agent runs.",
    group: "Work",
    shortcut: "⌘2",
    icon: MachineRobotIcon,
  },
  {
    id: "automations",
    label: "Automations",
    description: "Recurring jobs and their run history.",
    group: "Work",
    shortcut: "⌘3",
    icon: WorkflowCircle03Icon,
  },
  {
    id: "sync",
    label: "Memory sync",
    description: "Durable provider outbox, retries, and dead letters.",
    group: "Work",
    shortcut: "⌘6",
    icon: ArrowShrink02Icon,
  },
  {
    id: "memory",
    label: "Memory",
    description: "Search and inspect the active memory store.",
    group: "Knowledge",
    shortcut: "⌘4",
    icon: AiBrain02Icon,
  },
  {
    id: "connections",
    label: "Connections",
    description: "Accounts and tools available to the agent.",
    group: "System",
    shortcut: "⌘7",
    icon: Link04Icon,
  },
  {
    id: "settings",
    label: "Settings",
    description: "Runtime, model, browser, and local preferences.",
    group: "System",
    shortcut: "⌘8",
    icon: Settings01Icon,
  },
];

export const VIEW_GROUPS: ViewGroup[] = ["Overview", "Work", "Knowledge", "System"];

export function isViewId(value: string | null): value is ViewId {
  return VIEW_DEFINITIONS.some((view) => view.id === value);
}

export function viewFromLocation(location: Pick<Location, "search">): ViewId {
  const requested = new URLSearchParams(location.search).get("view");
  return isViewId(requested) ? requested : "dashboard";
}

export function viewUrl(view: ViewId, location: Pick<Location, "pathname" | "search" | "hash">) {
  const params = new URLSearchParams(location.search);
  if (view === "dashboard") params.delete("view");
  else params.set("view", view);
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}
