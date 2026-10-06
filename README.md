# 平面点集最小包围圆后端

这是一个只包含 API 与 CLI 的 Windows 本地后端，使用 TypeScript、Node.js 和 SQLite。给定带编号的二维整数点，它返回覆盖全部点的最小半径圆、一至三个边界支撑点、逐点覆盖余量、变更点、候选圆核验和可复核的版本化报告。

## 范围与限制

- 点数：最多 300 个输入点，计算与报告展示使用同一限制。
- 坐标：`id` 为正整数；`x`、`y` 为安全整数，绝对值不超过 1,000,000。
- 几何：仅平面欧氏几何；不做三角剖分、Voronoi、地图坐标转换或三维包围球。
- 重复坐标：保留所有来源编号，但计算时同一坐标只参与一次，支撑点选择最小来源编号。
- 空点集：返回没有圆；只有一个位置：半径为 0。
- 输入顺序不改变几何答案。内部先按 `(x,y,id)` 规范化，再使用算法版本中公开的固定种子 xorshift 排列。
- 支撑点等价选择规则：几何等价时报告规范排列中边界递归最先选中的点；返回前按编号升序展示。
- SQLite 文件默认在项目内 `data/mec.sqlite`，无需 Docker、WSL、外部在线 API 或付费服务。

## 数值容差

整数输入的共线判断使用精确叉积，容差为 `0`：

```text
cross = (b.x-a.x)(c.y-a.y) - (b.y-a.y)(c.x-a.x)
```

当 `cross = 0` 时三点共线，不进行外接圆除法，而在三对点中选择能覆盖三点的最远两点直径圆。

浮点圆的包含判断使用统一相对容差：

```text
distanceSquared <= radiusSquared + epsilon
epsilon = 1e-10 * max(1, |centerX|, |centerY|, radiusSquared)
```

报告同时输出原始覆盖余量 `radiusSquared - distanceSquared` 和加容差后的余量。容差仅用于吸收浮点舍入，不会主动扩大圆半径。

## 算法

实现位于 `src/geometry.ts`，算法版本为 `mec-welzl-deterministic-1`。

- 使用受限规模下的增量 Welzl 边界约束递归。
- 新点在当前圆外时，递归求包含已处理点并把新点作为必要边界的圆。
- 一个边界点：圆退化为点。
- 两个边界点：两点连线为直径圆。
- 三个边界点：非共线时求外接圆；共线时退化到最远两点直径圆。
- 不是重心加最远点，也不是只枚举相邻点或用固定初始三点凑覆盖圆。
- `mec brute` 对十个以内唯一点独立枚举全部单点、两点直径圆、非共线三点外接圆，作为测试基准。

## 环境准备

需要 Node.js 22.5 或更高版本；本项目在 Windows 上的 Node.js 25 验证。SQLite 使用 Node 内置 `node:sqlite`。

```powershell
npm install
npm run build
```

运行测试：

```powershell
npm test
```

启动服务（默认自动选择空闲端口）：

```powershell
npm start
```

指定端口和数据库：

```powershell
$env:PORT="3000"
$env:MEC_DB="data/custom.sqlite"
npm start
```

启动后会输出实际监听 URL，例如 `http://127.0.0.1:53124`。

## HTTP API

所有请求和响应均为 JSON。

### 健康检查

```http
GET /health
```

### 创建点集并计算

```http
POST /datasets
Content-Type: application/json

{
  "name": "demo",
  "points": [
    {"id": 1, "x": 0, "y": 0},
    {"id": 2, "x": 4, "y": 0},
    {"id": 3, "x": 0, "y": 3}
  ]
}
```

响应包含：`circle.center`、`circle.radius`、`circle.radiusSquared`、`supports`、全部点的 `coverage`、`changes`、重复坐标分组、容差、算法版本、输入哈希和时间。

### 列点集

```http
GET /datasets
```

### 查看报告

```http
GET /datasets/{datasetId}
GET /datasets/{datasetId}/report?version=1
```

旧版本的点坐标与浮点结果保存在 SQLite 中，新版本不会覆盖旧报告。

### 查看边界证据

```http
GET /datasets/{datasetId}/evidence?version=1
```

分别解释单点、两点直径和三点外接圆的圆心计算过程。

### 创建新版本

提交的是完整新点集，不是差量补丁：

```http
POST /datasets/{datasetId}/versions
Content-Type: application/json

{"points": [/* 完整点集 */]}
```

### 核验候选圆

```http
POST /datasets/{datasetId}/verify?version=1
Content-Type: application/json

{"candidate": {"center": {"x": 2, "y": 1.5}, "radius": 2.5}}
```

响应列出每个点的平方距离、覆盖余量、未覆盖编号；如果已计算最优半径，还会输出候选半径与最优半径的差值，并标记 `matches_optimum` 或 `not_optimal`。

## CLI

查看帮助：

```powershell
npm run cli -- help
```

内置演示：

```powershell
npm run demo
```

计算并打印覆盖余量表：

```powershell
npm run cli -- compute examples/demo.json
```

枚举基准（最多十个唯一点）：

```powershell
npm run cli -- brute examples/demo.json
```

核验候选圆：

```powershell
npm run cli -- verify examples/demo.json --cx 2 --cy 1.5 --r 2.5
```

导入 SQLite：

```powershell
npm run cli -- import examples/demo.json demo
```

查看、导出、新增和删除（把输出中的 `ds_xxx` 换成实际 ID）：

```powershell
npm run cli -- report ds_xxx
npm run cli -- evidence ds_xxx
npm run cli -- add ds_xxx additions.json
npm run cli -- delete ds_xxx current-snapshot.json --ids 4,5
npm run cli -- export ds_xxx report.json
```

删除时的 JSON 必须是当前版本完整快照，防止在过期坐标上误删；删除后会创建新版本。

## 错误码

- `INVALID_JSON`：请求体不是合法 JSON。
- `INVALID_POINTS` / `INVALID_POINT`：点集结构错误。
- `INVALID_INTEGER`：`id`、`x` 或 `y` 不是安全整数。
- `INVALID_ID`：编号不是正整数或删除参数错误。
- `DUPLICATE_ID`：输入编号重复。
- `COORDINATE_OUT_OF_RANGE`：坐标超出 ±1,000,000。
- `TOO_MANY_POINTS`：超过 300 点。
- `PAYLOAD_TOO_LARGE`：请求体超过 2 MB。
- `NOT_FOUND`：点集或版本不存在。
- `SNAPSHOT_MISMATCH`：删除操作的快照与当前版本不一致。
- `INVALID_CANDIDATE`：候选圆参数不合法。

失败请求会在校验阶段返回，不会插入版本，也不会覆盖已有有效报告。

## 开发说明

主要文件：

- `src/geometry.ts`：几何、容差、增量算法、枚举基准。
- `src/candidate.ts`：候选圆覆盖核验。
- `src/validation.ts`：输入校验和错误码。
- `src/db.ts`：SQLite 表、版本快照、输入哈希、结果持久化。
- `src/server.ts`：HTTP API。
- `src/cli.ts`：命令行。
- `test/`：几何性质、基准对比、API 与 SQLite 测试。

构建后运行时依赖只有 Node 内置模块；开发依赖包含 TypeScript、Node 类型和测试加载器。
