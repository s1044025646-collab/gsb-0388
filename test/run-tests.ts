// 测试：几何正确性、暴力枚举基准、不变量（平移/缩放/重排/单调性）、场景用例。
import {
  Pt,
  mec,
  bruteForceMec,
  contains,
  EPS_CONTAIN,
} from "../src/geometry.js";
import { computeReport, InputPoint } from "../src/service.js";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name} ${detail}`);
  }
}

function close(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

function toInput(pts: Pt[]): InputPoint[] {
  return pts.map((p, i) => ({ id: `p${i}`, x: p.x, y: p.y }));
}

// 1. 演示用例：直角三角形
{
  const r = computeReport(toInput([
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 0, y: 3 },
  ]));
  check(
    close(r.circle!.cx, 2) && close(r.circle!.cy, 1.5) && close(r.circle!.radius, 2.5),
    "直角三角形圆心(2,1.5)半径2.5",
    JSON.stringify(r.circle)
  );
  check(r.support.length === 2, "直角三角形由斜边两端支撑");
}

// 2. 锐角三角形需要三个支撑点
{
  const r = computeReport(toInput([
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 1, y: 4 },
  ]));
  check(r.support.length === 3, "锐角三角形三个支撑点", `support=${r.support.length}`);
}

// 3. 共线点只由两端决定
{
  const r = computeReport(toInput([
    { x: -5, y: 0 },
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 7, y: 0 },
  ]));
  check(
    r.support.length === 2 && close(r.circle!.cx, 1) && close(r.circle!.radius, 6),
    "共线点由两端直径圆决定",
    JSON.stringify(r.circle)
  );
}

// 4. 重复点 / 全相同
{
  const r = computeReport([
    { id: "a", x: 3, y: 3 },
    { id: "b", x: 3, y: 3 },
    { id: "c", x: 3, y: 3 },
  ]);
  check(r.circle!.radius === 0 && r.support.length === 1, "全相同点半径为0");
  check(r.support[0].sourceIds.length === 3, "重复坐标保留全部来源编号");
  const r2 = computeReport(toInput([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 0 },
  ]));
  check(close(r2.circle!.radius, 5), "重复点不重复影响计算");
}

// 5. 负坐标 / 矩形四角
{
  const r = computeReport(toInput([
    { x: -4, y: -3 },
    { x: 4, y: -3 },
    { x: 4, y: 3 },
    { x: -4, y: 3 },
  ]));
  check(
    close(r.circle!.cx, 0) && close(r.circle!.cy, 0) && close(r.circle!.radius, 5),
    "矩形四角圆心原点半径5"
  );
}

// 6. 内部点增删与远处新点
{
  const base: Pt[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
  ];
  const r0 = computeReport(toInput(base));
  const withInner = computeReport(toInput([...base, { x: 2, y: 2 }]));
  check(close(withInner.circle!.radius, r0.circle!.radius), "内部点不改变圆");
  const withFar = computeReport(toInput([...base, { x: 100, y: 100 }]));
  check(withFar.circle!.radius > r0.circle!.radius, "远处新点使半径增大");
  check(withFar.changedPointIds.includes("p3"), "远处新点被记录为促使圆变化");
}

// 7. 空点集与单点
{
  const r0 = computeReport([]);
  check(r0.circle === null, "空点集没有圆");
  const r1 = computeReport(toInput([{ x: -7, y: 5 }]));
  check(r1.circle!.radius === 0 && r1.circle!.cx === -7, "单点半径为零");
}

// 8. 暴力枚举基准（n<=10 随机小点集）
{
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  let okAll = true;
  for (let t = 0; t < 200; t++) {
    const n = 1 + (rand() % 10);
    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) {
      pts.push({ x: rand() % 41 - 20, y: rand() % 41 - 20 });
    }
    const unique = [...new Map(pts.map((p) => [`${p.x},${p.y}`, p])).values()].sort(
      (a, b) => a.x - b.x || a.y - b.y
    );
    const fast = mec(unique).circle!;
    const brute = bruteForceMec(unique)!;
    if (!close(fast.r2, brute.r2, 1e-7)) {
      okAll = false;
      console.error(`  基准不一致: fast=${fast.r2} brute=${brute.r2}`, JSON.stringify(unique));
    }
    if (!unique.every((p) => contains(fast, p))) {
      okAll = false;
      console.error("  存在未覆盖点", JSON.stringify(unique));
    }
  }
  check(okAll, "200 组随机小点集与暴力枚举基准一致且全覆盖");
}

// 9. 不变量：平移、整数缩放、重排、半径单调
{
  const base: Pt[] = [
    { x: -3, y: 2 },
    { x: 5, y: -1 },
    { x: 0, y: 7 },
    { x: 2, y: 2 },
    { x: -6, y: -4 },
  ];
  const r0 = computeReport(toInput(base));
  const moved = computeReport(toInput(base.map((p) => ({ x: p.x + 100, y: p.y - 50 }))));
  check(
    close(moved.circle!.cx, r0.circle!.cx + 100) &&
      close(moved.circle!.cy, r0.circle!.cy - 50) &&
      close(moved.circle!.radius, r0.circle!.radius),
    "平移不变"
  );
  const scaled = computeReport(toInput(base.map((p) => ({ x: p.x * 3, y: p.y * 3 }))));
  check(close(scaled.circle!.radius, r0.circle!.radius * 3, 1e-9), "整数缩放半径同倍");
  const shuffled = computeReport(toInput([...base].reverse()));
  check(
    close(shuffled.circle!.cx, r0.circle!.cx) &&
      close(shuffled.circle!.cy, r0.circle!.cy) &&
      close(shuffled.circle!.radius, r0.circle!.radius),
    "输入重排几何答案不变"
  );
  let prev = -1;
  let mono = true;
  for (let i = 1; i <= base.length; i++) {
    const r = computeReport(toInput(base.slice(0, i))).circle!.radius;
    if (r < prev - EPS_CONTAIN) mono = false;
    prev = r;
  }
  check(mono, "半径随加点不减");
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
