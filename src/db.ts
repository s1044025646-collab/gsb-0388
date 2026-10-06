import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  ALGORITHM_VERSION,
  FLOATING_RELATIVE_EPSILON,
  INTEGER_COLLINEARITY_EPSILON,
  minimumEnclosingCircle,
  type InputPoint,
  type MinimumCircleResult,
} from "./geometry.js";

export interface VersionRecord {
  datasetId: string;
  version: number;
  points: InputPoint[];
  pointCount: number;
  inputHash: string;
  settings: {
    maxPoints: number;
    coordinateLimit: number;
    integerCollinearityEpsilon: number;
    floatingRelativeEpsilon: number;
  };
  algorithmVersion: string;
  result: MinimumCircleResult;
  createdAt: string;
}

export interface DatasetSummary {
  id: string;
  name: string;
  latestVersion: number;
  pointCount: number;
  createdAt: string;
  updatedAt: string;
}

let database: DatabaseSync | null = null;

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latest_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      points_json TEXT NOT NULL,
      point_count INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (dataset_id, version)
    );
  `);
  return database;
}

export function getDatabase(): DatabaseSync {
  if (!database) throw new Error("DATABASE_NOT_OPEN");
  return database;
}

export function closeDatabase(): void {
  database?.close();
  database = null;
}

function hashPoints(points: InputPoint[]): string {
  const canonical = points
    .map((point) => ({ id: point.id, x: point.x, y: point.y }))
    .sort((a, b) => a.id - b.id);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createDataset(name: string, points: InputPoint[]): VersionRecord {
  const db = getDatabase();
  const id = `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO datasets (id, name, latest_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(id, name, now, now);
  return insertVersion(id, 1, points, now);
}

export function addVersion(datasetId: string, points: InputPoint[]): VersionRecord | null {
  const db = getDatabase();
  const row = db.prepare("SELECT latest_version FROM datasets WHERE id = ?").get(datasetId) as
    | { latest_version: number }
    | undefined;
  if (!row) return null;
  const version = row.latest_version + 1;
  const now = new Date().toISOString();
  const record = insertVersion(datasetId, version, points, now);
  db.prepare("UPDATE datasets SET latest_version = ?, updated_at = ? WHERE id = ?")
    .run(version, now, datasetId);
  return record;
}

function insertVersion(datasetId: string, version: number, points: InputPoint[], createdAt: string): VersionRecord {
  const result = minimumEnclosingCircle(points);
  const settings = {
    maxPoints: 300,
    coordinateLimit: 1_000_000,
    integerCollinearityEpsilon: INTEGER_COLLINEARITY_EPSILON,
    floatingRelativeEpsilon: FLOATING_RELATIVE_EPSILON,
  };
  const record: VersionRecord = {
    datasetId,
    version,
    points,
    pointCount: points.length,
    inputHash: hashPoints(points),
    settings,
    algorithmVersion: ALGORITHM_VERSION,
    result,
    createdAt,
  };
  getDatabase()
    .prepare(`
      INSERT INTO versions
      (dataset_id, version, points_json, point_count, input_hash, settings_json, algorithm_version, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      datasetId,
      version,
      JSON.stringify(points),
      points.length,
      record.inputHash,
      JSON.stringify(settings),
      ALGORITHM_VERSION,
      JSON.stringify(result),
      createdAt,
    );
  return record;
}

export function getVersion(datasetId: string, version?: number): VersionRecord | null {
  const db = getDatabase();
  const row = version
    ? db.prepare("SELECT * FROM versions WHERE dataset_id = ? AND version = ?").get(datasetId, version)
    : db.prepare("SELECT * FROM versions WHERE dataset_id = ? ORDER BY version DESC LIMIT 1").get(datasetId);
  if (!row) return null;
  return hydrateVersion(row as Record<string, unknown>);
}

function hydrateVersion(row: Record<string, unknown>): VersionRecord {
  return {
    datasetId: row.dataset_id as string,
    version: row.version as number,
    points: JSON.parse(row.points_json as string) as InputPoint[],
    pointCount: row.point_count as number,
    inputHash: row.input_hash as string,
    settings: JSON.parse(row.settings_json as string) as VersionRecord["settings"],
    algorithmVersion: row.algorithm_version as string,
    result: JSON.parse(row.result_json as string) as MinimumCircleResult,
    createdAt: row.created_at as string,
  };
}

export function listDatasets(): DatasetSummary[] {
  return getDatabase()
    .prepare(`
      SELECT d.id, d.name, d.latest_version, d.created_at, d.updated_at, v.point_count
      FROM datasets d
      JOIN versions v ON v.dataset_id = d.id AND v.version = d.latest_version
      ORDER BY d.created_at DESC
    `)
    .all()
    .map((value) => {
      const row = value as Record<string, unknown>;
      return {
        id: row.id as string,
        name: row.name as string,
        latestVersion: row.latest_version as number,
        pointCount: row.point_count as number,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      };
    });
}

export function serializeVersion(record: VersionRecord) {
  return {
    datasetId: record.datasetId,
    version: record.version,
    pointCount: record.pointCount,
    inputHash: record.inputHash,
    points: record.points,
    settings: record.settings,
    algorithm: record.result.algorithm,
    tolerance: record.result.tolerance,
    circle: record.result.circle,
    supports: record.result.supports,
    coverage: record.result.coverage,
    changes: record.result.changes,
    duplicateGroups: record.result.duplicateGroups,
    createdAt: record.createdAt,
  };
}
