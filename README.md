# 五子棋游戏

[🎮 在线试玩](https://cifer2544.github.io/gomoku-game/)

## 项目简介

使用 Vue 3 + TypeScript + Vite 开发的网页版五子棋：15 × 15 交叉点棋盘，支持双人对战、人机对战、悔棋，以及两个 AI 引擎自动对弈的「AI 竞技场」。纯前端实现，无后端依赖，手机可通过局域网访问。

## 功能特性

### 玩家对战

- 双人 / 人机切换，默认人机；黑棋先手，人机模式下玩家固定执黑、AI 执白。
- 鼠标悬停显示幽灵棋子预览，触屏自动忽略，不会出现"粘屏"。
- 最近一手红点标记；状态栏实时显示回合与手数，AI 计算期间锁定棋盘。
- 连成 5 子获胜，225 个交叉点全部填满判平，结束后弹出结算浮层。

### 悔棋

- 双人模式每次撤 1 手；人机模式按历史末手的颜色判断——末手是玩家下的撤 1 手，是 AI 回应的则连同它一起撤 2 手。
- 棋盘为空或对局已结束时按钮禁用；AI 思考中悔棋会先作废该次计算，避免棋子"自己落回来"。

### AI 引擎

| 文件 | 实现 |
| --- | --- |
| `logic/ai/index.ts` | 高级引擎：扫描线预计算 + 窗口棋型评估、PVS 迭代加深（深度 2 → 10）、双 32 位 Zobrist 置换表、VCF 算杀（深度 14，节点上限 20000）。单步预算 1200ms，超时沿用上一层结果。 |
| `logic/ai/simpleEngine.ts` | 极简引擎：单点棋型评估 + 固定深度 4 的 alpha-beta，无置换表、迭代加深与算杀，作为竞技场对照组。 |
| `logic/ai/qoderEngine.ts` | 薄封装：复用高级引擎，把竞技场的单步预算压到 200ms。 |

### AI 竞技场

- 两个引擎自动对弈，按已完成局数的奇偶交替先手，避免固定一方执黑导致统计偏移。
- 单局上限 120 手，到上限未分胜负直接判平（玩家对战没有这条限制，只在棋盘填满时判平）。
- 胜率 = 该方胜场 ÷（总场次 − 平局数），平局不计入分母。
- 统计写入 `localStorage`（键名 `gomoku_ai_battle_stats`）；支持中途停止与清空统计，切到其他标签页会自动停止，不在后台空转 CPU。

### 界面与适配

- 暗色冷调主题：深蓝星空背景（独立伪元素图层 + 2px 模糊）、玻璃拟态面板、深蓝灰石板质感棋盘。
- 功能栏左侧对局信息、右侧操作按钮，面板与棋盘等宽；窄屏折成两行居中，任何尺寸都不横向溢出。

## 技术栈

Vue 3.5（`<script setup>` 单文件组件）、TypeScript 6.0、Vite 8.3、vue-tsc 3.3。

Node 需满足 Vite 8 的要求：`^20.19.0` 或 `≥ 22.12.0`（开发环境为 v26.13.0）。除 Vue 外没有运行时依赖，也不需要后端服务。

## 目录结构

```text
.github/workflows/deploy.yml  # CI：推送 main 后自动构建并发布 GitHub Pages
index.html                    # 页面入口：挂载点与站点图标
package.json                  # 依赖清单与 npm 脚本
tsconfig.json                 # TS 根配置：引用 app / node 两个子项目
tsconfig.app.json             # 应用代码（src/）的编译配置
tsconfig.node.json            # vite.config.ts 的编译配置
vite.config.ts                # Vite 配置：Pages 子路径 base、局域网访问
public/favicon.svg            # 站点图标
src/
├── main.ts                   # 应用入口：创建并挂载 App
├── App.vue                   # 页面外壳：标题、标签页、视图切换
├── style.css                 # 全局样式与全站背景图层
├── assets/
│   └── background.webp       # 星空背景图
├── components/
│   ├── boardLayout.ts        # 两个棋盘组件共用的索引与星位常量
│   ├── GameBoard.vue         # 玩家对战：棋盘、对局状态、悔棋、AI 回合调度
│   └── AiBattle.vue          # AI 竞技场：自动对弈、记分板、统计持久化
└── logic/
    ├── types.ts              # 类型契约：Player / CellState / Position / Board
    ├── rules.ts              # 棋盘创建、坐标校验、胜负判定
    └── ai/
        ├── index.ts          # 高级引擎：评估 + PVS + 迭代加深 + VCF
        ├── simpleEngine.ts   # 极简引擎：对照用
        └── qoderEngine.ts    # 竞技场适配层
```

只列主要文件，`.gitignore`、`.vscode/`、`package-lock.json` 等辅助文件未列入。

三层职责：`logic/` 是纯逻辑，不 import Vue、不碰 DOM，可脱离浏览器运行；`components/` 只做状态、交互与渲染，规则调用 `rules.ts`、落子决策调用 `logic/ai`；两个棋盘共用的索引与星位常量集中在 `components/boardLayout.ts`，只存一份。

## 快速开始

```bash
npm install      # 安装依赖
npm run dev      # 开发服务器，默认 http://localhost:5173
npm run build    # vue-tsc 类型检查 + 打包到 dist/
npm run preview  # 预览构建产物，地址 http://localhost:4173/gomoku-game/
```

推送到 `main` 分支后，GitHub Actions 会自动构建并部署到 GitHub Pages，无需手动执行任何部署命令（工作流见 `.github/workflows/deploy.yml`）。

`vite.config.ts` 已为 dev 与 preview 开启 `host: true`：手机与电脑连接同一 Wi-Fi 后，打开终端 `Network` 一行打印的地址即可访问（需防火墙放行 Node.js，Windows 勾选「专用网络」）。

## 规则与实现说明

- 常量定义在 `src/logic/rules.ts`：`BOARD_SIZE = 15`（共 225 个交叉点）、`WIN_COUNT = 5`。
- 获胜判定只围绕本次落子点做双向延伸计数：横、竖、主对角、副对角四个方向各向两侧统计同色连续棋子，加上落子点本身达到 5 即获胜。新增一颗棋子只可能产生包含它的连线，因此单次判定最多 4 × 8 次比较，与棋盘规模无关。
- 无禁手规则，也没有计时器、音效、联机对战等功能。
