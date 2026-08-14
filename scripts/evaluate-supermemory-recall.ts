import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  SUPERMEMORY_RECALL_CATEGORIES,
  SUPERMEMORY_RECALL_CORPUS,
  type ExpectedAbsenceReason,
  type SupermemoryRecallEvaluationCase,
} from "../evaluation/supermemory-recall-corpus.js";

const MIN_EXPECTED_FACT_RECALL_RATE = 0.95;
const MAX_P95_HYDRATION_LATENCY_MS = 1_200;
const MAX_TIMEOUT_ERROR_RATE = 0.01;
const MAX_PROMPT_CHARS = 8_000;
const DEFAULT_MAX_PROMPT_REGRESSION_PERCENT = 10;

type MeasurementStatus = "ok" | "timeout" | "error";

interface RecallMeasurement {
  caseId: string;
  status: MeasurementStatus;
  latencyMs: number;
  resultCount: number;
  recalledFactIds: string[];
  legacyFactIds: string[];
  foreignOwnerResultCount: number;
  promptChars: number;
  legacyPromptChars: number;
  errorCode?: string;
}

interface RecallEvaluationInput {
  schemaVersion: 1;
  runId?: string;
  profileQualityApproved?: boolean;
  measurements: RecallMeasurement[];
}

interface CliOptions {
  inputPath?: string;
  sample: boolean;
  json: boolean;
  help: boolean;
  profileQualityApproved?: boolean;
  maxPromptRegressionPercent: number;
}

interface GateResult {
  name: string;
  passed: boolean;
  observed: string;
  required: string;
}

interface EvaluationReport {
  schemaVersion: 1;
  runId: string | null;
  sample: boolean;
  corpus: {
    caseCount: number;
    categoryCount: number;
    profileReviewCaseCount: number;
  };
  metrics: {
    expectedFactRecallRate: number;
    expectedFactsRecalled: number;
    expectedFactsTotal: number;
    crossUserLeakageCount: number;
    expectedAbsenceViolationCount: number;
    staleVersionViolationCount: number;
    mustNotRememberViolationCount: number;
    p50HydrationLatencyMs: number;
    p95HydrationLatencyMs: number;
    timeoutErrorRate: number;
    timeoutErrorCount: number;
    meanResultCount: number;
    legacySupermemoryOverlapRate: number;
    meanPromptChars: number;
    meanLegacyPromptChars: number;
    maxPromptChars: number;
    promptLengthRegressionPercent: number;
    profileQualityApproved: boolean;
  };
  gates: GateResult[];
  passed: boolean;
  failingCaseIds: {
    missedExpectedFacts: string[];
    crossUserLeakage: string[];
    staleVersions: string[];
    mustNotRemember: string[];
    timeoutOrError: string[];
    promptCap: string[];
  };
}

const INPUT_KEYS = new Set([
  "schemaVersion",
  "runId",
  "profileQualityApproved",
  "measurements",
]);

const MEASUREMENT_KEYS = new Set([
  "caseId",
  "status",
  "latencyMs",
  "resultCount",
  "recalledFactIds",
  "legacyFactIds",
  "foreignOwnerResultCount",
  "promptChars",
  "legacyPromptChars",
  "errorCode",
]);

function usage(): string {
  return `SuperMemory recall cutover evaluation

Usage:
  npm run evaluate:supermemory-recall -- --input <measurements.json> [options]
  npm run evaluate:supermemory-recall -- --sample --profile-quality approved

Options:
  --input <path>                        Measured shadow-run JSON.
  --sample                              Use deterministic synthetic passing measurements.
  --profile-quality approved|rejected  Override the manual profile review decision.
  --max-prompt-regression-percent <n>   Allowed mean prompt growth (default: 10).
  --json                                Emit machine-readable JSON.
  --help                                Show this help.

Input schema:
  {
    "schemaVersion": 1,
    "runId": "shadow-run-id",
    "profileQualityApproved": true,
    "measurements": [{
      "caseId": "identity-01",
      "status": "ok",
      "latencyMs": 240,
      "resultCount": 1,
      "recalledFactIds": ["alpha-name"],
      "legacyFactIds": ["alpha-name"],
      "foreignOwnerResultCount": 0,
      "promptChars": 1200,
      "legacyPromptChars": 1180
    }]
  }

The input intentionally accepts stable fact IDs and aggregate measurements only.
Raw provider profiles and raw API responses are not part of the schema.`;
}

