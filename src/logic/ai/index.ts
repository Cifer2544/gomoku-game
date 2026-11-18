/**
 * 五子棋 AI 引擎 - 高级版本
 * 基于 Alpha-Beta + PVS + 迭代加深 + VCF 算杀
 * 运行于浏览器环境，支持 15x15 无禁手五子棋
 */

// 类型定义统一来源于 logic/types，避免 AI 层与 UI 层出现两份同名契约
import type { Board, Player, Position } from '../types';

// ===================== 常量定义 =====================
const SIZE = 15;                    // 棋盘边长
const CELLS = SIZE * SIZE;          // 总格数 (225)
const EMPTY = 0;                    // 空位
const BLACK = 1;                    // 黑棋
const WHITE = 2;                    // 白棋
const MAX_TIME = 1200;              // 默认单步搜索时间预算 (ms)
export const AI_TIME_LIMIT_MS = MAX_TIME;
/** VCF 最多占用总预算的比例：对弈时预算被压到 100ms，算杀不能把整步吃掉 */
const VCF_TIME_RATIO = 0.4;
const VCF_TIME_LIMIT = 450;         // VCF 算杀时间上限 (ms)，还要受 timeLimit * ratio 约束
const VCF_NODE_LIMIT = 20000;       // VCF 节点上限，防止病态局面无限递归

// 四个方向偏移量: 横向(1), 纵向(15), 主对角线(16), 副对角线(14)
const DIRS = [1, 15, 16, 14];

// 棋型分值定义 (用于局面评估)
const S_FIVE = 10000000;            // 五连 (必胜)
const S_LIVE_FOUR = 1000000;        // 活四 (对手无法防守)
const S_RUSH_FOUR = 100000;         // 冲四 (对手必须防守)
const S_LIVE_THREE = 10000;         // 活三
const S_SLEEP_THREE = 1000;         // 眠三
const S_LIVE_TWO = 100;             // 活二
const S_SLEEP_TWO = 10;             // 眠二
const S_LIVE_ONE = 1;               // 活一

// 棋型类型 (用于优先级比较)
const T_DEAD = 0;
const T_SLEEP_TWO = 2;
const T_LIVE_TWO = 3;
const T_SLEEP_THREE = 4;
const T_LIVE_THREE = 5;
const T_RUSH_FOUR = 6;
const T_LIVE_FOUR = 7;
const T_FIVE = 8;

// ===================== 全局状态 =====================
let board: Int8Array;               // 一维棋盘 (0=空, 1=黑, 2=白)
let history: number[];              // 落子历史 (用于撤销)
let hash1: number;                  // Zobrist 哈希值 (高位)
let hash2: number;                  // Zobrist 哈希值 (低位)
let zTable1: Uint32Array;           // Zobrist 随机表 (高位)
let zTable2: Uint32Array;           // Zobrist 随机表 (低位)
let tt: Map<number, { d: number; s: number; f: number; m: number }>; // 置换表
let t0: number;                     // 搜索开始时间
let stop: boolean;                  // 超时标志
let lines: number[][];              // 预计算的扫描线
let inited = false;                 // 初始化标志
let vcfNodes = 0;                   // 本轮 VCF 已展开的节点数
let vcfAbort = false;               // 本轮 VCF 是否已耗尽时间/节点预算
/** 本次搜索实际使用的时限（毫秒）。由 getBestMove 的第三个参数覆盖，不改写默认值。 */
let timeLimit = MAX_TIME;
/** evalDir 的输出，避免每次调用都返回对象、产生堆分配 */
let lastP = T_DEAD;
let lastS = 0;
/** 9 格窗口缓冲区：0..3 负方向远→近，4 中心，5..8 正方向近→远 */
const simBuf = new Int8Array(9);

// ===================== 引擎初始化 =====================
/**
 * 初始化引擎: 生成 Zobrist 随机表, 预计算扫描线
 */
