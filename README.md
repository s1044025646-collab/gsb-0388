# 平面点集最小包围圆后端（API + CLI）

纯本地 Windows 可运行的最小包围圆（Minimum Enclosing Circle）服务：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生编译、无 Docker、无外部服务）。只做平面欧氏几何，不做三角剖分 / Voronoi / 地图坐标转换 / 三维包围球。

## 快速开始

```powershell
npm install        # 仅需开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm run demo       # 内置演示（直角/锐角三角形、共线点）
npm start          # 启动 API（默认自动选择空闲端口）
node dist/src/server.js --port 8080   # 指定端口
```

数据目录默认为项目内 `data/`（可用环境变量 `MEC_DATA_DIR` 覆盖），重启后报告与输入快照仍可读取。

## 规模与数值约定

- 点数上限 `MAX_POINTS = 300`，坐标为 `±1,000,000` 以内的整数（`src/service.ts` 顶部常量）。
- 共线判断：整数坐标下使用精确整数叉积（最大值约 4e12，远小于 2^53，双精度下精确）。
- 圆包含判断：统一相对容差 `EPS_CONTAIN = 1e-9`（`dist² <= r² + eps·max(1, r²)`），记录在每份报告的 `epsContain` 字段中以便复核。容差只用于消除浮点舍入，不能掩盖明显错误。
- 展示限量 `DISPLAY_LIMIT = 50`：CLI 覆盖余量表只显示前 50 行，但覆盖判定始终针对全部点。

## 算法

确定性增量算法（Welzl 思想，`src/geometry.ts`）：

1. 输入先按 `(x, y)` 稳定排序并按坐标去重（重复坐标保留全部来源编号，但不重复参与计算），因此输入顺序不影响几何答案。
2. 新点落在当前圆外时，递归重建“以该点为边界且包含全部已处理点”的圆：单点圆 → 两点直径圆 → 三点外接圆。
3. 三点共线时**不除以零**，改用三者中最远两点的直径圆。
4. 支撑点确定规则（公开、确定）：半径为 0 取字典序最小坐标；否则取字典序最小的、直径圆与最终圆一致的点对；再否则取字典序最小的、外接圆与最终圆一致的三元组。
5. 独立基准 `bruteForceMec`：枚举全部单点 / 直径圆 / 非共线三点外接圆，筛选覆盖全部点的最小者，供小点集（≤10）交叉验证。

## API

所有错误返回 `{"error":{"code","message"}}`，错误码：`INVALID_INPUT`、`NOT_FOUND`、`LIMIT_EXCEEDED`、`INTERNAL_ERROR`。失败请求不会覆盖已有的有效报告（先完整计算再落库，建库写入在事务内）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与规模限制 |
| POST | `/datasets` | 导入点集 `{name?, points:[{id,x,y}]}` |
| GET | `/datasets` / `/datasets/:id` | 列表 / 输入快照 |
| POST | `/datasets/:id/mec` | 完整重算最小包围圆并保存报告 |
| GET | `/datasets/:id/report` | 读取已保存报告 |
| GET | `/datasets/:id/support` | 边界支撑点与圆心计算过程解释 |
| POST | `/datasets/:id/verify` | 核验候选圆 `{cx, cy, radius}` |
| POST | `/datasets/:id/points` | 增点，创建新版本数据集 |
| DELETE | `/datasets/:id/points/:pid` | 删点，创建新版本数据集 |
| GET | `/datasets/:id/export` | 导出数据集、输入快照与报告 |

报告内容：圆心、半径、半径平方、支撑点及来源编号、每个点到圆心的平方距离与覆盖余量、促使圆发生变化的输入编号、容差与算法版本。候选核验返回未覆盖点列表；候选覆盖全部点不代表最小，若已有最优报告会同时返回 `radiusDiff`（候选半径 − 最优半径）。

增删点生成**新版本**数据集（`parentId` 指向前版本），旧版本与其报告保持原坐标不变。

## CLI

```powershell
node dist/src/cli.js import points.json myset   # 导入（JSON 数组或 {points:[...]}）
node dist/src/cli.js mec 1                      # 计算并保存报告（含覆盖余量表）
node dist/src/cli.js report 1                   # 查看已保存报告
node dist/src/cli.js evidence 1                 # 支撑点与圆心计算过程
node dist/src/cli.js verify 1 2 1.5 2.6         # 核验候选圆
node dist/src/cli.js add 1 d 100 100            # 增点 -> 新版本
node dist/src/cli.js remove 2 d                 # 删点 -> 新版本
node dist/src/cli.js export 1                   # 导出
node dist/src/cli.js list / show 1 / demo
```

## 测试

`npm test` 覆盖：演示三点圆 `(0,0),(4,0),(0,3)` → 圆心 `(2,1.5)` 半径 `2.5`；锐角三角形三支撑点；共线点仅两端决定；重复点与全相同；负坐标与矩形四角；内部点增删与远处新点；空点集与单点；200 组随机小点集与暴力枚举基准一致；平移、整数缩放、输入重排不变性与半径随加点单调不减。

## 已知限制

- 仅二维欧氏几何；坐标限定 ±1e6 整数、300 点（常量可调）。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 浮点结果为双精度；极端大坐标（接近 1e6 且点距极大）下容差按相对量处理。
