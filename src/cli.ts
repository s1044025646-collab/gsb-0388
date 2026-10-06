#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { minimumEnclosingCircle, enumerateMinimumCircle, ALGORITHM_VERSION } from "./geometry.js";
import { validatePoints } from "./validation.js";
import { verifyCandidate } from "./candidate.js";
import { addVersion, createDataset, getVersion, openDatabase, serializeVersion } from "./db.js";
import { supportExplanation } from "./server.js";

type Json = Record<string, unknown>;

function fail(code: string, message: string): never {
  console.error(JSON.stringify({ error: { code, message } }, null, 2));
  process.exit(1);
}

function failIf(condition: boolean, code: string, message: string): void {
  if (condition) fail(code, message);
}

function readInput(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function pointsFromInput(value: unknown) {
  const body = (value && typeof value === "object" && "points" in value ? value : { points: value }) as Json;
  const checked = validatePoints(body.points);
  if (checked.error) fail(checked.error.error.code, checked.error.error.message);
  failIf(checked.points!.length > 300, "TOO_MANY_POINTS", "计算与显示点数上限均为 300");
  return checked.points!;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function printCoverage(result: ReturnType<typeof minimumEnclosingCircle>): void {
  if (!result.circle) {
    console.log("空点集：没有圆。");
    return;
  }
  console.log(`圆心=(${format(result.circle.center.x)}, ${format(result.circle.center.y)})`);
  console.log(`半径=${format(result.circle.radius)} 平方半径=${format(result.circle.radiusSquared)}`);
  console.log(`支撑点=${result.supports[0]?.pointIds.join(",")} 类型=${result.supports[0]?.kind}`);
  console.log("id\tx\ty\tdist²\tmargin\ttolerance margin\tcovered");
  for (const row of result.coverage) {
    console.log([
      row.id,
      row.x,
      row.y,
      format(row.distanceSquared),
      format(row.margin),
      format(row.toleranceAdjustedMargin),
      row.covered ? "yes" : "NO",
    ].join("\t"));
  }
  console.log("changes=" + result.changes.map((event) => event.id).join(","));
}

function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(12)).toString();
}

function demoPoints() {
  return [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 4, y: 0 },
    { id: 3, x: 0, y: 3 },
    { id: 4, x: 1, y: 1 },
  ];
}

