#!/usr/bin/env node
/**
 * cf-byoip-sync.js — 合并版：下载源清单 + 本地锁月处理 + 有变化就推送到 AxisNow 调度（默认推送）
 *
 * 配置方式（.env，只放令牌；域名已写在脚本里面，不用配置）:
 *   在脚本同目录创建 .env，内容（令牌编号：移动1/4、联通2/5、电信3/6）:
 *     TOKEN_1=令牌1
 *     TOKEN_4=令牌4
 *     TOKEN_2=令牌2
 *     TOKEN_5=令牌5
 *     TOKEN_3=令牌3
 *     TOKEN_6=令牌6
 *   系统环境变量同样可用（GitHub Actions Secrets 就是走这个），且优先于 .env。
 *
 * 流程:
 *   0) 下载: 默认先从 SOURCE_URL 拉取最新 ipv4.txt（--no-download 跳过；
 *            下载失败且有本地文件时会用本地继续）
 *   1) 处理: 月内锁定第4段, 只跟随 /24 增删; 自然月切换时全量刷新(换最后一位)
 *   2) 判断: 与“上次成功推送的清单”对比
 *        - 有 增加/移除/恢复（完整 IP 有增减）  -> 推送
 *        - 源里最后一位变了但沿用原锁定(没变化) -> 不推送
 *        - 月度刷新换了最后一位(列表有变化)     -> 推送
 *        - 首次运行(没有推送记录)               -> 推送一次
 *   3) 推送: 每令牌 2 个域名各拿一段(50/组, 空段填 2 条), 只改默认规则地址池
 *
 * 用法:
 *   node cf-byoip-sync.js               # 默认：下载最新清单 -> 处理 -> 有变化就真正推送
 *   node cf-byoip-sync.js --no-download # 跳过下载，直接用本地 ipv4.txt
 *   node cf-byoip-sync.js --dry-run     # 只预览，不写入
 *   node cf-byoip-sync.js --force-push  # 忽略“无变化”，强制推一次
 *   node cf-byoip-sync.js --no-push     # 只做本地处理，不推送
 *   node cf-byoip-sync.js --refresh     # 强制全量刷新（手动换一次最后一位）
 *   node cf-byoip-sync.js --slot=1      # 只推某个令牌（测试用；不记录推送状态）
 *   node cf-byoip-sync.js --discover=1  # 查域名/规则（填配置用）
 *   node cf-byoip-sync.js --tokens      # 打印各令牌的长度+指纹（排查认证问题用）
 *
 * 依赖: Node 18+
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;

// ======================= 配置区（先改这里） =======================

const CONFIG = {
  API_BASE: 'https://api.axisnow.io/client/v1',

  // 下载（默认每次运行先更新源清单；加 --no-download 跳过）
  // 支持 raw 地址，也支持直接粘贴 github.com/.../blob/... 链接（会自动转换）
  SOURCE_URL: 'https://raw.githubusercontent.com/yuzhuc/cf-byoip/main/ipv4.txt',
  DOWNLOAD_TIMEOUT_MS: 30000,

  // 文件（默认与脚本同目录）
  SOURCE_FILE: 'ipv4.txt',         // 下载保存到这里的源清单
  STATE_FILE: 'state-ipv4.json',   // 锁定状态（沿用旧文件，不要删）
  OUTPUT_FILE: 'deployed-ipv4.txt',// 处理后的部署清单
  LOG_FILE: 'process.log',
  ENV_FILE: '.env',                // 只放令牌：TOKEN_1 ~ TOKEN_6

  // 锁月规则
  MONTH_MODE: 'calendar',      // 'calendar'=自然月(默认) | 'rolling30'=满30天
  ADD_MODE: 'immediate',       // 新 /24：立即加入(默认) | 'monthly'=只等月度刷新
  REMOVE_MODE: 'immediate',    // 消失 /24：立即移除(默认) | 数字=连续缺失N次
  MULTI_PER_PREFIX: 'first',   // 同 /24 多条：'first' 取第一条(默认) | 'all'
  RESTORE_ON_RETURN: true,     // 同月回归：沿用原锁定(默认) | false=用源里新IP

  // 推送
  CHUNK_SIZE: 50,              // 每个域名一段 = 50 个
  EMPTY_FILL_COUNT: 2,         // 空段填充条数（从整个清单里取前几条）
  TIMEOUT_MS: 20000,
};

// 槽位结构（编号固定：移动1/4、联通2/5、电信3/6；小号为 A 拿第1、2段，大号为 B 拿第3、4段）
// 域名直接写在下面；令牌从 .env / 环境变量读取（TOKEN_1 ~ TOKEN_6）
const SLOT_DEFS = [
  { slot: 1, network: '移动', side: 'A', domains: ['2a9ad1aa.alidns-2.com', 'd1ed77cc.alidns-2.com'] },
  { slot: 4, network: '移动', side: 'B', domains: ['5ed06881.alidns-2.com', '1080ac66.alidns-2.com'] },
  { slot: 2, network: '联通', side: 'A', domains: ['ea2317f0.alidns-1.com', 'b5202c8c.alidns-1.com'] },
  { slot: 5, network: '联通', side: 'B', domains: ['c32df85c.alidns-3.com', 'e8468091.alidns-3.com'] },
  { slot: 3, network: '电信', side: 'A', domains: ['38a4381a.alidns-2.com', '32fbc382.alidns-2.com'] },
  { slot: 6, network: '电信', side: 'B', domains: ['b15488b3.alidns-3.com', 'cedf0ead.alidns-3.com'] },
];

// ======================= env / .env 读取 =======================

function loadEnvFile() {
  const file = path.join(DIR, CONFIG.ENV_FILE);
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val; // 系统环境变量优先
  }
}

function sanitizeToken(t) {
  let v = String(t == null ? '' : t).trim();
  // 容错：粘贴时带了引号或 "Bearer " 前缀会自动去掉（令牌本身不会以这些开头）
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  v = v.replace(/^bearer\s+/i, '').trim();
  return v;
}

function buildSlots() {
  return SLOT_DEFS.map((d) => ({
    ...d,
    token: sanitizeToken(process.env[`TOKEN_${d.slot}`]),
  }));
}

loadEnvFile();
const SLOTS = buildSlots();

// ======================= 以下一般不用改 =======================

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');   // 默认：正式推送；加 --dry-run 只预览
const LIVE = !DRY_RUN;
const NO_DOWNLOAD = argv.includes('--no-download');
const NO_PUSH = argv.includes('--no-push');
const FORCE_PUSH = argv.includes('--force-push');
const FORCE_REFRESH = argv.includes('--refresh');
const SHOW_TOKENS = argv.includes('--tokens');
const DISCOVER = (argv.find((a) => a.startsWith('--discover=')) || '').split('=')[1];
const SLOT_FILTER = (argv.find((a) => a.startsWith('--slot=')) || '').split('=')[1];

const now = new Date();
let FAILED = false;
const cache = { domains: new Map(), rules: new Map() };

const log = (...a) => console.log(...a);
const ph = (v) => v === undefined || v === null || String(v).trim() === '' || /^<.*>$/.test(String(v).trim());
const tokenPh = (v) => ph(v) || /^\d$/.test(String(v).trim());
const abs = (f) => (path.isAbsolute(f) ? f : path.join(DIR, f));

const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const yyyymm = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const ipToNum = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const prefixOf = (ip) => ip.split('.').slice(0, 3).join('.');

function parseIpv4(line) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(line);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (p.some((n) => n > 255)) return null;
  return p.join('.');
}

// ---------------- 下载源文件 ----------------
// 支持直接粘贴 github.com/.../blob/... 链接，会自动转成 raw 地址
function normalizeGithubUrl(u) {
  u = String(u || '').trim();
  const m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return u;
}

async function downloadSource() {
  const url = normalizeGithubUrl(CONFIG.SOURCE_URL);
  log(`[下载] ${url}`);
  for (let i = 1; i <= 3; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONFIG.DOWNLOAD_TIMEOUT_MS);
      let text;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'cf-byoip-sync', 'Accept': 'text/plain, */*' },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      const valid = text.split(/\r?\n/).some((l) => parseIpv4(l.replace(/^\uFEFF/, '').trim()));
      if (!valid) throw new Error('下载内容里没有有效 IPv4');
      writeFileAtomic(abs(CONFIG.SOURCE_FILE), text.endsWith('\n') ? text : text + '\n');
      log(`[下载] OK（尝试 ${i}/3），已保存: ${abs(CONFIG.SOURCE_FILE)}`);
      return true;
    } catch (e) {
      log(`[下载] 尝试 ${i}/3 失败: ${e.message}`);
      if (i < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

// ---------------- 本地源文件 ----------------
function loadSource() {
  const file = abs(CONFIG.SOURCE_FILE);
  if (!fs.existsSync(file)) {
    console.error(`[错误] 找不到源文件: ${file}`);
    console.error('请把 ipv4.txt 放到脚本同目录，或修改 CONFIG.SOURCE_FILE / 让脚本自动下载');
    process.exit(1);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  const ips = [];
  for (let l of raw.split(/\r?\n/)) {
    l = l.replace(/^\uFEFF/, '').trim();
    if (!l || l.startsWith('#')) continue;
    const ip = parseIpv4(l);
    if (ip && !seen.has(ip)) { seen.add(ip); ips.push(ip); }
  }
  return ips;
}

function groupByPrefix(ips) {
  const map = new Map();
  for (const ip of ips) {
    const pre = prefixOf(ip);
    if (!map.has(pre)) map.set(pre, []);
    map.get(pre).push(ip);
  }
  return map;
}

// ---------------- 状态读写 ----------------
function loadState() {
  const file = abs(CONFIG.STATE_FILE);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`[错误] 状态文件损坏，无法解析: ${file}`); process.exit(1); }
}

function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function saveJson(file, obj) { writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n'); }
function appendLog(text) { try { fs.appendFileSync(abs(CONFIG.LOG_FILE), text + '\n', 'utf8'); } catch (e) {} }

// ---------------- 锁月逻辑 ----------------
function pickIps(ips) { return CONFIG.MULTI_PER_PREFIX === 'all' ? ips.slice() : ips.slice(0, 1); }

function newEntry(prefix, ips) {
  return {
    prefix,
    ips,
    status: 'active',   // active | removed
    missCount: 0,
    lockedAt: localIso(now),
    updatedAt: localIso(now),
  };
}

function fullRefresh(srcByPrefix) {
  const entries = {};
  for (const [prefix, ips] of srcByPrefix) entries[prefix] = newEntry(prefix, pickIps(ips));
  return { month: yyyymm(now), lastFullRefreshAt: localIso(now), entries };
}

function applyIncremental(state, srcByPrefix) {
  const changes = { added: [], removed: [], restored: [], suffixChurn: [], kept: 0 };

  for (const [prefix, ips] of srcByPrefix) {
    const e = state.entries[prefix];
    if (!e) {
      if (CONFIG.ADD_MODE === 'immediate') {
        state.entries[prefix] = newEntry(prefix, pickIps(ips));
        changes.added.push(`${prefix} -> ${state.entries[prefix].ips[0]}（新增）`);
      }
    } else if (e.status === 'removed') {
      if (CONFIG.RESTORE_ON_RETURN) {
        e.status = 'active'; e.missCount = 0; e.updatedAt = localIso(now);
        changes.restored.push(`${prefix} -> ${e.ips[0]}（恢复，沿用原锁定）`);
      } else {
        e.ips = pickIps(ips); e.status = 'active'; e.missCount = 0; e.updatedAt = localIso(now);
        changes.restored.push(`${prefix} -> ${e.ips[0]}（恢复，用源里新 IP）`);
      }
    } else {
      e.missCount = 0;
      changes.kept++;
      const srcFirst = ips[0] || '';
      if (srcFirst && e.ips[0] && srcFirst !== e.ips[0]) {
        changes.suffixChurn.push(`${prefix}: 源=${srcFirst}，锁定=${e.ips[0]}（沿用原锁定，不推送）`);
      }
    }
  }

  const threshold = CONFIG.REMOVE_MODE === 'immediate' ? 1 : Math.max(1, Number(CONFIG.REMOVE_MODE) || 1);
  for (const [prefix, e] of Object.entries(state.entries)) {
    if (e.status !== 'active') continue;
    if (srcByPrefix.has(prefix)) continue;
    e.missCount = (e.missCount || 0) + 1;
    if (e.missCount >= threshold) {
      e.status = 'removed';
      e.updatedAt = localIso(now);
      changes.removed.push(`${prefix}（移出，原锁定 ${e.ips[0]}）`);
    }
  }
  return changes;
}

function needFullRefresh(state) {
  if (!state) return true;
  if (CONFIG.MONTH_MODE === 'rolling30') {
    if (!state.lastFullRefreshAt) return true;
    const last = new Date(state.lastFullRefreshAt.replace(' ', 'T'));
    return now.getTime() - last.getTime() >= 30 * 24 * 3600 * 1000;
  }
  return state.month !== yyyymm(now);
}

function activeIps(state) {
  const out = [];
  for (const e of Object.values(state.entries)) if (e.status === 'active') out.push(...e.ips);
  out.sort((a, b) => ipToNum(a) - ipToNum(b));
  return out;
}

function diffLists(oldList, newList) {
  const a = new Set(oldList), b = new Set(newList);
  return {
    added: newList.filter((x) => !a.has(x)),
    removed: oldList.filter((x) => !b.has(x)),
  };
}

function summarizeRefresh(oldState, newState) {
  const samples = [];
  let updated = 0;
  if (oldState && oldState.entries) {
    for (const [prefix, e] of Object.entries(newState.entries)) {
      const old = oldState.entries[prefix];
      if (old && Array.isArray(old.ips) && old.ips[0] && e.ips[0] && old.ips[0] !== e.ips[0]) {
        updated++;
        if (samples.length < 8) samples.push(`${prefix}: ${old.ips[0]} -> ${e.ips[0]}`);
      }
    }
  }
  return { updated, samples };
}

// ---------------- API 基础 ----------------
async function api(token, method, p, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.API_BASE + p, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { success: false, errors: [{ code: res.status, message: text.slice(0, 300) }] }; }
    return { http: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const apiOk = (r) => r && r.json && r.json.success === true;
const apiErr = (r) => {
  const j = (r && r.json) || {};
  const errs = (j.errors || []).map((e) => `[${e.code}] ${e.message}`).join('; ');
  const hint = /login required/i.test(errs)
    ? '（认证失败：检查①令牌值是否与本地一致（--tokens 可对比长度+指纹）②令牌是否设了 IP 访问限制（改为允许所有 IP））'
    : '';
  return `HTTP ${r && r.http}${errs ? ' - ' + errs : ''}${hint}`;
};

const listDomains = async (token) => {
  const r = await api(token, 'GET', '/dns_routing_domains?page=1&per_page=200');
  if (!apiOk(r)) throw new Error('列取调度域失败: ' + apiErr(r));
  return r.json.result || [];
};
const listRules = async (token) => {
  const r = await api(token, 'GET', '/dns_routing_rules?page=1&per_page=500');
  if (!apiOk(r)) throw new Error('列取规则失败: ' + apiErr(r));
  return r.json.result || [];
};

const cachedDomains = (token) => {
  if (!cache.domains.has(token)) cache.domains.set(token, listDomains(token));
  return cache.domains.get(token);
};
const cachedRules = (token) => {
  if (!cache.rules.has(token)) cache.rules.set(token, listRules(token));
  return cache.rules.get(token);
};

async function resolveDefaultRule(token, domainStr) {
  const domains = await cachedDomains(token);
  const key = String(domainStr).trim();
  const dom =
    domains.find((d) => d.uuid === key) ||
    domains.find((d) => d.domain === key) ||
    domains.find((d) => String(d.domain).includes(key));
  if (!dom) throw new Error(`账号里找不到调度域 "${key}"（现有: ${domains.map((d) => d.domain).join(', ')}）`);

  const rules = await cachedRules(token);
  let cand = rules.filter((r) => r.dns_domain_uuid === dom.uuid);
  if (cand.length > 1) {
    const def = cand.filter((r) => String(r.geo_isp || '').toLowerCase() === 'default');
    if (def.length === 1) cand = def;
  }
  if (cand.length === 0) throw new Error(`域名 ${dom.domain} 下没有找到规则`);
  if (cand.length > 1) {
    throw new Error(`域名 ${dom.domain} 下有多条规则，无法确定“默认”规则：\n` +
      cand.map((r) => `      - ${r.name || '(未命名)'} [${r.uuid}] 线路=${r.geo_isp}`).join('\n'));
  }
  return { dom, rule: cand[0] };
}

function buildUpdateBody(rule, pool, dom) {
  const conf = Object.assign({}, (rule.action && rule.action.conf) || {});
  conf.address_pool = pool;
  return {
    domain: rule.domain || (dom && dom.domain),
    type: rule.type,
    geo_isp: rule.geo_isp,
    name: rule.name,
    description: rule.description,
    dns_domain_uuid: rule.dns_domain_uuid || (dom && dom.uuid),
    action: { method: (rule.action && rule.action.method) || 'ip_election', conf },
    status: rule.status || 'active',
    auto_pause_on_empty: !!rule.auto_pause_on_empty,
  };
}

function poolIpsEqual(rule, pool) {
  const ap = rule.action && rule.action.conf && rule.action.conf.address_pool;
  if (!ap || ap.mode !== 'customize' || !Array.isArray(ap.groups)) return false;
  const cur = [];
  for (const g of ap.groups) {
    if (g.type === 'ip' && Array.isArray(g.ips)) cur.push(...g.ips);
    else return false;
  }
  const next = [];
  for (const g of pool.groups) next.push(...g.ips);
  cur.sort(); next.sort();
  return cur.length === next.length && cur.every((x, i) => x === next[i]);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function buildPool(ips) {
  return {
    mode: 'customize',
    groups: chunk(ips, CONFIG.CHUNK_SIZE).map((g) => ({ type: 'ip', ips: g })),
  };
}

// ---------------- 处理一个槽位（令牌） ----------------
async function pushSlot(slot, segsForSide, filler) {
  log(`\n==== 令牌 ${slot.slot}（${slot.network} ${slot.side}） ====`);

  if (tokenPh(slot.token)) {
    if (LIVE) { log(`  [失败] 令牌未配置（请在 ${CONFIG.ENV_FILE} 里设置 TOKEN_${slot.slot}）`); FAILED = true; }
    else log(`  [跳过] 令牌未配置（在 ${CONFIG.ENV_FILE} 里设置 TOKEN_${slot.slot} 后可推送）`);
    return;
  }
  if (!slot.domains.length) {
    if (LIVE) { log('  [失败] 域名未配置（检查脚本里 SLOT_DEFS 的 domains）'); FAILED = true; }
    else log('  [跳过] 域名未配置（检查脚本里 SLOT_DEFS 的 domains）');
    return;
  }
  if (slot.domains.length !== 2) log(`  [注意] 该槽位配置了 ${slot.domains.length} 个域名（正常应为 2 个）`);

  for (let i = 0; i < slot.domains.length; i++) {
    const domainStr = slot.domains[i];
    let list = segsForSide[i] || [];
    let filled = false;
    if (list.length === 0) { list = filler.slice(); filled = true; }
    const pool = buildPool(list);
    const sizes = pool.groups.map((g) => g.ips.length);

    log(`  域名: ${domainStr}`);
    if (filled) {
      log(`    分片: （空）-> 用 ${list.length} 条填充: ${list.join(', ') || '无可用'}`);
    } else {
      log(`    分片: ${list.length} 条 -> ${pool.groups.length} 组 ${JSON.stringify(sizes)}`);
      pool.groups.forEach((g, idx) => {
        log(`      第${idx + 1}组(${g.ips.length}): ${g.ips.slice(0, 3).join(', ')}${g.ips.length > 3 ? ', ...' : ''}`);
      });
    }
    if (pool.groups.length > 4) log('    [警告] 超过 4 组！AxisNow 单条规则最多 4 个地址组。');

    try {
      const { dom, rule } = await resolveDefaultRule(slot.token, domainStr);
      if (rule.type !== 'A') { log(`    [跳过] 规则类型是 ${rule.type}，不是 A（只改 A 记录 IP 池）`); continue; }
      log(`    目标规则: [${rule.uuid}] 线路=${rule.geo_isp} 类型=${rule.type}`);
      if (poolIpsEqual(rule, pool)) { log('    [跳过] 地址池与当前一致，无需更新'); continue; }
      if (!LIVE) {
        const preview = JSON.stringify(pool);
        log('    [dry-run] 将 PUT /dns_routing_rules/' + rule.uuid + '（只替换 address_pool，其余保持原值）:');
        log('      ' + preview.slice(0, 300) + (preview.length > 300 ? ' ...' : ''));
        continue;
      }
      const r = await api(slot.token, 'PUT', `/dns_routing_rules/${rule.uuid}`, buildUpdateBody(rule, pool, dom));
      if (apiOk(r)) log('    [OK] 已更新');
      else throw new Error('更新失败: ' + apiErr(r));
    } catch (e) {
      if (LIVE) { log('    [失败] ' + e.message); FAILED = true; }
      else log('    [dry-run] 解析目标失败: ' + e.message);
    }
  }
}

// ---------------- 查域名/规则（填配置用） ----------------
async function discover(no) {
  const slot = SLOTS.find((s) => String(s.slot) === String(no));
  if (!slot) { console.error(`[错误] 没有 ${no} 号令牌槽位`); process.exit(1); }
  if (tokenPh(slot.token)) { console.error(`[错误] 令牌 ${no} 未配置：请在 ${CONFIG.ENV_FILE} 里设置 TOKEN_${no}`); process.exit(1); }
  log(`=== 令牌 ${slot.slot}（${slot.network}-${slot.side}）的域名与规则 ===`);
  const domains = await cachedDomains(slot.token);
  const rules = await cachedRules(slot.token);
  for (const d of domains) {
    log(`\n域名: ${d.domain}  [${d.uuid}]  record_type=${d.record_type}  status=${d.status}${d.name ? '  name=' + d.name : ''}`);
    const rs = rules.filter((r) => r.dns_domain_uuid === d.uuid);
    if (!rs.length) log('  （该域名下没有规则）');
    for (const r of rs) log(`  └ 规则: ${r.name || '(未命名)'}  [${r.uuid}]  线路=${r.geo_isp || '?'}  类型=${r.type}  状态=${r.status}`);
  }
  log('\n域名已内置在脚本顶部 SLOT_DEFS 里；如与实际不一致，直接改那里即可。');
}

// ---------------- 主流程 ----------------
async function main() {
  log('=== cf-byoip-sync.js（下载 + 处理 + 有变化才推送） ===');
  log(`模式: ${LIVE ? '正式推送（有 IP 变化才推，会调 API）' : '--dry-run 预览（不写入）'}`);

  if (!fs.existsSync(path.join(DIR, CONFIG.ENV_FILE))) log(`[配置] 未找到 ${CONFIG.ENV_FILE}（在脚本同目录创建即可，只需填 TOKEN_1~TOKEN_6；线上可用环境变量）`);
  const missingSlots = SLOTS.filter((s) => tokenPh(s.token)).map((s) => s.slot);
  if (missingSlots.length) log(`[配置] 以下槽位令牌未配置: ${missingSlots.join(', ')}（在 ${CONFIG.ENV_FILE} 或环境变量里设置 TOKEN_x）`);
  else log('[配置] 6 个令牌均已读取');

  if (SHOW_TOKENS) {
    log('\n[令牌指纹] 在本地和线上各跑一次本命令，逐行对比（长度 + SHA256前8位）：');
    for (const s of SLOTS) {
      if (tokenPh(s.token)) { log(`  令牌 ${s.slot}（${s.network}${s.side}）: 未配置`); continue; }
      const fp = crypto.createHash('sha256').update(s.token, 'utf8').digest('hex').slice(0, 8);
      const dirty = /\s/.test(s.token) ? '  [注意: 值里含空白字符]' : '';
      log(`  令牌 ${s.slot}（${s.network}${s.side}）: 长度=${s.token.length}  指纹=${fp}${dirty}`);
    }
    return;
  }

  if (DISCOVER) { await discover(DISCOVER); return; }

  // ---------- 0) 下载源文件 ----------
  if (NO_DOWNLOAD) {
    log('[下载] 已跳过（--no-download），直接使用本地 ipv4.txt');
  } else {
    const okDl = await downloadSource();
    if (!okDl) {
      if (!fs.existsSync(abs(CONFIG.SOURCE_FILE))) {
        console.error('[中止] 下载失败，且本地没有 ipv4.txt，无法继续。');
        process.exit(1);
      }
      log('[下载] 失败：将使用本地已有的 ipv4.txt 继续');
    }
  }

  // ---------- 1) 本地处理 ----------
  const srcIps = loadSource();
  if (!srcIps.length) { console.error('[中止] 源文件里没有有效 IPv4，本次不做任何改动。'); process.exit(1); }
  const srcByPrefix = groupByPrefix(srcIps);
  log(`\n源文件: ${srcIps.length} 条 IP / ${srcByPrefix.size} 个 /24 前缀`);

  let state = loadState();
  const oldState = state;
  let action, changes = null, refreshInfo = null;

  if (FORCE_REFRESH || needFullRefresh(state)) {
    action = 'full-refresh';
    state = fullRefresh(srcByPrefix);
    if (oldState && oldState.lastPush) state.lastPush = oldState.lastPush; // 保留推送记录
    refreshInfo = summarizeRefresh(oldState, state);
    log(`模式: 全量刷新${FORCE_REFRESH ? '(--refresh)' : ''}（${oldState && oldState.month ? oldState.month : '(首次)'} -> ${state.month}）`);
    if (!oldState) log('（首次运行：建立基线）');
    else if (refreshInfo.updated) {
      log(`最后一位更新 ${refreshInfo.updated} 条，例如:`);
      refreshInfo.samples.forEach((s) => log('   ' + s));
    } else log('最后一位没有变化（跟源里一致）');
  } else {
    action = 'incremental';
    log(`模式: 增量（月份 ${state.month}，月内锁定第 4 段，只跟随 /24 增删）`);
    changes = applyIncremental(state, srcByPrefix);
  }

  const outList = activeIps(state);

  // ---------- 2) 保存 ----------
  saveJson(abs(CONFIG.STATE_FILE), state);
  writeFileAtomic(abs(CONFIG.OUTPUT_FILE), outList.join('\n') + '\n');

  if (changes) {
    log(`本次变化: 新增 ${changes.added.length} / 移除 ${changes.removed.length} / 恢复 ${changes.restored.length} / 保持 ${changes.kept}`);
    const showList = (title, arr, cap = 10) => {
      if (arr.length) {
        log(`${title} (${arr.length}):`);
        arr.slice(0, cap).forEach((x) => log('   ' + x));
        if (arr.length > cap) log(`   ...（其余 ${arr.length - cap} 条见 process.log）`);
      }
    };
    showList('新增', changes.added);
    showList('移除', changes.removed);
    showList('恢复', changes.restored);
    if (changes.suffixChurn.length) {
      log(`最后一位变化（沿用原锁定，不触发推送）: ${changes.suffixChurn.length} 条`);
      changes.suffixChurn.slice(0, 5).forEach((x) => log('   ' + x));
      if (changes.suffixChurn.length > 5) log(`   ...（其余 ${changes.suffixChurn.length - 5} 条见 process.log）`);
    }
  }
  log(`输出: ${abs(CONFIG.OUTPUT_FILE)}（共 ${outList.length} 条）`);

  let line = `[${localIso(now)}] action=${action} month=${state.month} src=${srcIps.length} out=${outList.length}`;
  if (changes) line += ` added=${changes.added.length} removed=${changes.removed.length} restored=${changes.restored.length} suffixChurn=${changes.suffixChurn.length} kept=${changes.kept}`;
  if (action === 'full-refresh' && refreshInfo) line += ` suffixUpdated=${refreshInfo.updated}`;
  appendLog(line);
  if (changes) {
    changes.added.forEach((x) => appendLog('    + ' + x));
    changes.removed.forEach((x) => appendLog('    - ' + x));
    changes.restored.forEach((x) => appendLog('    ~ ' + x));
    changes.suffixChurn.forEach((x) => appendLog('    = ' + x));
  }
  if (action === 'full-refresh' && refreshInfo) refreshInfo.samples.forEach((x) => appendLog('    * ' + x));

  // ---------- 3) 推送判断 ----------
  if (NO_PUSH) { log('\n[--no-push] 只做本地处理，本次不推送。'); return; }

  let pushNeeded = false;
  let pushReason = '';
  if (!state.lastPush || !Array.isArray(state.lastPush.list)) {
    pushNeeded = true;
    pushReason = '首次推送（还没有推送记录）';
  } else {
    const d = diffLists(state.lastPush.list, outList);
    if (d.added.length || d.removed.length) {
      pushNeeded = true;
      pushReason = `列表有变化（相对上次推送：+${d.added.length} / -${d.removed.length}）`;
    } else {
      pushReason = '列表与上次推送完全一致（源里最后一位变化已沿用原锁定）';
    }
  }
  if (FORCE_PUSH) { pushNeeded = true; pushReason = `${pushReason ? pushReason + '；' : ''}--force-push`; }

  if (!pushNeeded) { log(`\n推送判断: 不推送 —— ${pushReason}`); return; }
  log(`\n推送判断: 需要推送 —— ${pushReason}`);

  const C = CONFIG.CHUNK_SIZE;
  const segs = [outList.slice(0, C), outList.slice(C, 2 * C), outList.slice(2 * C, 3 * C), outList.slice(3 * C)];
  const filler = outList.slice(0, Math.min(CONFIG.EMPTY_FILL_COUNT, outList.length));
  const desc = (a) => (a.length ? `${a.length} 条（${a[0]}${a.length > 1 ? ' ... ' + a[a.length - 1] : ''}）` : '（空）');
  log(`分片: 第1段 ${desc(segs[0])} | 第2段 ${desc(segs[1])} | 第3段 ${desc(segs[2])} | 第4段 ${desc(segs[3])}`);
  log(`空段填充: ${filler.length} 条（${filler.join(', ') || '无'}）`);

  const slots = SLOT_FILTER ? SLOTS.filter((s) => String(s.slot) === SLOT_FILTER) : SLOTS;
  if (!slots.length) { console.error(`[错误] 没有 ${SLOT_FILTER} 号令牌槽位`); process.exit(1); }

  for (const s of slots) {
    const sideSegs = s.side === 'A' ? [segs[0], segs[1]] : [segs[2], segs[3]];
    await pushSlot(s, sideSegs, filler);
  }

  if (!LIVE) { log('\n[--dry-run] 预览结束：未向 AxisNow 写入（本地文件已按处理结果正常更新）。'); return; }
  if (FAILED) { log('\n推送存在失败项：本次不记录推送状态，下次运行会自动重试。'); process.exitCode = 1; return; }
  if (SLOT_FILTER) { log(`\n[--slot=${SLOT_FILTER}] 单槽位测试：本次不记录推送状态（避免误判为已全量推送）。`); return; }

  state.lastPush = { at: localIso(now), list: outList.slice() };
  saveJson(abs(CONFIG.STATE_FILE), state);
  log('\n推送完成，已记录本次推送清单：下次只有完整 IP 出现 增加/移除/恢复 才会再推。');
}

main().catch((e) => { console.error('[异常]', e); process.exit(1); });
