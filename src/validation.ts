import { COORDINATE_LIMIT, MAX_POINTS, type InputPoint } from "./geometry.js";

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function validatePoints(value: unknown): { points?: InputPoint[]; error?: ApiError } {
  if (!Array.isArray(value)) {
    return { error: { error: { code: "INVALID_POINTS", message: "points 必须是数组" } } };
  }
  if (value.length === 0) return { points: [] };
  if (value.length > MAX_POINTS) {
    return {
      error: {
        error: {
          code: "TOO_MANY_POINTS",
          message: `点数上限为 ${MAX_POINTS}`,
          details: { limit: MAX_POINTS, actual: value.length },
        },
      },
    };
  }
  const points: InputPoint[] = [];
  const ids = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") {
      return { error: { error: { code: "INVALID_POINT", message: `第 ${index} 项必须是对象`, details: { index } } } };
    }
    for (const key of ["id", "x", "y"]) {
      if (!isInteger(item[key])) {
        return {
          error: {
            error: {
              code: "INVALID_INTEGER",
              message: `第 ${index} 项的 ${key} 必须是安全整数`,
              details: { index, key },
            },
          },
        };
      }
    }
    const point = { id: item.id as number, x: item.x as number, y: item.y as number };
    if (point.id <= 0) {
      return { error: { error: { code: "INVALID_ID", message: "id 必须为正整数", details: { index } } } };
    }
    if (ids.has(point.id)) {
      return { error: { error: { code: "DUPLICATE_ID", message: `id ${point.id} 重复`, details: { id: point.id } } } };
    }
    if (Math.abs(point.x) > COORDINATE_LIMIT || Math.abs(point.y) > COORDINATE_LIMIT) {
      return {
        error: {
          error: {
            code: "COORDINATE_OUT_OF_RANGE",
            message: `坐标绝对值不能超过 ${COORDINATE_LIMIT}`,
            details: { id: point.id, limit: COORDINATE_LIMIT },
          },
        },
      };
    }
    ids.add(point.id);
    points.push(point);
  }
  return { points };
}

export function parseJson(text: string): { value?: unknown; error?: ApiError } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: { error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } } };
  }
}
