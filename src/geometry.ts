export interface InputPoint {
  id: number;
  x: number;
  y: number;
}

export interface Vector {
  x: number;
  y: number;
}

export interface Circle {
  center: Vector;
  radius: number;
  radiusSquared: number;
  support: InputPoint[];
}

export interface PointCoverage {
  id: number;
  x: number;
  y: number;
  distanceSquared: number;
  margin: number;
  toleranceAdjustedMargin: number;
  covered: boolean;
  duplicateOf: number | null;
}

export interface ChangeEvent {
  id: number;
  x: number;
  y: number;
  reason: "initial_point" | "outside_current_circle";
  previousRadius: number | null;
  nextRadius: number;
}

export interface MinimumCircleResult {
  circle: Circle | null;
  supports: Array<{ kind: "single" | "diameter" | "circumcircle"; pointIds: number[] }>;
  coverage: PointCoverage[];
  changes: ChangeEvent[];
  duplicateGroups: Array<{ canonicalId: number; pointIds: number[]; x: number; y: number }>;
  tolerance: {
    integerCollinearityEpsilon: number;
    floatingInclusionEpsilon: number;
    floatingScale: number;
    formula: string;
  };
  algorithm: {
    version: string;
    name: string;
    canonicalOrderRule: string;
    supportTieRule: string;
  };
}

export const ALGORITHM_VERSION = "mec-welzl-deterministic-1";
export const MAX_POINTS = 300;
export const COORDINATE_LIMIT = 1_000_000;
export const INTEGER_COLLINEARITY_EPSILON = 0;
export const FLOATING_RELATIVE_EPSILON = 1e-10;

const POSITIVE_RADIUS_EPSILON = 1e-12;

export function inclusionTolerance(center: Vector, radiusSquared: number): number {
  const scale = Math.max(1, Math.abs(center.x), Math.abs(center.y), radiusSquared);
  return FLOATING_RELATIVE_EPSILON * scale;
}

function distanceSquared(a: Vector, b: Vector): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function circleFromOne(p: InputPoint): Circle {
  return { center: { x: p.x, y: p.y }, radius: 0, radiusSquared: 0, support: [p] };
}

function circleFromTwo(a: InputPoint, b: InputPoint): Circle {
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const radiusSquared = distanceSquared(center, a);
  return {
    center,
    radius: Math.sqrt(radiusSquared),
    radiusSquared,
    support: [a, b],
  };
}

function exactCross(a: InputPoint, b: InputPoint, c: InputPoint): number {
  return (
    (b.x - a.x) * (c.y - a.y) -
    (b.y - a.y) * (c.x - a.x)
  );
}

function circleFromThree(a: InputPoint, b: InputPoint, c: InputPoint): Circle {
  const cross = exactCross(a, b, c);
  if (Math.abs(cross) === INTEGER_COLLINEARITY_EPSILON) {
    const ab = distanceSquared(a, b);
    const ac = distanceSquared(a, c);
    const bc = distanceSquared(b, c);
    if (ab >= ac && ab >= bc) return circleFromTwo(a, b);
    if (ac >= ab && ac >= bc) return circleFromTwo(a, c);
    return circleFromTwo(b, c);
  }

  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const denominator = 2 * cross;
  const center = {
    x: (
      a2 * (b.y - c.y) +
      b2 * (c.y - a.y) +
      c2 * (a.y - b.y)
    ) / denominator,
    y: (
      a2 * (c.x - b.x) +
      b2 * (a.x - c.x) +
      c2 * (b.x - a.x)
    ) / denominator,
  };
  const radiusSquared = distanceSquared(center, a);
  return {
    center,
    radius: Math.sqrt(Math.max(0, radiusSquared)),
    radiusSquared: Math.max(0, radiusSquared),
    support: [a, b, c],
  };
}

export function trivialBoundaryCircle(points: InputPoint[]): Circle | null {
  if (points.length === 0) return null;
  if (points.length === 1) return circleFromOne(points[0]!);
  if (points.length === 2) return circleFromTwo(points[0]!, points[1]!);
  return circleFromThree(points[0]!, points[1]!, points[2]!);
}

export function circleContainsPoint(circle: Circle, point: Vector, tolerance = inclusionTolerance(circle.center, circle.radiusSquared)): boolean {
  return distanceSquared(circle.center, point) <= circle.radiusSquared + tolerance;
}

function canonicalPoints(points: InputPoint[]): InputPoint[] {
  const byPosition = new Map<string, InputPoint>();
  for (const point of points) {
    const key = `${point.x}/${point.y}`;
    const existing = byPosition.get(key);
    if (!existing || point.id < existing.id) byPosition.set(key, point);
  }
  return [...byPosition.values()].sort((a, b) => a.x - b.x || a.y - b.y || a.id - b.id);
}

function deterministicOrder(points: InputPoint[]): InputPoint[] {
  const ordered = canonicalPoints(points);
  let state = 0x1234_5678;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  }
  return ordered;
}

function welzl(points: InputPoint[], boundary: InputPoint[]): Circle | null {
  if (points.length === 0 || boundary.length === 3) {
    return trivialBoundaryCircle(boundary);
  }
  const point = points[points.length - 1]!;
  const rest = points.slice(0, -1);
  const circle = welzl(rest, boundary);
  if (circle && circleContainsPoint(circle, point)) return circle;
  return welzl(rest, [...boundary, point]);
}

