#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const blockedWords = [
  ["b", "oop"].join(""),
  ["raro", "que"].join(""),
];
const blocked = new RegExp(blockedWords.join("|"), "i");
const legalNotice = "THIRD_PARTY_NOTICES.md";
const privateInventory = "docs/daniel_migration_inventory.md";
const requiredAttribution = [
  "Copyright (c) 2026 Chris Raro",
  "que",
].join("");
const skippedDirectories = new Set([
  ".git",
  ".convex",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vite",
  ".cache",
]);

function shouldSkip(relativePath, entry) {
  if (entry.isDirectory() && skippedDirectories.has(entry.name)) return true;
  if (relativePath === privateInventory) return true;
  if (/^\.env(?:\..+)?\.local$/.test(entry.name)) return true;
  return false;
}

function collect(directory, paths = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath);
    if (shouldSkip(relativePath, entry)) continue;
    if (entry.isDirectory()) {
      collect(absolutePath, paths);
    } else {
      paths.push({ absolutePath, relativePath });
    }
  }
  return paths;
}

function readableText(absolutePath) {
  const stat = lstatSync(absolutePath);
  const content = stat.isSymbolicLink()
    ? Buffer.from(readlinkSync(absolutePath))
    : readFileSync(absolutePath);
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

const failures = [];
for (const file of collect(root)) {
  if (blocked.test(file.relativePath)) {
    failures.push(`${file.relativePath}: legacy branding in path`);
  }

  const text = readableText(file.absolutePath);
  if (text === null) continue;

  if (file.relativePath === legalNotice) {
    const withoutRequiredAttribution = text.replace(requiredAttribution, "");
    if (blocked.test(withoutRequiredAttribution)) {
      failures.push(`${file.relativePath}: legacy branding outside the required legal notice`);
    }
    continue;
  }

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (blocked.test(line)) {
      failures.push(`${file.relativePath}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (failures.length) {
  console.error("Daniel branding check failed:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Daniel branding check passed.");