function init(): void {
  if (inited) return;
  board = new Int8Array(CELLS);
  zTable1 = new Uint32Array(CELLS * 2);
  zTable2 = new Uint32Array(CELLS * 2);
  
  // 填充 Zobrist 随机表 (每个格子对应黑/白两种状态)
  for (let i = 0; i < CELLS * 2; i++) {
    zTable1[i] = (Math.random() * 0xFFFFFFFF) >>> 0;
    zTable2[i] = (Math.random() * 0xFFFFFFFF) >>> 0;
  }
  
  tt = new Map();
  history = [];
  
  // 预计算扫描线: 横线, 竖线, 主对角线, 副对角线 (仅保留长度 >= 5 的线)
  lines = [];
  
  // 15 条横线
  for (let y = 0; y < SIZE; y++) {
    const line: number[] = [];
    for (let x = 0; x < SIZE; x++) line.push(y * SIZE + x);
    lines.push(line);
  }
  
  // 15 条竖线
  for (let x = 0; x < SIZE; x++) {
    const line: number[] = [];
    for (let y = 0; y < SIZE; y++) line.push(y * SIZE + x);
    lines.push(line);
  }
  
  // 主对角线 (左上到右下, 满足 x - y = 常数)
  for (let d = -(SIZE - 1); d <= SIZE - 1; d++) {
    const line: number[] = [];
    for (let y = 0; y < SIZE; y++) {
      const x = y + d;
      if (x >= 0 && x < SIZE) line.push(y * SIZE + x);
    }
    if (line.length >= 5) lines.push(line);
  }
  
  // 副对角线 (右上到左下, 满足 x + y = 常数)
  for (let s = 0; s <= 2 * (SIZE - 1); s++) {
    const line: number[] = [];
    for (let y = 0; y < SIZE; y++) {
      const x = s - y;
      if (x >= 0 && x < SIZE) line.push(y * SIZE + x);
    }
    if (line.length >= 5) lines.push(line);
  }
  
  inited = true;
}

// ===================== 棋盘操作 (增量更新, 严禁深拷贝) =====================
/**
 * 将 Vue 二维棋盘加载到一维引擎状态
 */
function load(b: Board): void {
  board.fill(EMPTY);
  hash1 = 0;
  hash2 = 0;
  history = [];
  
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = b[y][x];
      const idx = y * SIZE + x;
      if (c === 'black') {
        board[idx] = BLACK;
        hash1 ^= zTable1[idx * 2];
        hash2 ^= zTable2[idx * 2];
      } else if (c === 'white') {
        board[idx] = WHITE;
        hash1 ^= zTable1[idx * 2 + 1];
        hash2 ^= zTable2[idx * 2 + 1];
      }
    }
  }
}

/**
 * 落子 (增量更新哈希)
 */
function move(idx: number, color: number): void {
  board[idx] = color;
  const zIdx = idx * 2 + (color - 1);
  hash1 ^= zTable1[zIdx];
  hash2 ^= zTable2[zIdx];
  history.push(idx);
}

/**
 * 撤销最近一步 (XOR 逆操作)
 */
function undo(): void {
  const idx = history.pop()!;
  const color = board[idx];
  board[idx] = EMPTY;
  const zIdx = idx * 2 + (color - 1);
  hash1 ^= zTable1[zIdx];
  hash2 ^= zTable2[zIdx];
}

// ===================== 工具函数 =====================
/**
 * 检查从 idx 沿 off 方向移动 dir 步是否合法 (防止越界和跨行)
 */
function canP(idx: number, off: number, dir: 1 | -1): boolean {
  const next = idx + off * dir;
  if (next < 0 || next >= CELLS) return false;
  
  switch (off) {
    case 1: // 横向: 防止跨行
      return dir === 1 ? idx % SIZE !== SIZE - 1 : idx % SIZE !== 0;
    case 15: // 纵向: 无跨行问题
      return true;
    case 16: // 主对角线: 同时防止横向和纵向越界
      return dir === 1 ? idx % SIZE !== SIZE - 1 : idx % SIZE !== 0;
    case 14: // 副对角线
      return dir === 1 ? idx % SIZE !== 0 : idx % SIZE !== SIZE - 1;
  }
  return false;
}

/**
 * 获取对手棋子颜色
 */
function opp(c: number): number {
  return c === BLACK ? WHITE : BLACK;
}

// ===================== 精细化棋型评估 =====================
/**
 * 评估在 idx 位置沿 off 方向落子后形成的棋型
 * 支持连续棋型和跳型 (如 XX_XX, XXX_X 等)
 */
