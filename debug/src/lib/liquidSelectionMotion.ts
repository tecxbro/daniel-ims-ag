export interface SpringParameters {
  stiffness: number;
  damping: number;
}

export interface SpringEdge {
  value: number;
  velocity: number;
  target: number;
}

export const LEADING_SPRING: SpringParameters = { stiffness: 520, damping: 42 };
export const TRAILING_SPRING: SpringParameters = { stiffness: 380, damping: 36 };
export const BALANCED_SPRING: SpringParameters = { stiffness: 440, damping: 39 };

export function directionalSpringParameters(
  currentCenter: number,
  targetCenter: number,
): { low: SpringParameters; high: SpringParameters } {
  if (targetCenter > currentCenter + 0.25) {
    return { low: TRAILING_SPRING, high: LEADING_SPRING };
  }
  if (targetCenter < currentCenter - 0.25) {
    return { low: LEADING_SPRING, high: TRAILING_SPRING };
  }
  return { low: BALANCED_SPRING, high: BALANCED_SPRING };
}

export function stepSpringEdge(
  edge: SpringEdge,
  parameters: SpringParameters,
  deltaSeconds: number,
) {
  const acceleration =
    -parameters.stiffness * (edge.value - edge.target) -
    parameters.damping * edge.velocity;
  return {
    ...edge,
    velocity: edge.velocity + acceleration * deltaSeconds,
    value: edge.value + (edge.velocity + acceleration * deltaSeconds) * deltaSeconds,
  };
}

export function springEdgeSettled(edge: SpringEdge) {
  return Math.abs(edge.value - edge.target) < 0.25 && Math.abs(edge.velocity) < 2;
}
