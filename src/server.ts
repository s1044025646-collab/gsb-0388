// HTTP API 服务（node:http，零外部依赖）。
import http from "node:http";
import { Store } from "./store.js";
import {
  ApiError,
  computeReport,
  validatePoints,
  verifyCandidate,
  MAX_POINTS,
  MAX_COORD,
} from "./service.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_INPUT", "请求体不是合法 JSON");
  }
}

function parseId(seg: string | undefined): number {
  const id = Number(seg);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError("INVALID_INPUT", "数据集 id 必须是正整数");
  }
  return id;
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const seg = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, limits: { maxPoints: MAX_POINTS, maxCoord: MAX_COORD } });
      }

      // POST /datasets {name?, points:[{id,x,y}]}
      if (method === "POST" && url.pathname === "/datasets") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const points = validatePoints(body.points);
        const name = typeof body.name === "string" && body.name ? body.name : "未命名";
        const id = store.createDataset(name, points, null, 1);
        return json(res, 201, { id, name, version: 1, pointCount: points.length });
      }

      if (method === "GET" && url.pathname === "/datasets") {
        return json(res, 200, store.listDatasets());
      }

      if (seg[0] === "datasets" && seg.length >= 2) {
        const id = parseId(seg[1]);
        const ds = store.mustGetDataset(id);
        const sub = seg[2];

        // GET /datasets/:id —— 输入摘要与快照
        if (method === "GET" && !sub) {
          return json(res, 200, { ...ds, points: store.getPoints(id) });
        }
        // GET /datasets/:id/export
        if (method === "GET" && sub === "export") {
          return json(res, 200, {
            dataset: ds,
            points: store.getPoints(id),
            report: store.getReport(id),
          });
        }
        // POST /datasets/:id/points {id,x,y} —— 增点，产生新版本
        if (method === "POST" && sub === "points") {
          const body = (await readBody(req)) as Record<string, unknown>;
          const current = store.getPoints(id);
          const added = validatePoints([body])[0];
          if (current.some((p) => p.id === added.id)) {
            throw new ApiError("INVALID_INPUT", `点编号已存在: ${added.id}`);
          }
          const next = validatePoints([...current, added]);
          const newId = store.createDataset(ds.name, next, id, ds.version + 1);
          return json(res, 201, { id: newId, version: ds.version + 1, pointCount: next.length });
        }
        // DELETE /datasets/:id/points/:inputId —— 删点，产生新版本
        if (method === "DELETE" && sub === "points" && seg[3]) {
          const current = store.getPoints(id);
          const target = decodeURIComponent(seg[3]);
          if (!current.some((p) => p.id === target)) {
            throw new ApiError("NOT_FOUND", `点 ${target} 不存在`, 404);
          }
          const next = current.filter((p) => p.id !== target);
          const newId = store.createDataset(ds.name, next, id, ds.version + 1);
          return json(res, 201, { id: newId, version: ds.version + 1, pointCount: next.length });
        }
        // POST /datasets/:id/mec —— 完整重算并保存报告
        if (method === "POST" && sub === "mec") {
          const points = store.getPoints(id);
          const report = computeReport(points); // 先算完再落库，失败不覆盖旧报告
          store.saveReport(id, report);
          return json(res, 200, report);
        }
        // GET /datasets/:id/report
        if (method === "GET" && sub === "report") {
          const report = store.getReport(id);
          if (!report) throw new ApiError("NOT_FOUND", "该数据集尚未计算报告", 404);
          return json(res, 200, report);
        }
        // GET /datasets/:id/support —— 边界支撑点与圆心计算过程
        if (method === "GET" && sub === "support") {
          const report = store.getReport(id);
          if (!report) throw new ApiError("NOT_FOUND", "该数据集尚未计算报告", 404);
          return json(res, 200, {
            support: report.support,
            explanation: report.supportExplanation,
          });
        }
        // POST /datasets/:id/verify {cx, cy, radius}
        if (method === "POST" && sub === "verify") {
          const body = (await readBody(req)) as Record<string, unknown>;
          const report = store.getReport(id);
          const result = verifyCandidate(
            store.getPoints(id),
            body.cx,
            body.cy,
            body.radius,
            report?.circle ? report.circle.radius : null
          );
          return json(res, 200, result);
        }
      }

      throw new ApiError("NOT_FOUND", `未知路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return json(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return json(res, 500, {
        error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) },
      });
    }
  });
}

// 直接运行：node dist/src/server.js [--port N]（默认 0 = 自动选择空闲端口）
if (process.argv[1]?.endsWith("server.js")) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
  const store = new Store();
  const server = createServer(store);
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    console.log(`MEC API 已启动: http://127.0.0.1:${actual}`);
  });
}