function evalDir(idx: number, off: number, myC: number, enC: number): void {
  let p = idx;

  // 负方向 4 格（越界视为敌方封堵）
  for (let i = 0; i < 4; i++) {
    if (canP(p, off, -1)) {
      p -= off;
      simBuf[3 - i] = board[p];
    } else {
      simBuf[3 - i] = enC;
    }
  }

  // 中心格（模拟在此落子）
  simBuf[4] = myC;

  // 正方向 4 格
  p = idx;
  for (let i = 0; i < 4; i++) {
    if (canP(p, off, 1)) {
      p += off;
      simBuf[5 + i] = board[p];
    } else {
      simBuf[5 + i] = enC;
    }
  }

  let bp = T_DEAD;  // 最佳棋型
  let bs = 0;       // 最佳分值

  // 检查所有包含中心格的 5 格窗口 (识别连续型和跳型)
  for (let start = 0; start <= 4; start++) {
    let mc = 0, ec = 0, blocked = false;

    for (let j = start; j < start + 5; j++) {
      const v = simBuf[j];
      if (v === myC) mc++;
      else if (v === EMPTY) ec++;
      else { blocked = true; break; }
    }

    if (blocked) continue; // 被敌方封堵, 无效

    if (mc === 5) { lastP = T_FIVE; lastS = S_FIVE; return; } // 五连

    if (mc === 4 && ec === 1) {
      // 冲四 (有一个成五点)
      if (T_RUSH_FOUR > bp) { bp = T_RUSH_FOUR; bs = S_RUSH_FOUR; }
    }

    if (mc === 3 && ec === 2 && T_LIVE_THREE > bp) { bp = T_LIVE_THREE; bs = S_LIVE_THREE; }
    if (mc === 3 && ec === 1 && T_SLEEP_THREE > bp) { bp = T_SLEEP_THREE; bs = S_SLEEP_THREE; }
    if (mc === 2 && ec === 3 && T_LIVE_TWO > bp) { bp = T_LIVE_TWO; bs = S_LIVE_TWO; }
    if (mc === 2 && ec === 2 && T_SLEEP_TWO > bp) { bp = T_SLEEP_TWO; bs = S_SLEEP_TWO; }
  }

  // 检查 6 格窗口以识别活四 (_XXXX_)
  for (let start = 0; start <= 3; start++) {
    let mc = 0, ec = 0, mf = -1, ml = -1, blocked = false;

    for (let j = 0; j < 6; j++) {
      const v = simBuf[start + j];
      if (v === myC) {
        mc++;
        if (mf === -1) mf = j;
        ml = j;
      } else if (v === EMPTY) {
        ec++;
      } else {
        blocked = true;
        break;
      }
    }

    // 活四条件: 4 子 + 2 空, 且棋子不在两端
    if (!blocked && mc === 4 && ec === 2 && mf > 0 && ml < 5 && T_LIVE_FOUR > bp) {
      bp = T_LIVE_FOUR;
      bs = S_LIVE_FOUR;
    }
  }

  lastP = bp;
  lastS = bs;
}

/**
 * 评估在 idx 落子对己方的总价值 (综合 4 个方向 + 组合棋型 + 位置加分)
 */
function evalMove(idx: number, myC: number, enC: number): number {
  let score = 0;
  let lf = 0, rf = 0, lt = 0; // 活四, 冲四, 活三计数

  // 评估四个方向
  for (let k = 0; k < 4; k++) {
    evalDir(idx, DIRS[k], myC, enC);
    score += lastS;
    if (lastP === T_LIVE_FOUR) lf++;
    else if (lastP === T_RUSH_FOUR) rf++;
    else if (lastP === T_LIVE_THREE) lt++;
  }

  // 组合棋型加分 (极其致命的威胁)
  if (lf >= 2) score += 500000;                 // 双活四 (必胜)
  if (lf >= 1 && rf >= 1) score += 300000;      // 活四 + 冲四
  if (rf >= 2) score += 200000;                 // 双冲四 (必胜)
  if (rf >= 1 && lt >= 1) score += 100000;      // 四三杀 (必胜)
  if (lt >= 2) score += 50000;                  // 双活三 (必胜)

  // 位置加分: 越靠近棋盘中心 (7,7) 分值越高
  const x = idx % SIZE;
  const y = (idx - x) / SIZE;
  const dist = Math.abs(x - 7) + Math.abs(y - 7);
  score += Math.max(0, 14 - dist);

  return score;
}