function parseNonNegativeNumber(raw: string | undefined, flag: string): number {
  if (raw === undefined) throw new Error(`${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sample: false,
    json: false,
    help: false,
    maxPromptRegressionPercent: DEFAULT_MAX_PROMPT_REGRESSION_PERCENT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      options.inputPath = argv[++index];
    } else if (arg === "--sample") {
      options.sample = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--profile-quality") {
      const value = argv[++index];
      if (value !== "approved" && value !== "rejected") {
        throw new Error("--profile-quality must be approved or rejected");
      }
      options.profileQualityApproved = value === "approved";
    } else if (arg === "--max-prompt-regression-percent") {
      options.maxPromptRegressionPercent = parseNonNegativeNumber(
        argv[++index],
        "--max-prompt-regression-percent",
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.sample === Boolean(options.inputPath)) {
    throw new Error("Provide exactly one of --input or --sample");
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicate fact IDs`);
  }
  return value;
}

function parseMeasurement(value: unknown, index: number): RecallMeasurement {
  if (!isRecord(value)) throw new Error(`measurements[${index}] must be an object`);
  assertOnlyKeys(value, MEASUREMENT_KEYS, `measurements[${index}]`);
  const status = value.status;
  if (status !== "ok" && status !== "timeout" && status !== "error") {
    throw new Error(`measurements[${index}].status must be ok, timeout, or error`);
  }
  const errorCode = value.errorCode;
  if (errorCode !== undefined && (typeof errorCode !== "string" || errorCode.length > 80)) {
    throw new Error(`measurements[${index}].errorCode must be at most 80 characters`);
  }
  return {
    caseId: requireString(value.caseId, `measurements[${index}].caseId`),
    status,
    latencyMs: requireNonNegativeInteger(value.latencyMs, `measurements[${index}].latencyMs`),
    resultCount: requireNonNegativeInteger(value.resultCount, `measurements[${index}].resultCount`),
    recalledFactIds: requireStringArray(
      value.recalledFactIds,
      `measurements[${index}].recalledFactIds`,
    ),
    legacyFactIds: requireStringArray(
      value.legacyFactIds,
      `measurements[${index}].legacyFactIds`,
    ),
    foreignOwnerResultCount: requireNonNegativeInteger(
      value.foreignOwnerResultCount,
      `measurements[${index}].foreignOwnerResultCount`,
    ),
    promptChars: requireNonNegativeInteger(
      value.promptChars,
      `measurements[${index}].promptChars`,
    ),
    legacyPromptChars: requireNonNegativeInteger(
      value.legacyPromptChars,
      `measurements[${index}].legacyPromptChars`,
    ),
    errorCode,
  };
}

function parseEvaluationInput(value: unknown): RecallEvaluationInput {
  if (!isRecord(value)) throw new Error("Evaluation input must be an object");
  assertOnlyKeys(value, INPUT_KEYS, "Evaluation input");
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (value.runId !== undefined && typeof value.runId !== "string") {
    throw new Error("runId must be a string");
  }
  if (
    value.profileQualityApproved !== undefined &&
    typeof value.profileQualityApproved !== "boolean"
  ) {
    throw new Error("profileQualityApproved must be a boolean");
  }
  if (!Array.isArray(value.measurements)) {
    throw new Error("measurements must be an array");
  }
  return {
    schemaVersion: 1,
    runId: value.runId,
    profileQualityApproved: value.profileQualityApproved,
    measurements: value.measurements.map(parseMeasurement),
  };
}

function validateCorpus(corpus: readonly SupermemoryRecallEvaluationCase[]): void {
  if (corpus.length < 50) throw new Error("Recall corpus must contain at least 50 cases");
  const caseIds = new Set<string>();
  const coveredCategories = new Set<string>();
  for (const evaluationCase of corpus) {
    if (caseIds.has(evaluationCase.id)) {
      throw new Error(`Duplicate corpus case ID: ${evaluationCase.id}`);
    }
    caseIds.add(evaluationCase.id);
    coveredCategories.add(evaluationCase.category);
    if (!evaluationCase.question.trim()) {
      throw new Error(`Corpus case ${evaluationCase.id} has an empty question`);
    }
    for (const expected of [
      ...evaluationCase.expectedFacts,
      ...evaluationCase.expectedAbsences,
    ]) {
      if (!expected.id || !expected.text || !expected.ownerKey) {
        throw new Error(`Corpus case ${evaluationCase.id} has an incomplete fact expectation`);
      }
    }
  }
  const missingCategories = SUPERMEMORY_RECALL_CATEGORIES.filter(
    (category) => !coveredCategories.has(category),
  );
  if (missingCategories.length > 0) {
    throw new Error(`Recall corpus is missing categories: ${missingCategories.join(", ")}`);
  }
}