function ensureDb(path = "data/mec.sqlite"): void {
  openDatabase(resolve(path));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "-h", "--help"].includes(command)) {
    console.log(`mec <command> [args]
  compute <points.json>            计算最小包围圆并输出覆盖余量表
  verify <points.json> --cx --cy --r 核验候选圆
  brute <points.json>              枚举基准（最多十个唯一点）
  import <points.json> [name]      导入 SQLite 并创建点集
  report <datasetId> [version]     查看持久化报告
  evidence <datasetId> [version]   查看支撑点计算解释
  add <datasetId> <points.json>    用完整新版本加入点
  delete <datasetId> <points.json> --ids 1,2 用完整新版本删除点
  export <datasetId> <out.json> [version]    导出报告
  demo                             内置演示`);
    return;
  }

  if (command === "demo") {
    const sets: Array<[string, ReturnType<typeof demoPoints>]> = [
      ["3-4-5 三角形", demoPoints()],
      ["锐角三角形", [{ id: 1, x: 0, y: 0 }, { id: 2, x: 4, y: 0 }, { id: 3, x: 2, y: 4 }]],
      ["共线点", [{ id: 1, x: -5, y: 1 }, { id: 2, x: 0, y: 1 }, { id: 3, x: 7, y: 1 }]],
      ["重复点", [{ id: 1, x: 2, y: 2 }, { id: 2, x: 2, y: 2 }, { id: 3, x: 5, y: 6 }]],
      ["全相同", [{ id: 1, x: -3, y: -3 }, { id: 2, x: -3, y: -3 }]],
      ["矩形四角", [{ id: 1, x: 0, y: 0 }, { id: 2, x: 6, y: 0 }, { id: 3, x: 6, y: 4 }, { id: 4, x: 0, y: 4 }]],
    ];
    for (const [name, points] of sets) {
      console.log(`\n=== ${name} ===`);
      printCoverage(minimumEnclosingCircle(points));
    }
    console.log(`\n算法版本: ${ALGORITHM_VERSION}`);
    return;
  }

  if (command === "compute") {
    const points = pointsFromInput(readInput(args[0] ?? fail("MISSING_ARGUMENT", "缺少 points.json")));
    printCoverage(minimumEnclosingCircle(points));
    return;
  }

  if (command === "brute") {
    const points = pointsFromInput(readInput(args[0] ?? fail("MISSING_ARGUMENT", "缺少 points.json")));
    const uniqueCount = new Set(points.map((p) => `${p.x}/${p.y}`)).size;
    if (uniqueCount > 10) fail("TOO_MANY_POINTS", "枚举基准仅限十个以内唯一点");
    const circle = enumerateMinimumCircle(points);
    console.log(JSON.stringify(circle, null, 2));
    return;
  }

  if (command === "verify") {
    const points = pointsFromInput(readInput(args[0] ?? fail("MISSING_ARGUMENT", "缺少 points.json")));
    const options = new Map(["--cx", "--cy", "--r"].map((name) => [name, optionValue(args.slice(1), name)]).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const candidate = {
      center: { x: Number(options.get("--cx")), y: Number(options.get("--cy")) },
      radius: Number(options.get("--r")),
    };
    if ([candidate.center.x, candidate.center.y, candidate.radius].some((value) => !Number.isFinite(value))) {
      fail("INVALID_CANDIDATE", "需要 --cx 数字 --cy 数字 --r 非负数");
    }
    const computed = minimumEnclosingCircle(points).circle?.radius ?? null;
    console.log(JSON.stringify(verifyCandidate(points, candidate, computed), null, 2));
    return;
  }

  ensureDb();
  if (command === "import") {
    const points = pointsFromInput(readInput(args[0] ?? fail("MISSING_ARGUMENT", "缺少 points.json")));
    console.log(JSON.stringify(serializeVersion(createDataset(args[1] ?? "CLI 导入", points)), null, 2));
    return;
  }
  if (command === "report" || command === "evidence" || command === "export") {
    const record = getVersion(args[0] ?? fail("MISSING_ARGUMENT", "缺少 datasetId"), args[1] && command !== "export" ? Number(args[1]) : command === "export" && args[2] ? Number(args[2]) : undefined);
    if (!record) fail("NOT_FOUND", "点集版本不存在");
    if (command === "evidence") {
      console.log(JSON.stringify({
        circle: record.result.circle,
        supports: record.result.supports,
        explanation: supportExplanation(record),
      }, null, 2));
      return;
    }
    const body = serializeVersion(record);
    if (command === "export") writeFileSync(args[1] ?? fail("MISSING_ARGUMENT", "缺少输出文件"), JSON.stringify(body, null, 2), "utf8");
    else console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (command === "add" || command === "delete") {
    const datasetId = args[0] ?? fail("MISSING_ARGUMENT", "缺少 datasetId");
    const current = getVersion(datasetId);
    if (!current) fail("NOT_FOUND", "点集不存在");
    let nextPoints = current.points;
    if (command === "add") {
      const additions = pointsFromInput(readInput(args[1]!));
      const existing = new Set(current.points.map((point) => point.id));
      if (additions.some((point) => existing.has(point.id))) fail("DUPLICATE_ID", "新增点 id 已存在");
      nextPoints = [...current.points, ...additions];
    } else {
      const idsValue = optionValue(args, "--ids") ?? fail("MISSING_ARGUMENT", "缺少 --ids 编号列表");
      const removed = new Set(idsValue.split(",").map((value) => Number(value)));
      if ([...removed].some((id) => !Number.isInteger(id) || id <= 0)) fail("INVALID_ID", "--ids 必须是正整数逗号列表");
      if (!args[1]) fail("MISSING_ARGUMENT", "缺少 points.json");
      const supplied = pointsFromInput(readInput(args[1]));
      if (JSON.stringify(supplied) !== JSON.stringify(current.points)) fail("SNAPSHOT_MISMATCH", "points.json 必须是当前版本完整快照");
      nextPoints = current.points.filter((point) => !removed.has(point.id));
    }
    const nextCheck = validatePoints(nextPoints);
    if (nextCheck.error) fail(nextCheck.error.error.code, nextCheck.error.error.message);
    if (nextCheck.points!.length > 300) fail("TOO_MANY_POINTS", "新版本点数不能超过 300");
    const record = addVersion(datasetId, nextPoints);
    if (!record) fail("NOT_FOUND", "点集不存在");
    console.log(JSON.stringify(serializeVersion(record), null, 2));
    return;
  }
  fail("UNKNOWN_COMMAND", `未知命令: ${command}`);
}

main().catch((error: unknown) => fail("INTERNAL_ERROR", error instanceof Error ? error.message : String(error)));
