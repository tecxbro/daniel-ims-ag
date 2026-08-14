import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { LiquidGlassProvider } from "./components/LiquidGlassProvider.js";
import { applyTheme, readStoredTheme, resolveTheme } from "./lib/theme.js";
import "./styles.css";

const initialThemeMode = readStoredTheme();
const initialTheme = resolveTheme(
  initialThemeMode,
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);
applyTheme(initialThemeMode, initialTheme);

const convexUrl = import.meta.env.VITE_CONVEX_URL;
if (!convexUrl) {
  document.getElementById("root")!.innerHTML = `
    <div style="padding:2rem;font-family:Geist,ui-sans-serif,system-ui,sans-serif">
      <h1>VITE_CONVEX_URL is not set</h1>
      <p>Run <code>npm run setup</code> or <code>npx convex dev</code> to configure Convex, then reload.</p>
    </div>`;
} else {
  const convex = new ConvexReactClient(convexUrl);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ConvexProvider client={convex}>
          <LiquidGlassProvider>
            <App />
          </LiquidGlassProvider>
        </ConvexProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
