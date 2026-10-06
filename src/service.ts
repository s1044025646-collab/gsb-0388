// 领域服务：输入校验、最小包围圆计算、报告构建、候选圆核验。
import {
  ALGO_VERSION,
  EPS_CONTAIN,
  Pt,
  Circle,
  dist2To,
  mec,
  explainSupport,
} from "./geometry.js";

export const MAX_POINTS = 300;
export const MAX_COORD = 1_000_000;
export const DISPLAY_LIMIT = 50; // 展示限量；计算始终覆盖全部点

export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "LIMIT_EXCEEDED"
  | "EMPTY_DATASET"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface InputPoint {
  id: string;
  x: number;
  y: number;
}

export function validatePoints(raw: unknown): InputPoint[] {
  if (!Array.isArray(raw)) throw new ApiError("INVALID_INPUT", "points 必须是数组");
  if (raw.length > MAX_POINTS) {
    throw new ApiError("LIMIT_EXCEEDED", `点数超过上限 ${MAX_POINTS}`);
  }
  const seen = new Set<string>();
  const out: InputPoint[] = [];
  for (const [idx, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      throw new ApiError("INVALID_INPUT", `points[${idx}] 不是对象`);
    }
    const { id, x, y } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      throw new ApiError("INVALID_INPUT", `points[${idx}].id 必须是 1~64 字符的字符串`);
    }
    if (seen.has(id)) throw new ApiError("INVALID_INPUT", `点编号重复: ${id}`);
    seen.add(id);
    for (const [name, v] of [
      ["x", x],
      ["y", y],
    ] as const) {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        throw new ApiError("INVALID_INPUT", `points[${idx}].${name} 必须是整数`);
      }
      if (Math.abs(v) > MAX_COORD) {
        throw new ApiError(
          "LIMIT_EXCEEDED",
          `points[${idx}].${name} 超出坐标范围 ±${MAX_COORD}`
        );
      }
    }
    out.push({ id, x: x as number, y: y as number });
  }
  return out;
}

export interface PointDistance {
  id: string;
  x: number;
  y: number;
  distSq: number; // 到圆心的平方距离
  margin: number; // 覆盖余量 = r2 - distSq（>= -eps 视为被覆盖）
  covered: boolean;
}

export interface MecReport {
  algoVersion: string;
  epsContain: number;
  limits: { maxPoints: number; maxCoord: number };
  pointCount: number;
  uniqueCount: number;
  circle: { cx: number; cy: number; radius: number; radiusSq: number } | null;
  support: { x: number; y: number; sourceIds: string[] }[];
  // 触发圆变化的输入点编号（按内部稳定排序顺序）
  changedPointIds: string[];
  distances: PointDistance[];
  supportExplanation: string[];
}

export function computeReport(points: InputPoint[]): MecReport {
  // 坐标 -> 来源编号列表（重复坐标保留全部来源）
  const byCoord = new Map<string, { pt: Pt; ids: string[] }>();
  for (const p of points) {
    const key = `${p.x},${p.y}`;
    const entry = byCoord.get(key);
    if (entry) entry.ids.push(p.id);
    else byCoord.set(key, { pt: { x: p.x, y: p.y }, ids: [p.id] });
  }
  // 稳定排序（按 x 再 y），保证输入顺序不影响几何答案
  const unique = [...byCoord.values()].sort((a, b) => a.pt.x - b.pt.x || a.pt.y - b.pt.y);
  const sortedPts = unique.map((u) => u.pt);
  const result = mec(sortedPts);

  const distances: PointDistance[] = points
    .map((p) => {
      const d2 = result.circle ? dist2To(result.circle, p) : 0;
      const margin = result.circle ? result.circle.r2 - d2 : 0;
      return {
        id: p.id,
        x: p.x,
        y: p.y,
        distSq: d2,
        margin,
        covered: result.circle
          ? margin >= -EPS_CONTAIN * Math.max(1, result.circle.r2)
          : false,
      };
    })
    .sort((a, b) => a.margin - b.margin || a.id.localeCompare(b.id));

  const support = result.boundary.map((pt) => ({
    x: pt.x,
    y: pt.y,
    sourceIds: byCoord.get(`${pt.x},${pt.y}`)!.ids,
  }));

  return {
    algoVersion: ALGO_VERSION,
    epsContain: EPS_CONTAIN,
    limits: { maxPoints: MAX_POINTS, maxCoord: MAX_COORD },
    pointCount: points.length,
    uniqueCount: sortedPts.length,
    circle: result.circle
      ? {
          cx: result.circle.cx,
          cy: result.circle.cy,
          radius: Math.sqrt(result.circle.r2),
          radiusSq: result.circle.r2,
        }
      : null,
    support,
    changedPointIds: result.changedIndices.map((i) => {
      const pt = sortedPts[i];
      return byCoord.get(`${pt.x},${pt.y}`)!.ids[0];
    }),
    distances,
    supportExplanation: result.circle ? explainSupport(result.boundary, result.circle) : [],
  };
}

export interface VerifyResult {
  allCovered: boolean;
  uncovered: { id: string; x: number; y: number; distSq: number; excess: number }[];
  candidate: { cx: number; cy: number; radius: number; radiusSq: number };
  optimalRadius: number | null;
  radiusDiff: number | null; // 候选半径 - 最优半径（已知最优结果时）
  note: string;
}

export function verifyCandidate(
  points: InputPoint[],
  cx: unknown,
  cy: unknown,
  radius: unknown,
  optimalRadius: number | null
): VerifyResult {
  for (const [name, v] of [
    ["cx", cx],
    ["cy", cy],
    ["radius", radius],
  ] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ApiError("INVALID_INPUT", `${name} 必须是有限数值`);
    }
  }
  if ((radius as number) < 0) throw new ApiError("INVALID_INPUT", "radius 不能为负");
  const cand: Circle = { cx: cx as number, cy: cy as number, r2: (radius as number) ** 2 };
  const uncovered = points
    .map((p) => {
      const d2 = dist2To(cand, p);
      return { id: p.id, x: p.x, y: p.y, distSq: d2, excess: d2 - cand.r2 };
    })
    .filter((e) => e.excess > EPS_CONTAIN * Math.max(1, cand.r2))
    .sort((a, b) => b.excess - a.excess);
  return {
    allCovered: uncovered.length === 0,
    uncovered,
    candidate: {
      cx: cand.cx,
      cy: cand.cy,
      radius: radius as number,
      radiusSq: cand.r2,
    },
    optimalRadius,
    radiusDiff: optimalRadius === null ? null : (radius as number) - optimalRadius,
    note:
      uncovered.length === 0
        ? "候选圆覆盖全部点；覆盖全部点不代表最小，请参考 radiusDiff。"
        : `候选圆未覆盖 ${uncovered.length} 个点。`,
  };
}
