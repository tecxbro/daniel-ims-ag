import { describe, expect, it } from "vitest";
import {
  LEADING_SPRING,
  TRAILING_SPRING,
  directionalSpringParameters,
  springEdgeSettled,
  stepSpringEdge,
  type SpringEdge,
} from "./liquidSelectionMotion.js";

describe("liquid selection motion", () => {
  it("assigns the faster spring to the leading edge", () => {
    expect(directionalSpringParameters(20, 80)).toEqual({
      low: TRAILING_SPRING,
      high: LEADING_SPRING,
    });
    expect(directionalSpringParameters(80, 20)).toEqual({
      low: LEADING_SPRING,
      high: TRAILING_SPRING,
    });
  });

  it("converges a selection edge within the 420ms motion budget", () => {
    let edge: SpringEdge = { value: 0, velocity: 0, target: 120 };
    for (let elapsed = 0; elapsed < 0.42; elapsed += 1 / 120) {
      edge = stepSpringEdge(edge, LEADING_SPRING, 1 / 120);
    }

    expect(Math.abs(edge.target - edge.value)).toBeLessThan(0.25);
    expect(springEdgeSettled(edge)).toBe(true);
  });

  it("keeps the trailing edge slower to create a restrained stretch", () => {
    let leading: SpringEdge = { value: 40, velocity: 0, target: 160 };
    let trailing: SpringEdge = { value: 0, velocity: 0, target: 120 };
    for (let elapsed = 0; elapsed < 0.08; elapsed += 1 / 120) {
      leading = stepSpringEdge(leading, LEADING_SPRING, 1 / 120);
      trailing = stepSpringEdge(trailing, TRAILING_SPRING, 1 / 120);
    }

    expect(leading.value - 40).toBeGreaterThan(trailing.value);
  });
});
