// 平面最小包围圆核心几何模块。
// 数值约定：
//  - 输入为整数坐标，共线/方向判断使用精确整数叉积（|x|,|y| <= 1e6 时叉积 <= 4e12，远低于 2^53，双精度精确）。
//  - 浮点圆的包含判断使用统一容差 EPS_CONTAIN（相对半径平方）。
export const EPS_CONTAIN = 1e-9;
export const EPS_CENTER = 1e-7; // 判定两个圆心/半径是否“同一个圆”的相对容差
export const ALGO_VERSION = "mec-incremental-1.0.0";

export interface Pt {
  x: number;
  y: number;
}

export interface Circle {
  cx: number;
  cy: number;
  r2: number; // 半径平方
}

export function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist2To(c: Circle, p: Pt): number {
  const dx = p.x - c.cx;
  const dy = p.y - c.cy;
  return dx * dx + dy * dy;
}

// 精确整数叉积 (b-a) x (c-a)
export function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function isCollinear(a: Pt, b: Pt, c: Pt): boolean {
  return cross(a, b, c) === 0; // 整数坐标下精确判断
}

export function contains(c: Circle, p: Pt): boolean {
  return dist2To(c, p) <= c.r2 + EPS_CONTAIN * Math.max(1, c.r2);
}

export function circleFrom1(a: Pt): Circle {
  return { cx: a.x, cy: a.y, r2: 0 };
}

// 两点直径圆
export function circleFrom2(a: Pt, b: Pt): Circle {
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, r2: dist2(a, b) / 4 };
}

// 三点圆：共线时退化为最远两点的直径圆，绝不除以零。
export function circleFrom3(a: Pt, b: Pt, c: Pt): Circle {
  if (isCollinear(a, b, c)) {
    const pairs: [Pt, Pt][] = [
      [a, b],
      [a, c],
      [b, c],
    ];
    let best: [Pt, Pt] = pairs[0];
    for (const p of pairs) if (dist2(p[0], p[1]) > dist2(best[0], best[1])) best = p;
    return circleFrom2(best[0], best[1]);
  }
  const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const circle = { cx: ux, cy: uy, r2: 0 };
  circle.r2 = dist2To(circle, a);
  return circle;
}

// 两个圆是否在容差意义下相同（用于支撑点选择）
export function sameCircle(a: Circle, b: Circle): boolean {
  const tolC = EPS_CENTER * Math.max(1, Math.abs(a.cx), Math.abs(a.cy));
  const tolR = EPS_CENTER * Math.max(1, a.r2);
  return (
    Math.abs(a.cx - b.cx) <= tolC &&
    Math.abs(a.cy - b.cy) <= tolC &&
    Math.abs(a.r2 - b.r2) <= tolR
  );
}

export interface MecResult {
  circle: Circle | null; // 空点集为 null
  // 决定最终圆的边界坐标（1~3 个，按 (x,y) 字典序，确定规则见 README）
  boundary: Pt[];
  // 在稳定排序后的唯一坐标序列中，触发圆重建的下标（含首次建圆）
  changedIndices: number[];
  // 参与计算的唯一坐标（稳定排序后），重复坐标只出现一次
  uniquePoints: Pt[];
}

// 受限规模增量算法（Welzl 思想的确定性迭代版本）。
// 输入顺序无关：调用方需先按 (x,y) 稳定排序并去重。
export function mec(pts: Pt[]): MecResult {
  const changed: number[] = [];
  if (pts.length === 0) {
    return { circle: null, boundary: [], changedIndices: [], uniquePoints: [] };
  }
  let circle: Circle | null = null;
  for (let i = 0; i < pts.length; i++) {
    if (circle === null || !contains(circle, pts[i])) {
      changed.push(i);
      circle = mecWith1(pts, i);
    }
  }
  const finalCircle = circle!;
  return {
    circle: finalCircle,
    boundary: selectBoundary(pts, finalCircle),
    changedIndices: changed,
    uniquePoints: pts,
  };
}

// 包含 pts[0..i] 且 pts[i] 在边界上的最小圆
function mecWith1(pts: Pt[], i: number): Circle {
  let circle = circleFrom1(pts[i]);
  for (let j = 0; j < i; j++) {
    if (!contains(circle, pts[j])) {
      circle = mecWith2(pts, j, i);
    }
  }
  return circle;
}

// 包含 pts[0..j] 且 pts[j]、pts[i] 在边界上的最小圆
function mecWith2(pts: Pt[], j: number, i: number): Circle {
  let circle = circleFrom2(pts[j], pts[i]);
  for (let k = 0; k < j; k++) {
    if (!contains(circle, pts[k])) {
      circle = circleFrom3(pts[k], pts[j], pts[i]);
    }
  }
  return circle;
}