function buildCoverage(resultCircle: Circle | null, points: InputPoint[]): PointCoverage[] {
  const canonicalIdByPosition = new Map<string, number>();
  for (const point of points) {
    const key = `${point.x}/${point.y}`;
    if (!canonicalIdByPosition.has(key)) canonicalIdByPosition.set(key, point.id);
  }

  return points.map((point) => {
    if (!resultCircle) {
      return {
        ...point,
        distanceSquared: 0,
        margin: 0,
        toleranceAdjustedMargin: 0,
        covered: false,
        duplicateOf: null,
      };
    }
    const distanceSquaredValue = distanceSquared(resultCircle.center, point);
    const tolerance = inclusionTolerance(resultCircle.center, resultCircle.radiusSquared);
    const margin = resultCircle.radiusSquared - distanceSquaredValue;
    const canonicalId = canonicalIdByPosition.get(`${point.x}/${point.y}`)!;
    return {
      ...point,
      distanceSquared: distanceSquaredValue,
      margin,
      toleranceAdjustedMargin: margin + tolerance,
      covered: distanceSquaredValue <= resultCircle.radiusSquared + tolerance,
      duplicateOf: canonicalId === point.id ? null : canonicalId,
    };
  });
}

function buildChanges(ordered: InputPoint[]): { circle: Circle | null; changes: ChangeEvent[] } {
  let circle: Circle | null = null;
  const changes: ChangeEvent[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const point = ordered[index]!;
    if (!circle) {
      circle = welzl(ordered.slice(0, index + 1), [point]);
      changes.push({
        id: point.id,
        x: point.x,
        y: point.y,
        reason: "initial_point",
        previousRadius: null,
        nextRadius: circle?.radius ?? 0,
      });
      continue;
    }
    if (circleContainsPoint(circle, point)) continue;
    const previousRadius = circle?.radius ?? null;
    circle = welzl(ordered.slice(0, index + 1), [point]);
    if (!circle) throw new Error("INTERNAL_CIRCLE_FAILURE");
    changes.push({
      id: point.id,
      x: point.x,
      y: point.y,
      reason: "outside_current_circle",
      previousRadius,
      nextRadius: circle.radius,
    });
  }
  return { circle, changes };
}

export function minimumEnclosingCircle(input: InputPoint[]): MinimumCircleResult {
  const ordered = deterministicOrder(input);
  const { circle, changes } = buildChanges(ordered);
  const coverage = buildCoverage(circle, input);
  const groups = new Map<string, InputPoint[]>();
  for (const point of input) {
    const key = `${point.x}/${point.y}`;
    const group = groups.get(key) ?? [];
    group.push(point);
    groups.set(key, group);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([, group]) => {
      const sortedIds = group.map((point) => point.id).sort((a, b) => a - b);
      const canonical = group.find((point) => point.id === sortedIds[0])!;
      return { canonicalId: canonical.id, pointIds: sortedIds, x: canonical.x, y: canonical.y };
    })
    .sort((a, b) => a.canonicalId - b.canonicalId);

  circle?.support.sort((a, b) => a.id - b.id);
  const supportCount = circle?.support.length ?? 0;
  const kind = supportCount === 1 ? "single" as const : supportCount === 2 ? "diameter" as const : "circumcircle" as const;
  const supports = circle
    ? [{
        kind,
        pointIds: circle.support.map((point) => point.id),
      }]
    : [];
  const floatingScale = circle
    ? Math.max(1, Math.abs(circle.center.x), Math.abs(circle.center.y), circle.radiusSquared)
    : 1;

  return {
    circle,
    supports,
    coverage,
    changes,
    duplicateGroups,
    tolerance: {
      integerCollinearityEpsilon: 0,
      floatingInclusionEpsilon: FLOATING_RELATIVE_EPSILON * floatingScale,
      floatingScale,
      formula: "distanceSquared <= radiusSquared + 1e-10 * max(1, |centerX|, |centerY|, radiusSquared)",
    },
    algorithm: {
      version: ALGORITHM_VERSION,
      name: "确定性受限规模增量 Welzl 边界约束算法",
      canonicalOrderRule: "重复坐标仅保留最小编号；先按 x、y、id 建立规范顺序，再使用公开固定种子的 xorshift 排列。",
      supportTieRule: "几何等价时报告规范排列中最先被边界递归选中的支撑点；同一坐标使用最小编号。",
    },
  };
}

export function enumerateMinimumCircle(points: InputPoint[]): Circle | null {
  const unique = canonicalPoints(points);
  if (unique.length === 0) return null;
  let best: Circle | null = null;
  const consider = (candidate: Circle) => {
    if (unique.some((point) => !circleContainsPoint(candidate, point))) return;
    if (!best || candidate.radiusSquared < best.radiusSquared - POSITIVE_RADIUS_EPSILON) {
      best = candidate;
    }
  };
  for (const p of unique) consider(circleFromOne(p));
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      consider(circleFromTwo(unique[i]!, unique[j]!));
    }
  }
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      for (let k = j + 1; k < unique.length; k += 1) {
        if (exactCross(unique[i]!, unique[j]!, unique[k]!) !== 0) {
          consider(circleFromThree(unique[i]!, unique[j]!, unique[k]!));
        }
      }
    }
  }
  return best;
}