// ===================== 全局局面评估 =====================
/**
 * 评估一条扫描线的分值
 */
function evalLine(line: number[], myC: number): number {
  let score = 0;
  const len = line.length;
  
  // 5 格窗口扫描
  for (let i = 0; i <= len - 5; i++) {
    let mc = 0, ec = 0, blocked = false;
    
    for (let j = 0; j < 5; j++) {
      const v = board[line[i + j]];
      if (v === myC) mc++;
      else if (v === EMPTY) ec++;
      else { blocked = true; break; }
    }
    
    if (blocked) continue;
    
    if (mc === 5) score += S_FIVE;
    else if (mc === 4) score += S_RUSH_FOUR;
    else if (mc === 3) score += S_LIVE_THREE;
    else if (mc === 2) score += S_LIVE_TWO;
    else if (mc === 1) score += S_LIVE_ONE;
  }
  
  // 6 格窗口扫描 (修正活四分值)
  for (let i = 0; i <= len - 6; i++) {
    let mc = 0, ec = 0, mf = -1, ml = -1, blocked = false;
    
    for (let j = 0; j < 6; j++) {
      const v = board[line[i + j]];
      if (v === myC) {
        mc++;
        if (mf === -1) mf = j;
        ml = j;
      } else if (v === EMPTY) {
        ec++;
      } else {
        blocked = true;
        break;
      }
    }
    
    if (!blocked && mc === 4 && ec === 2 && mf > 0 && ml < 5) {
      score += S_LIVE_FOUR - S_RUSH_FOUR; // 修正: 减去之前误算的冲四分
    }
  }
  
  return score;
}

/**
 * 全局局面评估: 己方总分 - 敌方总分 * 1.15 (偏向防守反击)
 */
function evalBoard(myC: number, enC: number): number {
  let ms = 0, es = 0;
  
  for (const line of lines) {
    ms += evalLine(line, myC);
    es += evalLine(line, enC);
  }
  
  return ms - Math.floor(es * 1.15);
}

// ===================== 胜负判断 =====================
/**
 * 判断 idx 处的棋子是否已连成五（只看 idx 自己所在的四个方向）
 */
function winsAt(idx: number): boolean {
  const c = board[idx];
  if (c === EMPTY) return false;

  for (const off of DIRS) {
    let cnt = 1;

    // 正方向延伸
    let p = idx;
    while (canP(p, off, 1)) {
      p += off;
      if (board[p] === c) cnt++;
      else break;
    }

    // 负方向延伸
    p = idx;
    while (canP(p, off, -1)) {
      p -= off;
      if (board[p] === c) cnt++;
      else break;
    }

    if (cnt >= 5) return true;
  }

  return false;
}

/**
 * 检查最后一步是否形成五连 (高效: 仅检查最后落子点)
 */
function checkLastMoveWin(): boolean {
  if (history.length === 0) return false;
  return winsAt(history[history.length - 1]);
}

/**
 * 找出 c 方能一步成五的空点（无则 -1）
 * VCF 的前置校验：若防守方能直接成五，冲四链毫无意义
 */
function findFivePoint(c: number): number {
  for (let i = 0; i < CELLS; i++) {
    if (board[i] !== EMPTY) continue;
    board[i] = c;
    const win = winsAt(i);
    board[i] = EMPTY;
    if (win) return i;
  }
  return -1;
}

// ===================== 候选点生成与启发式排序 =====================
/**
 * 生成候选落子点 (仅考虑已有棋子周围 2 格内的空位)
 * 排序规则: 必赢点 > 必堵点 > 极高攻击分 > 极高防守分
 */
