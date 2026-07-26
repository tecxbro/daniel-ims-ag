#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const generated = resolve(here, "..", "convex", "_generated", "api.js");

if (!existsSync(generated)) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run one of these first:                                    │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
│                                                             │
│  Both will write convex/_generated/ which the server needs. │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}
