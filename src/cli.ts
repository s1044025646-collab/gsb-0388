// 命令行入口：导入、求最小圆、边界证据、候选核验、增删点、导出、演示。
import { readFileSync } from "node:fs";
import { Store } from "./store.js";
import {
  ApiError,
  computeReport,
  validatePoints,
  verifyCandidate,
  DISPLAY_LIMIT,
  InputPoint,
  MecReport,
} from "./service.js";

const store = new Store();

function fmt(v: number): string {
  return Number(v.toFixed(10)).toString();
}

function printReport(report: MecReport): void {
  if (!report.circle) {
    console.log("空点集：没有圆。");
    return;
  }
  const c = report.circle;
  console.log(`圆心: (${fmt(c.cx)}, ${fmt(c.cy)})  半径: ${fmt(c.radius)}  半径²: ${fmt(c.radiusSq)}`);
  console.log(
    `支撑点(${report.support.length}): ` +
      report.support.map((s) => `(${s.x},${s.y})<-[${s.sourceIds.join(",")}]`).join("  ")
  );
  console.log(`促使圆变化的输入: ${report.changedPointIds.join(", ") || "(无)"}`);
  console.log(`容差 eps=${report.epsContain}  算法版本 ${report.algoVersion}`);
  const rows = report.distances;
  const shown = rows.slice(0, DISPLAY_LIMIT);
  console.log(`\n覆盖余量表（按余量升序，共 ${rows.length} 点，显示前 ${shown.length} 条；覆盖判定针对全部点）:`);
  console.log("id\t(x,y)\t\tdist²\t\tmargin(r²-dist²)\tcovered");
  for (const d of shown) {
    console.log(
      `${d.id}\t(${d.x},${d.y})\t\t${fmt(d.distSq)}\t\t${fmt(d.margin)}\t\t${d.covered ? "yes" : "NO"}`
    );
  }
  const uncovered = rows.filter((r) => !r.covered);
  console.log(uncovered.length === 0 ? "全部点均被覆盖。" : `警告：${uncovered.length} 个点未被覆盖！`);
}

function loadPointsFile(file: string): InputPoint[] {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return validatePoints(Array.isArray(raw) ? raw : raw.points);
}

function cmdDemo(): void {
  const cases: [string, InputPoint[]][] = [
    [
      "演示1 直角三角形 (0,0),(4,0),(0,3) -> 圆心(2,1.5) 半径2.5（斜边为直径，两点支撑）",
      [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 4, y: 0 },
        { id: "C", x: 0, y: 3 },
      ],
    ],
    [
      "演示2 锐角三角形 (0,0),(6,0),(1,4) -> 需要三个支撑点（外接圆）",
      [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 6, y: 0 },
        { id: "C", x: 1, y: 4 },
      ],
    ],
    [
      "演示3 共线点 (-5,0),(0,0),(3,0),(7,0) -> 只由两端 (-5,0),(7,0) 的直径圆决定",
      [
        { id: "P1", x: -5, y: 0 },
        { id: "P2", x: 0, y: 0 },
        { id: "P3", x: 3, y: 0 },
        { id: "P4", x: 7, y: 0 },
      ],
    ],
  ];
  for (const [title, pts] of cases) {
    console.log("=".repeat(72));
    console.log(title);
    console.log("=".repeat(72));
    const report = computeReport(pts);
    printReport(report);
    console.log("\n圆心计算过程:");
    for (const line of report.supportExplanation) console.log("  " + line);
    console.log();
  }
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "import": {
      // import <file.json> [name]
      const points = loadPointsFile(args[0]);
      const name = args[1] ?? args[0];
      const id = store.createDataset(name, points, null, 1);
      console.log(`已导入数据集 id=${id}，点数=${points.length}`);
      break;
    }
    case "list":
      for (const d of store.listDatasets()) {
        console.log(`id=${d.id} v${d.version} ${d.name} parent=${d.parentId ?? "-"} ${d.createdAt}`);
      }
      break;
    case "show":
      console.log(JSON.stringify(store.getPoints(Number(args[0])), null, 2));
      break;
    case "mec": {
      const id = Number(args[0]);
      store.mustGetDataset(id);
      const report = computeReport(store.getPoints(id));
      store.saveReport(id, report);
      printReport(report);
      break;
    }
    case "report": {
      const report = store.getReport(Number(args[0]));
      if (!report) throw new ApiError("NOT_FOUND", "尚未计算，请先运行 mec", 404);
      printReport(report);
      break;
    }
    case "evidence": {
      const report = store.getReport(Number(args[0]));
      if (!report) throw new ApiError("NOT_FOUND", "尚未计算，请先运行 mec", 404);
      console.log("支撑点:", JSON.stringify(report.support));
      for (const line of report.supportExplanation) console.log(line);
      break;
    }
    case "verify": {
      // verify <datasetId> <cx> <cy> <radius>
      const id = Number(args[0]);
      const report = store.getReport(id);
      const result = verifyCandidate(
        store.getPoints(id),
        Number(args[1]),
        Number(args[2]),
        Number(args[3]),
        report?.circle ? report.circle.radius : null
      );
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "add": {
      // add <datasetId> <pointId> <x> <y>
      const id = Number(args[0]);
      const ds = store.mustGetDataset(id);
      const current = store.getPoints(id);
      const added = validatePoints([{ id: args[1], x: Number(args[2]), y: Number(args[3]) }])[0];
      if (current.some((p) => p.id === added.id)) {
        throw new ApiError("INVALID_INPUT", `点编号已存在: ${added.id}`);
      }
      const next = validatePoints([...current, added]);
      const newId = store.createDataset(ds.name, next, id, ds.version + 1);
      console.log(`已创建新版本 id=${newId} (v${ds.version + 1})，点数=${next.length}`);
      break;
    }
    case "remove": {
      // remove <datasetId> <pointId>
      const id = Number(args[0]);
      const ds = store.mustGetDataset(id);
      const next = store.getPoints(id).filter((p) => p.id !== args[1]);
      const newId = store.createDataset(ds.name, next, id, ds.version + 1);
      console.log(`已创建新版本 id=${newId} (v${ds.version + 1})，点数=${next.length}`);
      break;
    }
    case "export": {
      const id = Number(args[0]);
      console.log(
        JSON.stringify(
          { dataset: store.mustGetDataset(id), points: store.getPoints(id), report: store.getReport(id) },
          null,
          2
        )
      );
      break;
    }
    case "demo":
      cmdDemo();
      break;
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  import <file.json> [name]     导入点集
  list                          列出数据集
  show <id>                     查看输入快照
  mec <id>                      计算最小包围圆并保存报告
  report <id>                   查看已保存报告（含覆盖余量表）
  evidence <id>                 查看边界支撑点与圆心计算过程
  verify <id> <cx> <cy> <r>     核验候选圆
  add <id> <pid> <x> <y>        增点（产生新版本）
  remove <id> <pid>             删点（产生新版本）
  export <id>                   导出数据集与报告
  demo                          运行内置演示`);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof ApiError) {
    console.error(`错误[${e.code}]: ${e.message}`);
    process.exit(2);
  }
  throw e;
} finally {
  store.close();
}