function genMoves(max: number, myC: number, enC: number): number[] {
  const cands: { i: number; s: number }[] = [];
  const seen = new Set<number>();
  const winMoves: number[] = [];     // 必赢点
  const blockMoves: number[] = [];   // 必堵点
  
  for (let i = 0; i < CELLS; i++) {
    if (board[i] !== EMPTY) {
      const x = i % SIZE;
      const y = Math.floor(i / SIZE);
      
      // 检查周围 2 格内的所有空位
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
            const ni = ny * SIZE + nx;
            
            if (board[ni] === EMPTY && !seen.has(ni)) {
              seen.add(ni);
              
              const myScore = evalMove(ni, myC, enC);
              const enScore = evalMove(ni, enC, myC);
              
              // 识别必赢点和必堵点
              if (myScore >= S_FIVE) {
                winMoves.push(ni);
              } else if (enScore >= S_LIVE_FOUR) {
                blockMoves.push(ni);
              }
              
              // 综合评分: 攻击分 + 防守分 * 1.1 (略偏防守)
              cands.push({ i: ni, s: myScore + enScore * 1.1 });
            }
          }
        }
      }
    }
  }
  
  // 必赢点优先
  if (winMoves.length > 0) return winMoves;
  
  // 必堵点其次
  if (blockMoves.length > 0) {
    const rest = cands.filter(c => !blockMoves.includes(c.i));
    rest.sort((a, b) => b.s - a.s);
    return [...blockMoves, ...rest.slice(0, max - blockMoves.length).map(c => c.i)];
  }
  
  // 空棋盘或无候选点: 下中心
  if (cands.length === 0) {
    for (let i = 0; i < CELLS; i++) {
      if (board[i] === EMPTY) return [i];
    }
    return [];
  }
  
  // 按综合评分降序排序
  cands.sort((a, b) => b.s - a.s);
  return cands.slice(0, max).map(c => c.i);
}

// ===================== VCF 算杀引擎 (连续冲四胜) =====================
/**
 * 查找冲四的防守点 (即能阻止五连的唯一空位)
 */
function findBlock(idx: number, off: number, c: number): number {
  const y = Math.floor(idx / SIZE);
  const x = idx % SIZE;
  
  // 检查所有包含 idx 的 5 格窗口
  for (let start = -4; start <= 0; start++) {
    const base = idx + start * off;
    let mc = 0, ec = 0, ep = -1, valid = true;
    
    for (let i = 0; i < 5; i++) {
      const pos = base + i * off;
      if (pos < 0 || pos >= CELLS) { valid = false; break; }
      
      // 验证是否在同一条线上
      if (off === 1 && Math.floor(pos / SIZE) !== y) { valid = false; break; }
      if (off === 16 && (pos % SIZE - Math.floor(pos / SIZE)) !== (x - y)) { valid = false; break; }
      if (off === 14 && (pos % SIZE + Math.floor(pos / SIZE)) !== (x + y)) { valid = false; break; }
      
      const v = board[pos];
      if (v === c) mc++;
      else if (v === EMPTY) { ec++; ep = pos; }
      else { valid = false; break; }
    }
    
    // 冲四: 4 子 + 1 空
    if (valid && mc === 4 && ec === 1 && ep !== -1) {
      return ep;
    }
  }
  
  return -1;
}

/**
 * VCF (Victory by Continuous Fours) 搜索
 * 只搜索能形成冲四或活四的落子点, 深度可达 15+
 * @returns 获胜的第一步, 或 -1 (无杀)
 */
