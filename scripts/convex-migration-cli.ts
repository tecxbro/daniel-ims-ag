import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ConvexMigrationTarget {
  prod?: boolean;
  deployment?: string;
}

export interface ConvexPage<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string | null;
}

export function convexTargetArgs(target: ConvexMigrationTarget): string[] {
  if (target.prod && target.deployment) {
    throw new Error("Use only one of --prod or --deployment");
  }
  if (target.prod) return ["--prod"];
  if (target.deployment) return ["--deployment", target.deployment];
  return [];
}

export function deploymentIdentifier(target: ConvexMigrationTarget): string {
  if (target.prod) return "prod";
  return target.deployment ?? process.env.CONVEX_DEPLOYMENT ?? "dev";
}

export async function runConvexMigrationFunction<T>(
  functionName: string,
  args: Record<string, unknown>,
  target: ConvexMigrationTarget,
): Promise<T> {
  const commandArgs = [
    "convex",
    "run",
    functionName,
    JSON.stringify(args),
    "--typecheck",
    "disable",
    "--codegen",
    "disable",
    ...convexTargetArgs(target),
  ];
  try {
    const { stdout } = await execFileAsync("npx", commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim()) as T;
  } catch (error) {
    const details = error as { stderr?: string; message?: string };
    const message = details.stderr?.trim() || details.message || String(error);
    throw new Error(`Convex migration function ${functionName} failed: ${message}`, {
      cause: error,
    });
  }
}

export async function* paginateConvexMigration<T>(input: {
  functionName: string;
  args?: Record<string, unknown>;
  pageSize?: number;
  target: ConvexMigrationTarget;
}): AsyncGenerator<T> {
  let cursor: string | null = null;
  for (;;) {
    const result: ConvexPage<T> = await runConvexMigrationFunction<ConvexPage<T>>(
      input.functionName,
      {
        ...(input.args ?? {}),
        cursor,
        pageSize: input.pageSize ?? 100,
      },
      input.target,
    );
    for (const row of result.page) yield row;
    if (result.isDone) return;
    if (!result.continueCursor || result.continueCursor === cursor) {
      throw new Error(`Convex cursor did not advance for ${input.functionName}`);
    }
    cursor = result.continueCursor;
  }
}
