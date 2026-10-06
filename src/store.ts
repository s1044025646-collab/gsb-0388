// SQLite 持久化：数据集版本、输入快照、数值设置、算法版本与报告。
// 使用 Node 内置 node:sqlite，无原生编译依赖。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALGO_VERSION, EPS_CONTAIN } from "./geometry.js";
import { InputPoint, MecReport, ApiError } from "./service.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.MEC_DATA_DIR ?? path.join(PROJECT_ROOT, "data");

export interface DatasetRow {
  id: number;
  name: string;
  version: number;
  parentId: number | null;
  createdAt: string;
  algoVersion: string;
  epsContain: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbFile?: string) {
    mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(dbFile ?? path.join(DATA_DIR, "mec.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_id INTEGER,
        created_at TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        eps_contain REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS points (
        dataset_id INTEGER NOT NULL,
        input_id TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (dataset_id, input_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        dataset_id INTEGER PRIMARY KEY,
        computed_at TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        eps_contain REAL NOT NULL,
        report_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createDataset(name: string, points: InputPoint[], parentId: number | null, version: number): number {
    // 事务：任一失败不产生半截数据，更不会覆盖已有报告
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare(
          "INSERT INTO datasets (name, version, parent_id, created_at, algo_version, eps_contain) VALUES (?,?,?,?,?,?)"
        )
        .run(name, version, parentId, new Date().toISOString(), ALGO_VERSION, EPS_CONTAIN);
      const id = Number(res.lastInsertRowid);
      const stmt = this.db.prepare(
        "INSERT INTO points (dataset_id, input_id, x, y, position) VALUES (?,?,?,?,?)"
      );
      points.forEach((p, i) => stmt.run(id, p.id, p.x, p.y, i));
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getDataset(id: number): DatasetRow | null {
    const row = this.db
      .prepare(
        "SELECT id, name, version, parent_id AS parentId, created_at AS createdAt, algo_version AS algoVersion, eps_contain AS epsContain FROM datasets WHERE id = ?"
      )
      .get(id) as DatasetRow | undefined;
    return row ?? null;
  }

  mustGetDataset(id: number): DatasetRow {
    const row = this.getDataset(id);
    if (!row) throw new ApiError("NOT_FOUND", `数据集 ${id} 不存在`, 404);
    return row;
  }

  listDatasets(): DatasetRow[] {
    return this.db
      .prepare(
        "SELECT id, name, version, parent_id AS parentId, created_at AS createdAt, algo_version AS algoVersion, eps_contain AS epsContain FROM datasets ORDER BY id"
      )
      .all() as unknown as DatasetRow[];
  }

  getPoints(datasetId: number): InputPoint[] {
    const rows = this.db
      .prepare("SELECT input_id AS id, x, y FROM points WHERE dataset_id = ? ORDER BY position")
      .all(datasetId) as unknown as InputPoint[];
    return rows;
  }

  saveReport(datasetId: number, report: MecReport): void {
    this.db
      .prepare(
        "INSERT INTO reports (dataset_id, computed_at, algo_version, eps_contain, report_json) VALUES (?,?,?,?,?) ON CONFLICT(dataset_id) DO UPDATE SET computed_at=excluded.computed_at, algo_version=excluded.algo_version, eps_contain=excluded.eps_contain, report_json=excluded.report_json"
      )
      .run(datasetId, new Date().toISOString(), report.algoVersion, report.epsContain, JSON.stringify(report));
  }

  getReport(datasetId: number): MecReport | null {
    const row = this.db
      .prepare("SELECT report_json AS j FROM reports WHERE dataset_id = ?")
      .get(datasetId) as { j: string } | undefined;
    return row ? (JSON.parse(row.j) as MecReport) : null;
  }
}