function vcf(c: number, d: number): number {
  if (vcfAbort || stop || d <= 0) return -1;

  // 预算控制: VCF 必须自带上限，否则病态局面会把整个搜索预算吃光
  if (++vcfNodes > VCF_NODE_LIMIT || performance.now() - t0 > Math.min(VCF_TIME_LIMIT, timeLimit * VCF_TIME_RATIO)) {
    vcfAbort = true;
    return -1;
  }

  // 防守方已能一步成五: 冲四链来不及，这不是杀棋而是自杀
  if (findFivePoint(opp(c)) >= 0) return -1;

  // 生成所有能形成五连/冲四/活四的候选点，并按威胁大小降序：
  // 先试一步成五的点，再试活四、多向冲四，避免绕远路（多走一步 = 多一次变数）
  const cands: { i: number; s: number }[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (board[i] !== EMPTY) continue;

    let s = 0;
    for (const off of DIRS) {
      evalDir(i, off, c, opp(c));
      if (lastP === T_FIVE) s += 100;          // 一步成五，最高优先
      else if (lastP === T_LIVE_FOUR) s += 10; // 活四，对手无法防
      else if (lastP === T_RUSH_FOUR) s += 1;  // 冲四，多向叠加更快成杀
    }
    if (s > 0) cands.push({ i, s });
  }
  cands.sort((x, y) => y.s - x.s);
  const moves = cands.map(v => v.i);

  for (const m of moves) {
    if (vcfAbort) return -1;
    move(m, c);

    // 直接成五获胜
    if (checkLastMoveWin()) {
      undo();
      return m;
    }

    // 统计形成的活四和冲四数量
    let lf = 0, rf = 0;
    for (const off of DIRS) {
      evalDir(m, off, c, opp(c));
      if (lastP === T_LIVE_FOUR) lf++;
      else if (lastP === T_RUSH_FOUR) rf++;
    }

    // 活四或双冲四: 对手无法防守, 必胜
    if (lf >= 1 || rf >= 2) {
      undo();
      return m;
    }

    // 查找所有防守点
    const blocks: number[] = [];
    for (const off of DIRS) {
      evalDir(m, off, c, opp(c));
      if (lastP === T_RUSH_FOUR) {
        const b = findBlock(m, off, c);
        if (b !== -1 && board[b] === EMPTY && !blocks.includes(b)) {
          blocks.push(b);
        }
      }
    }
    
    // 多个防守点: 对手只能堵一个, 必胜
    if (blocks.length > 1) {
      undo();
      return m;
    }
    
    // 唯一防守点: 对手被迫堵截, 继续递归搜索
    if (blocks.length === 1) {
      move(blocks[0], opp(c));
      const result = vcf(c, d - 2); // 深度 -2 (双方各走一步)
      undo();
      undo();
      
      if (result !== -1) return m;
    } else {
      undo();
    }
  }
  
  return -1; // 未找到 VCF
}

// ===================== PVS 高级搜索 =====================
/**
 * Principal Variation Search (主变例搜索)
 * 相比普通 Alpha-Beta 更高效, 假设第一个候选点是最佳点
 */
function pvs(a: number, b: number, d: number, c: number, max: number): number {
  // 超时检测
  if (stop || performance.now() - t0 > timeLimit) {
    stop = true;
    return 0;
  }
  
  // 终局检测
  if (checkLastMoveWin()) {
    // 最后一步是对手走的, 对手赢了
    return -S_FIVE - d;
  }
  if (d <= 0) return evalBoard(c, opp(c));
  
  // 置换表查询
  const h = (hash1 << 16) ^ hash2;
  const entry = tt.get(h);
  if (entry && entry.d >= d) {
    if (entry.f === 0) return entry.s;           // 精确值
    if (entry.f === 1 && entry.s >= b) return entry.s; // 下界截断
    if (entry.f === 2 && entry.s <= a) return entry.s; // 上界截断
  }
  
  const origAlpha = a;
  let bestScore = -Infinity;
  let bestMove = -1;
  
  // 候选点动态收窄: 随深度递减
  const moves = genMoves(max, c, opp(c));
  if (moves.length === 0) return evalBoard(c, opp(c));

  // 置换表给出的最佳着法优先尝试（即使深度不够也可用作排序参考）
  if (entry && entry.m >= 0) {
    const pos = moves.indexOf(entry.m);
    if (pos > 0) {
      moves.splice(pos, 1);
      moves.unshift(entry.m);
    }
  }

  // 首个候选点: 全窗口搜索 (假设其为最佳点)
  move(moves[0], c);
  let score = -pvs(-b, -a, d - 1, opp(c), Math.max(6, max - 2));
  undo();
  
  bestScore = score;
  bestMove = moves[0];
  a = Math.max(a, bestScore);
  
  // 后续候选点: 零窗口搜索 + 可能的重搜
  for (let i = 1; i < moves.length; i++) {
    if (stop) break;
    
    move(moves[i], c);
    
    // 零窗口搜索 (窗口宽度为 1)
    score = -pvs(-a - 1, -a, d - 1, opp(c), Math.max(6, max - 2));
    
    // 如果零窗口搜索表明该点可能优于当前最佳, 重新全窗口搜索
    if (score > a && score < b) {
      score = -pvs(-b, -score, d - 1, opp(c), Math.max(6, max - 2));
    }
    
    undo();
    
    if (score > bestScore) {
      bestScore = score;
      bestMove = moves[i];
    }
    
    a = Math.max(a, bestScore);
    if (a >= b) break; // Beta 截断
  }
  
  // 搜索被中断，分数不完整，不写入置换表以免污染后续搜索
  if (stop) return bestScore;

  // 更新置换表
  let flag = 0; // 0=精确值, 1=下界, 2=上界
  if (bestScore <= origAlpha) flag = 2;
  else if (bestScore >= b) flag = 1;
  tt.set(h, { d, s: bestScore, f: flag, m: bestMove });
  
  return bestScore;
}