// 从最终圆反推最小支撑集，确定规则：
//  1) 半径为 0 -> 字典序最小的那个坐标；
//  2) 否则按字典序枚举边界点对，取第一个“直径圆与最终圆一致”的对；
//  3) 否则按字典序枚举边界点三元组，取第一个外接圆与最终圆一致的三元组。
export function selectBoundary(pts: Pt[], circle: Circle): Pt[] {
  const onBoundary = pts.filter(
    (p) => Math.abs(dist2To(circle, p) - circle.r2) <= EPS_CONTAIN * Math.max(1, circle.r2)
  );
  if (circle.r2 <= EPS_CONTAIN) {
    return [onBoundary[0] ?? pts[0]];
  }
  for (let i = 0; i < onBoundary.length; i++) {
    for (let j = i + 1; j < onBoundary.length; j++) {
      if (sameCircle(circleFrom2(onBoundary[i], onBoundary[j]), circle)) {
        return [onBoundary[i], onBoundary[j]];
      }
    }
  }
  for (let i = 0; i < onBoundary.length; i++) {
    for (let j = i + 1; j < onBoundary.length; j++) {
      for (let k = j + 1; k < onBoundary.length; k++) {
        if (sameCircle(circleFrom3(onBoundary[i], onBoundary[j], onBoundary[k]), circle)) {
          return [onBoundary[i], onBoundary[j], onBoundary[k]];
        }
      }
    }
  }
  // 数值极端情况兜底：取前三个边界点（正常不会到达）
  return onBoundary.slice(0, Math.min(3, onBoundary.length));
}

// 独立基准：枚举全部 1/2/3 子集圆，筛选覆盖全部点的最小者（仅供小规模核验）。
export function bruteForceMec(pts: Pt[]): Circle | null {
  if (pts.length === 0) return null;
  let best: Circle | null = null;
  const consider = (c: Circle) => {
    if (!pts.every((p) => contains(c, p))) return;
    if (best === null || c.r2 < best.r2 - EPS_CONTAIN * Math.max(1, best.r2)) best = c;
  };
  for (let i = 0; i < pts.length; i++) {
    consider(circleFrom1(pts[i]));
    for (let j = i + 1; j < pts.length; j++) {
      consider(circleFrom2(pts[i], pts[j]));
      for (let k = j + 1; k < pts.length; k++) {
        if (!isCollinear(pts[i], pts[j], pts[k])) {
          consider(circleFrom3(pts[i], pts[j], pts[k]));
        }
      }
    }
  }
  return best;
}

// 支撑点 -> 圆心计算过程的中文解释
export function explainSupport(boundary: Pt[], circle: Circle): string[] {
  const lines: string[] = [];
  const f = (v: number) => Number(v.toFixed(10)).toString();
  if (boundary.length === 1) {
    const p = boundary[0];
    lines.push(`单点情形：所有输入坐标相同，最小包围圆退化为点圆。`);
    lines.push(`圆心 = (${f(p.x)}, ${f(p.y)})，半径 = 0。`);
  } else if (boundary.length === 2) {
    const [a, b] = boundary;
    lines.push(`两点情形：支撑点连线是圆的直径（其余点均在直径圆内）。`);
    lines.push(
      `圆心 = 中点 = ((${f(a.x)} + ${f(b.x)}) / 2, (${f(a.y)} + ${f(b.y)}) / 2) = (${f(circle.cx)}, ${f(circle.cy)})。`
    );
    lines.push(
      `半径 = 两点距离的一半 = sqrt(${f(dist2(a, b))}) / 2 = ${f(Math.sqrt(circle.r2))}。`
    );
  } else if (boundary.length === 3) {
    const [a, b, c] = boundary;
    lines.push(`三点情形：三个支撑点构成锐角或直角三角形，圆为它们的外接圆。`);
    lines.push(`圆心是三条边垂直平分线的交点，由线性方程组求解：`);
    lines.push(
      `  2*(B-A)·O = |B|^2 - |A|^2，其中 A=(${f(a.x)},${f(a.y)}), B=(${f(b.x)},${f(b.y)})`
    );
    lines.push(`  2*(C-A)·O = |C|^2 - |A|^2，其中 C=(${f(c.x)},${f(c.y)})`);
    lines.push(`解得圆心 O = (${f(circle.cx)}, ${f(circle.cy)})，半径 = ${f(Math.sqrt(circle.r2))}。`);
    lines.push(`（若三点共线则不会进入此分支，会改用最远两点的直径圆。）`);
  }
  return lines;
}
