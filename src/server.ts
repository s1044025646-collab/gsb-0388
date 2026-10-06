import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCandidate, verifyCandidate } from "./candidate.js";
import {
  addVersion,
  createDataset,
  getDatabase,
  getVersion,
  listDatasets,
  openDatabase,
  serializeVersion,
} from "./db.js";
import { parseJson, validatePoints, type ApiError } from "./validation.js";
import { COORDINATE_LIMIT, MAX_POINTS } from "./geometry.js";

interface RouteContext {
  method: string;
  segments: string[];
  search: URLSearchParams;
  body: unknown;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

function sendError(response: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  const body: ApiError = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  send(response, status, body);
}

async function readBody(request: IncomingMessage): Promise<{ value?: unknown; status?: number; error?: ApiError }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) {
      return { status: 413, error: { error: { code: "PAYLOAD_TOO_LARGE", message: "请求体不能超过 2 MB" } } };
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return { value: {} };
  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

function bodyPoints(body: unknown) {
  const candidate = body as { points?: unknown };
  return validatePoints(candidate.points);
}

function route(ctx: RouteContext): { status: number; body: unknown } {
  const { method, segments } = ctx;
  if (method === "GET" && segments.length === 1 && segments[0] === "health") {
    return { status: 200, body: { ok: true, limits: { maxPoints: MAX_POINTS, coordinateLimit: COORDINATE_LIMIT } } };
  }
  if (method === "GET" && segments.length === 1 && segments[0] === "datasets") {
    return { status: 200, body: { datasets: listDatasets() } };
  }
  if (method === "POST" && segments.length === 1 && segments[0] === "datasets") {
    const checked = bodyPoints(ctx.body);
    if (checked.error) return { status: 400, body: checked.error };
    const name = typeof (ctx.body as { name?: unknown }).name === "string"
      ? ((ctx.body as { name: string }).name.slice(0, 100) || "未命名点集")
      : "未命名点集";
    return { status: 201, body: serializeVersion(createDataset(name, checked.points!)) };
  }

  if (segments[0] === "datasets" && segments[1]) {
    const datasetId = decodeURIComponent(segments[1]);
    const version = ctx.search.get("version") ? Number(ctx.search.get("version")) : undefined;
    if (method === "GET" && (segments.length === 2 || (segments.length === 3 && segments[2] === "report"))) {
      const record = getVersion(datasetId, version);
      if (!record) return { status: 404, body: { error: { code: "NOT_FOUND", message: "点集版本不存在" } } };
      return { status: 200, body: serializeVersion(record) };
    }
    if (method === "GET" && segments.length === 3 && segments[2] === "evidence") {
      const record = getVersion(datasetId, version);
      if (!record) return { status: 404, body: { error: { code: "NOT_FOUND", message: "点集版本不存在" } } };
      return { status: 200, body: {
        datasetId,
        version: record.version,
        circle: record.result.circle,
        supports: record.result.supports,
        explanation: supportExplanation(record),
      } };
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "versions") {
      const checked = bodyPoints(ctx.body);
      if (checked.error) return { status: 400, body: checked.error };
      const record = addVersion(datasetId, checked.points!);
      if (!record) return { status: 404, body: { error: { code: "NOT_FOUND", message: "点集不存在" } } };
      return { status: 201, body: serializeVersion(record) };
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "verify") {
      const record = getVersion(datasetId, version);
      if (!record) return { status: 404, body: { error: { code: "NOT_FOUND", message: "点集版本不存在" } } };
      const candidateBody = (ctx.body as { candidate?: unknown }).candidate;
      const checked = validateCandidate(candidateBody);
      if (checked.error) return { status: 400, body: { error: { code: "INVALID_CANDIDATE", message: checked.error } } };
      return {
        status: 200,
        body: verifyCandidate(record.points, checked.candidate!, record.result.circle?.radius ?? null),
      };
    }
  }

  return { status: 404, body: { error: { code: "ROUTE_NOT_FOUND", message: "接口不存在" } } };
}

export function supportExplanation(record: ReturnType<typeof getVersion>): unknown {
  if (!record) return null;
  const circle = record.result.circle;
  if (!circle) return { type: "empty", text: "空点集没有圆，也没有边界支撑点。" };
  const support = circle.support;
  if (support.length === 1) {
    const p = support[0]!;
    return {
      type: "single",
      text: `唯一位置是编号 ${p.id} (${p.x},${p.y})。圆退化为该点，圆心相同，半径与平方半径均为 0。`,
      centerFormula: { center: { x: p.x, y: p.y }, radiusSquared: 0 },
    };
  }
  if (support.length === 2) {
    const [a, b] = support;
    return {
      type: "diameter",
      text: `编号 ${a!.id} 与 ${b!.id} 是最远边界点，以两点连线为直径；圆心为坐标平均值，半径为两点距离的一半。共线三点退化时也选择能覆盖它们的最远两点。`,
      centerFormula: {
        x: `(${a!.x} + ${b!.x}) / 2 = ${circle.center.x}`,
        y: `(${a!.y} + ${b!.y}) / 2 = ${circle.center.y}`,
        radiusSquared: circle.radiusSquared,
      },
    };
  }
  const [a, b, c] = support;
  return {
    type: "circumcircle",
    text: `编号 ${a!.id}、${b!.id}、${c!.id} 非共线，圆为三点外接圆。算法用两个弦的等距条件求解圆心，再计算到任一支点的平方距离；叉积为零时不除以零，改走最远两点直径圆。`,
    linearEquations: [
      `2((${b!.x}-${a!.x})x + (${b!.y}-${a!.y})y) = ${b!.x ** 2 + b!.y ** 2 - a!.x ** 2 - a!.y ** 2}`,
      `2((${c!.x}-${a!.x})x + (${c!.y}-${a!.y})y) = ${c!.x ** 2 + c!.y ** 2 - a!.x ** 2 - a!.y ** 2}`,
    ],
    center: circle.center,
    radiusSquared: circle.radiusSquared,
  };
}

export function createApp(databasePath = resolve("data/mec.sqlite")): Server {
  openDatabase(databasePath);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const bodyResult = request.method === "POST" ? await readBody(request) : { value: {} };
      if (bodyResult.error) {
        send(response, bodyResult.status ?? 400, bodyResult.error);
        return;
      }
      const result = route({
        method: request.method ?? "GET",
        segments,
        search: url.searchParams,
        body: bodyResult.value,
      });
      send(response, result.status, result.body);
    } catch (error) {
      sendError(response, 500, "INTERNAL_ERROR", error instanceof Error ? error.message : "未知错误");
    }
  });
}

async function findFreePort(preferred?: number): Promise<number> {
  if (preferred) return preferred;
  const temporary = createServer();
  await new Promise<void>((resolveServer) => temporary.listen(0, "127.0.0.1", resolveServer));
  const address = temporary.address();
  if (!address || typeof address === "string") throw new Error("CANNOT_ALLOCATE_PORT");
  const port = address.port;
  await new Promise<void>((resolveServer) => temporary.close(() => resolveServer()));
  return port;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configuredPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = await findFreePort(configuredPort && Number.isInteger(configuredPort) ? configuredPort : undefined);
  const databasePath = process.env.MEC_DB ? resolve(process.env.MEC_DB) : resolve("data/mec.sqlite");
  createApp(databasePath).listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ status: "listening", url: `http://127.0.0.1:${port}`, databasePath }, null, 2));
  });
}

export { getDatabase };