function validateMeasurementCoverage(input: RecallEvaluationInput): void {
  const expectedIds = new Set(SUPERMEMORY_RECALL_CORPUS.map(({ id }) => id));
  const measuredIds = new Set<string>();
  for (const measurement of input.measurements) {
    if (measuredIds.has(measurement.caseId)) {
      throw new Error(`Duplicate measurement case ID: ${measurement.caseId}`);
    }
    if (!expectedIds.has(measurement.caseId)) {
      throw new Error(`Unknown measurement case ID: ${measurement.caseId}`);
    }
    measuredIds.add(measurement.caseId);
  }
  const missing = [...expectedIds].filter((caseId) => !measuredIds.has(caseId));
  if (missing.length > 0) {
    throw new Error(`Missing measurements for ${missing.length} cases: ${missing.join(", ")}`);
  }
}

function makeSampleInput(): RecallEvaluationInput {
  return {
    schemaVersion: 1,
    runId: "synthetic-sample-not-cutover-evidence",
    profileQualityApproved: false,
    measurements: SUPERMEMORY_RECALL_CORPUS.map((evaluationCase, index) => {
      const factIds = evaluationCase.expectedFacts.map(({ id }) => id);
      return {
        caseId: evaluationCase.id,
        status: "ok",
        latencyMs: 210 + ((index * 73) % 820),
        resultCount: factIds.length,
        recalledFactIds: factIds,
        legacyFactIds: factIds,
        foreignOwnerResultCount: 0,
        promptChars: 900 + ((index * 37) % 1_100),
        legacyPromptChars: 920 + ((index * 31) % 1_000),
      };
    }),
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function overlapCounts(
  current: readonly string[],
  legacy: readonly string[],
): { intersection: number; union: number } {
  const currentSet = new Set(current);
  const legacySet = new Set(legacy);
  const union = new Set([...currentSet, ...legacySet]);
  let intersection = 0;
  for (const factId of currentSet) {
    if (legacySet.has(factId)) intersection += 1;
  }
  return { intersection, union: union.size };
}

function absenceViolations(
  evaluationCase: SupermemoryRecallEvaluationCase,
  measurement: RecallMeasurement,
  reason: ExpectedAbsenceReason,
): string[] {
  const recalled = new Set(measurement.recalledFactIds);
  return evaluationCase.expectedAbsences
    .filter((expected) => expected.reason === reason && recalled.has(expected.id))
    .map(({ id }) => id);
}

function evaluate(
  input: RecallEvaluationInput,
  options: Pick<CliOptions, "sample" | "profileQualityApproved" | "maxPromptRegressionPercent">,
): EvaluationReport {
  validateMeasurementCoverage(input);
  const measurements = new Map(input.measurements.map((measurement) => [measurement.caseId, measurement]));
  let expectedFactsTotal = 0;
  let expectedFactsRecalled = 0;
  let crossUserLeakageCount = 0;
  let staleVersionViolationCount = 0;
  let mustNotRememberViolationCount = 0;
  let overlapIntersection = 0;
  let overlapUnion = 0;
  const missedExpectedFacts: string[] = [];
  const crossUserLeakage: string[] = [];
  const staleVersions: string[] = [];
  const mustNotRemember: string[] = [];
  const timeoutOrError: string[] = [];
  const promptCap: string[] = [];

  for (const evaluationCase of SUPERMEMORY_RECALL_CORPUS) {
    const measurement = measurements.get(evaluationCase.id)!;
    const recalled = new Set(measurement.recalledFactIds);
    expectedFactsTotal += evaluationCase.expectedFacts.length;
    const missed = evaluationCase.expectedFacts.filter(({ id }) => !recalled.has(id));
    expectedFactsRecalled += evaluationCase.expectedFacts.length - missed.length;
    if (missed.length > 0) missedExpectedFacts.push(evaluationCase.id);

    const knownForeignIds = new Set(
      evaluationCase.expectedAbsences
        .filter(({ reason }) => reason === "cross_user")
        .map(({ id }) => id),
    );
    const knownForeignCount = measurement.recalledFactIds.filter((id) => knownForeignIds.has(id)).length;
    const measuredForeignCount = Math.max(knownForeignCount, measurement.foreignOwnerResultCount);
    crossUserLeakageCount += measuredForeignCount;
    if (measuredForeignCount > 0) crossUserLeakage.push(evaluationCase.id);

    const stale = absenceViolations(evaluationCase, measurement, "superseded");
    staleVersionViolationCount += stale.length;
    if (stale.length > 0) staleVersions.push(evaluationCase.id);

    const forbidden = absenceViolations(evaluationCase, measurement, "must_not_remember");
    mustNotRememberViolationCount += forbidden.length;
    if (forbidden.length > 0) mustNotRemember.push(evaluationCase.id);

    if (measurement.status !== "ok") timeoutOrError.push(evaluationCase.id);
    if (measurement.promptChars > MAX_PROMPT_CHARS) promptCap.push(evaluationCase.id);

    const overlap = overlapCounts(measurement.recalledFactIds, measurement.legacyFactIds);
    overlapIntersection += overlap.intersection;
    overlapUnion += overlap.union;
  }

  const promptChars = input.measurements.map(({ promptChars: count }) => count);
  const legacyPromptChars = input.measurements.map(({ legacyPromptChars: count }) => count);
  const meanPromptChars = mean(promptChars);
  const meanLegacyPromptChars = mean(legacyPromptChars);
  const promptLengthRegressionPercent =
    meanLegacyPromptChars === 0
      ? meanPromptChars === 0 ? 0 : Number.POSITIVE_INFINITY
      : ((meanPromptChars - meanLegacyPromptChars) / meanLegacyPromptChars) * 100;
  const timeoutErrorCount = timeoutOrError.length;
  const timeoutErrorRate = rate(timeoutErrorCount, input.measurements.length);
  const expectedFactRecallRate = rate(expectedFactsRecalled, expectedFactsTotal);
  const p50HydrationLatencyMs = percentile(input.measurements.map(({ latencyMs }) => latencyMs), 0.5);
  const p95HydrationLatencyMs = percentile(input.measurements.map(({ latencyMs }) => latencyMs), 0.95);
  const profileQualityApproved =
    options.profileQualityApproved ?? input.profileQualityApproved ?? false;
  const expectedAbsenceViolationCount =
    crossUserLeakageCount + staleVersionViolationCount + mustNotRememberViolationCount;

  const gates: GateResult[] = [
    {
      name: "Expected-fact recall",
      passed: expectedFactRecallRate >= MIN_EXPECTED_FACT_RECALL_RATE,
      observed: `${formatPercent(expectedFactRecallRate)} (${expectedFactsRecalled}/${expectedFactsTotal})`,
      required: ">= 95%",
    },
    {
      name: "Cross-user leakage",
      passed: crossUserLeakageCount === 0,
      observed: `${crossUserLeakageCount} foreign facts`,
      required: "0",
    },
    {
      name: "Profile quality review",
      passed: profileQualityApproved,
      observed: profileQualityApproved ? "approved" : "not approved",
      required: "manual approval",
    },
    {
      name: "p95 hydration latency",
      passed: p95HydrationLatencyMs <= MAX_P95_HYDRATION_LATENCY_MS,
      observed: `${p95HydrationLatencyMs} ms`,
      required: "<= 1200 ms",
    },
    {
      name: "Timeout/error rate",
      passed: timeoutErrorRate < MAX_TIMEOUT_ERROR_RATE,
      observed: `${formatPercent(timeoutErrorRate)} (${timeoutErrorCount}/${input.measurements.length})`,
      required: "< 1%",
    },
    {
      name: "Prompt length",
      passed:
        promptCap.length === 0 &&
        promptLengthRegressionPercent <= options.maxPromptRegressionPercent,
      observed: `${formatSignedPercent(promptLengthRegressionPercent)} mean regression; max ${Math.max(...promptChars)} chars`,
      required: `<= ${options.maxPromptRegressionPercent}% mean regression and <= ${MAX_PROMPT_CHARS} chars`,
    },
    {
      name: "Corrected facts",
      passed: staleVersionViolationCount === 0,
      observed: `${staleVersionViolationCount} stale-current matches`,
      required: "0",
    },
    {
      name: "Must-not-remember absence",
      passed: mustNotRememberViolationCount === 0,
      observed: `${mustNotRememberViolationCount} forbidden matches`,
      required: "0",
    },
  ];

  return {
    schemaVersion: 1,
    runId: input.runId ?? null,
    sample: options.sample,
    corpus: {
      caseCount: SUPERMEMORY_RECALL_CORPUS.length,
      categoryCount: new Set(SUPERMEMORY_RECALL_CORPUS.map(({ category }) => category)).size,
      profileReviewCaseCount: SUPERMEMORY_RECALL_CORPUS.filter(
        ({ includeInProfileQualityReview }) => includeInProfileQualityReview,
      ).length,
    },
    metrics: {
      expectedFactRecallRate,
      expectedFactsRecalled,
      expectedFactsTotal,
      crossUserLeakageCount,
      expectedAbsenceViolationCount,
      staleVersionViolationCount,
      mustNotRememberViolationCount,
      p50HydrationLatencyMs,
      p95HydrationLatencyMs,
      timeoutErrorRate,
      timeoutErrorCount,
      meanResultCount: mean(input.measurements.map(({ resultCount }) => resultCount)),
      legacySupermemoryOverlapRate: rate(overlapIntersection, overlapUnion),
      meanPromptChars,
      meanLegacyPromptChars,
      maxPromptChars: Math.max(...promptChars),
      promptLengthRegressionPercent,
      profileQualityApproved,
    },
    gates,
    passed: gates.every(({ passed }) => passed),
    failingCaseIds: {
      missedExpectedFacts,
      crossUserLeakage,
      staleVersions,
      mustNotRemember,
      timeoutOrError,
      promptCap,
    },
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return "not comparable";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatNumber(value: number): string {
  return value.toFixed(1);
}

function formatTextReport(report: EvaluationReport): string {
  const lines = [
    "SuperMemory recall cutover evaluation",
    `Run: ${report.runId ?? "unnamed"}${report.sample ? " (SYNTHETIC SAMPLE — NOT CUTOVER EVIDENCE)" : ""}`,
    `Corpus: ${report.corpus.caseCount} cases, ${report.corpus.categoryCount} categories, ${report.corpus.profileReviewCaseCount} profile-review cases`,
    "",
    ...report.gates.map(
      (gate) => `${gate.passed ? "PASS" : "FAIL"}  ${gate.name}: ${gate.observed} (required ${gate.required})`,
    ),
    "",
    `p50/p95 hydration: ${report.metrics.p50HydrationLatencyMs}/${report.metrics.p95HydrationLatencyMs} ms`,
    `Mean result count: ${formatNumber(report.metrics.meanResultCount)}`,
    `Legacy/SuperMemory fact overlap: ${formatPercent(report.metrics.legacySupermemoryOverlapRate)}`,
    `Mean prompt chars: ${formatNumber(report.metrics.meanPromptChars)} SuperMemory vs ${formatNumber(report.metrics.meanLegacyPromptChars)} legacy`,
    `Expected-absence violations: ${report.metrics.expectedAbsenceViolationCount}`,
    "",
    `READ CUTOVER GATE: ${report.passed ? "PASS" : "FAIL"}`,
  ];

  const failingGroups = Object.entries(report.failingCaseIds).filter(([, caseIds]) => caseIds.length > 0);
  if (failingGroups.length > 0) {
    lines.push("", "Cases requiring review:");
    for (const [label, caseIds] of failingGroups) {
      lines.push(`- ${label}: ${caseIds.join(", ")}`);
    }
  }
  if (report.sample) {
    lines.push("", "The synthetic sample validates the calculator only; use a measured shadow-run file for a cutover decision.");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  validateCorpus(SUPERMEMORY_RECALL_CORPUS);
  const input = options.sample
    ? makeSampleInput()
    : parseEvaluationInput(JSON.parse(await readFile(options.inputPath!, "utf8")));
  const report = evaluate(input, options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatTextReport(report));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown evaluation error";
  console.error(`SuperMemory recall evaluation failed: ${message}`);
  process.exitCode = 2;
});