// ===================== 主入口函数 =====================
/**
 * 获取 AI 最佳落子点
 * 流程: VCF 算杀 -> 对手 VCF 防御 -> 迭代加深 PVS 搜索
 *
 * @param b            当前棋盘
 * @param aiPlayer     AI 执子颜色
 * @param timeLimitMs  本步时间预算（毫秒）；省略时使用 AI_TIME_LIMIT_MS。
 *                     自动对弈等场景传入更小的值，避免每步都占满一秒。
 */
export function getBestMove(
  b: Board,
  aiPlayer: Player,
  timeLimitMs: number = MAX_TIME,
): Position {
  init();
  load(b);

  // 下限 20ms：过小的预算会让迭代加深连深度 2 都跑不完，反而更差
  timeLimit = Math.max(20, timeLimitMs);
  
  const aiC = aiPlayer === 'black' ? BLACK : WHITE;
  const enC = opp(aiC);
  
  // 统计棋盘已有棋子数
  let pieceCount = 0;
  for (let i = 0; i < CELLS; i++) {
    if (board[i] !== EMPTY) pieceCount++;
  }
  
  // 空棋盘: 下中心 (天元)
  if (pieceCount === 0) return { x: 7, y: 7 };
  
  // 初始化搜索状态
  t0 = performance.now();
  stop = false;
  vcfNodes = 0;
  vcfAbort = false;
  tt.clear();
  
  let bestMove = -1;
  let bestScore = -Infinity;
  
  // 1. 己方 VCF 检查 (深度 14 层, 秒杀能力)
  const vcfMove = vcf(aiC, 14);
  if (vcfMove >= 0) {
    return { x: vcfMove % SIZE, y: Math.floor(vcfMove / SIZE) };
  }
  
  // 2. 对手 VCF 威胁检查 (绝对防御)
  const oppVcfMove = vcf(enC, 14);
  if (oppVcfMove >= 0) {
    // 对手有 VCF, 必须找到防守点
    // 简化处理: 在对手 VCF 路线上找最佳防守点
    const blockMoves = genMoves(16, aiC, enC);
    for (const m of blockMoves) {
      const enScore = evalMove(m, enC, aiC);
      if (enScore >= S_RUSH_FOUR) {
        return { x: m % SIZE, y: Math.floor(m / SIZE) };
      }
    }
    // 若无法精确防守, 返回评分最高的点
    if (blockMoves.length > 0) {
      return { x: blockMoves[0] % SIZE, y: Math.floor(blockMoves[0] / SIZE) };
    }
  }
  
  // 3. 迭代加深 PVS 搜索 (深度 2 到 10)
  for (let depth = 2; depth <= 10; depth += 2) {
    const moves = genMoves(16, aiC, enC);
    if (moves.length === 0) break;
    
    bestMove = moves[0];
    bestScore = -Infinity;
    
    for (const m of moves) {
      if (stop) break;
      
      move(m, aiC);
      const score = -pvs(-Infinity, Infinity, depth - 1, enC, 12);
      undo();
      
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }
    
    // 超时则使用上一层结果
    if (stop) break;
  }
  
  // 兜底: 棋盘已满或未找到着法时返回第一个空位（调用方需先判游戏结束）
  if (bestMove === -1) {
    for (let i = 0; i < CELLS; i++) {
      if (board[i] === EMPTY) {
        bestMove = i;
        break;
      }
    }
  }
  
  return { x: bestMove % SIZE, y: Math.floor(bestMove / SIZE) };
}
