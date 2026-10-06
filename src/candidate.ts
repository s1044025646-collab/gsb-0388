import { inclusionTolerance, type InputPoint, type Vector } from "./geometry.js";

export interface CandidateCircle {
  center: Vector;
  radius: number;
}

export interface CandidateVerification {
  coversAll: boolean;
  uncoveredPointIds: number[];
  tolerance: number;
  rows: Array<{
    id: number;
    x: number;
    y: number;
    distanceSquared: number;
    radiusSquared: number;
    margin: number;
    covered: boolean;
  }>;
  computedRadius: number | null;
  radiusDifference: number | null;
  optimality: "unknown" | "not_optimal" | "matches_optimum";
}

function distanceSquared(a: Vector, b: Vector): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function validateCandidate(value: unknown): { candidate?: CandidateCircle; error?: string } {
  if (!value || typeof value !== "object") return { error: "candidate 必须是对象" };
  const candidate = value as Record<string, unknown>;
  const center = candidate.center as Record<string, unknown> | undefined;
  if (!center || typeof center !== "object" || typeof center.x !== "number" || typeof center.y !== "number") {
    return { error: "candidate.center.x 与 candidate.center.y 必须是数字" };
  }
  if (typeof candidate.radius !== "number" || !Number.isFinite(candidate.radius) || candidate.radius < 0) {
    return { error: "candidate.radius 必须是非负有限数" };
  }
  return { candidate: { center: { x: center.x, y: center.y }, radius: candidate.radius } };
}

export function verifyCandidate(
  points: InputPoint[],
  candidate: CandidateCircle,
  computedRadius: number | null = null,
): CandidateVerification {
  const radiusSquared = candidate.radius * candidate.radius;
  const tolerance = inclusionTolerance(candidate.center, radiusSquared);
  const rows = points.map((point) => {
    const d2 = distanceSquared(candidate.center, point);
    const margin = radiusSquared - d2;
    return {
      ...point,
      distanceSquared: d2,
      radiusSquared,
      margin,
      covered: d2 <= radiusSquared + tolerance,
    };
  });
  const uncovered = rows.filter((row) => !row.covered).map((row) => row.id);
  const radiusDifference = computedRadius === null ? null : candidate.radius - computedRadius;
  let optimality: CandidateVerification["optimality"] = "unknown";
  if (radiusDifference !== null && Math.abs(radiusDifference) <= 1e-10 * Math.max(1, computedRadius!, candidate.radius)) {
    optimality = "matches_optimum";
  } else if (radiusDifference !== null && radiusDifference < -1e-10 * Math.max(1, computedRadius!, candidate.radius)) {
    optimality = "not_optimal";
  }
  return {
    coversAll: uncovered.length === 0,
    uncoveredPointIds: uncovered,
    tolerance,
    rows,
    computedRadius,
    radiusDifference,
    optimality,
  };
}
