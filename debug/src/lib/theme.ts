export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "daniel-debug-theme";

export function readStoredTheme(storage: Pick<Storage, "getItem"> = localStorage): ThemeMode {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage can be blocked in hardened browser contexts.
  }
  return "system";
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

export function applyTheme(mode: ThemeMode, resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  root.style.colorScheme = resolved;
}
