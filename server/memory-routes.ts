import type express from "express";
import {
  createSupermemoryRouter,
  type CreateSupermemoryRouterOptions,
} from "./memory/supermemory/routes.js";

/**
 * Compatibility export for the existing `/memory` mount in server/index.ts.
 * Only the active Supermemory administrative surface is mounted.
 */
export function createMemoryRouter(
  options: CreateSupermemoryRouterOptions = {},
): express.Router {
  return createSupermemoryRouter(options);
}

export { createSupermemoryRouter } from "./memory/supermemory/routes.js";
export type {
  CreateSupermemoryRouterOptions,
  MemoryRouteControlPlane,
} from "./memory/supermemory/routes.js";
