#!/usr/bin/env node
/**
 * 基于 GeoNames(选城市) + Overpass API(拉街道)的离线地址 JSON 采集脚本。
 *
 * 彻底替代之前"daimon3332/address + Overture Maps + DuckDB"那一整套流水线：
 * - 不再需要 Python / DuckDB / sqlite / 第三方仓库 / GitHub Actions 里一堆 ETL 步骤。
 * - 城市选择：用 GeoNames 官方免费数据集（cities15000.zip，人口 >= 1.5 万的全球城市，
 *   CC-BY 4.0 协议）按真实人口数排序，每个国家取人口最多的若干个城市——这是真实人口数据，
 *   比之前"街道组数量"这种代理指标要准确。
 * - 街道数据：对每个选中的城市，直接向 Overpass API（OpenStreetMap 的查询接口）发一次
 *   基于经纬度半径的查询，拿该城市范围内所有有名字的道路，以及带门牌号/邮编标注的地址点。
 *
 * 输出：单个合并文件 <out>/addresses.json，结构是
 *   { countries: { US: { 州/省: { 城市: { phonePrefix, postcodes, streets: { 街道名: { houseNumberRange } } } } } } }
 * 刻意做得很精简，只保留"随机生成一个真实地址(含门牌号范围/邮编/电话前缀)"这个目标需要的字段：
 * - 没有 district 这一级（Overpass 的半径查询本来就拿不到行政区细分，硬留着只是空壳）。
 * - 门牌号不是存原始数组，是压缩成 [min, max] 数值范围——你要的是范围不是逐个数字。
 * - 邮编统一挂在城市这一级，不在每条街上都重复存一份。
 *
 * 需要老实说明的数据现实（和之前方案相比的取舍）：
 * 1. 门牌号/邮编覆盖率取决于 OpenStreetMap 在当地的标注完整度，参差不齐——欧洲/日韩这类
 *    国家通常标注率高，东南亚/南美一些城市会明显偏低。没有门牌号证据的街道，streets 里
 *    对应的值是空对象 {}，但街道本身（来自道路网络数据）依然会被采集。
 * 2. 邮编是城市级的一个候选池，不精确对应到具体某条街——大城市可能横跨好几个邮区，
 *    随机生成时挑到的邮编不保证就是那条街真实所在的邮区。这是为了避免每条街都存一份
 *    重复邮编数据必须接受的取舍。
 * 3. OpenStreetMap 数据协议是 ODbL（需要署名 + 派生数据库同样开放），GeoNames 是 CC-BY 4.0
 *    （需要署名）。这点和之前用的 Overture Maps（CDLA Permissive 2.0，基本无限制）不一样，
 *    如果你要对外分发这份数据，请附上署名。
 * 4. Overpass 是社区免费运营的公共服务，有"合理使用"的隐性限制，不是无限量 API。脚本里对
 *    每次查询之间做了限速（默认 2 秒一次 + 随机抖动），并且必须提供一个能表明身份的
 *    User-Agent——通过 --user-agent 参数或 OVERPASS_USER_AGENT 环境变量提供，没提供
 *    直接拒绝执行，不是打个警告就放任不管。
 *
 * 用法：
 *   node collect-streets-overpass.mjs --out offline-addresses \
 *     --user-agent "your-project/1.0 (contact: you@example.com)" \
 *     [--countries US,CA,MX,...] [--cities-per-country 6] [--limit 60] \
 *     [--min-streets-warn 5] [--work-dir .geonames-cache] [--overpass-delay-ms 2000]
 *
 * 建议先用 --countries US --cities-per-country 1 只测一个国家一个城市，确认真实数据没问题，
 * 再跑全量。每处理完一个国家就会把 addresses.json 重新落盘一次，中途失败/被取消也不会
 * 丢掉已经跑完的国家。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ============================== 配置 ==============================

// 必须改成你自己的信息（项目地址或联系邮箱都行）——Overpass/OSM 社区要求请求方
// 表明身份，用默认占位符长期高频请求，容易被公共实例限流或拉黑。
// User-Agent 必须能表明请求方身份（Overpass/OSM 社区的硬性要求），不再是写死在源码里
// 改起来麻烦的常量——从环境变量 OVERPASS_USER_AGENT 或 --user-agent 参数读取，
// 都没提供就直接拒绝执行（见下面 main() 里的检查），而不是打个警告就放任不管。
function resolveUserAgent(cliValue) {
  return cliValue || process.env.OVERPASS_USER_AGENT || null;
}

const GEONAMES_CITIES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const GEONAMES_ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';

// 多个 Overpass 公共实例，主实例失败/被限流时按顺序尝试下一个。
// 优先使用声明无硬性速率限制、硬件更强的镜像，主实例放最后兜底。
// 关于 HTTP 406：这不是限流也不是查询语法问题。2025-2026 年 overpass-api.de 主实例
// 因为被大量 AI 爬虫流量冲击，加了一套"请求特征"过滤，命中了就直接拒绝——对同一台服务器
// 重试拿到的是一模一样的拒绝，唯一有效的办法是换一台服务器（见下面 queryOverpassWithRetry
// 里 406 分支的处理：不重试同一个 endpoint，直接跳下一个）。
const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',   // 首选：无硬性 rate limit
  'https://overpass.kumi.systems/api/interpreter',     // 同家族
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', // VK Maps，常宣称无限制
  'https://z.overpass-api.de/api/interpreter',         // FOSSGIS 镜像
  'https://lz4.overpass-api.de/api/interpreter',       // FOSSGIS 大查询镜像
  'https://overpass-api.de/api/interpreter',           // 主实例，最后兜底
];

const DEFAULT_COUNTRIES = [
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU',
  'JP', 'KR', 'ID', 'VN', 'TR', 'ZA', 'MY', 'IN', 'AU', 'BR',
];

// ============================== 工具函数 ==============================

function parseArgs(argv) {
  const out = {
    outDir: 'offline-addresses',
    countries: DEFAULT_COUNTRIES,
    citiesPerCountry: 6,
    // 之前默认 300，但你只是要"一些"街道用来生成示例地址，不需要这么多——
    // 6 个城市 × 10 条左右足够覆盖多样性了，需要更多用 --limit 调大即可。
    limit: 60,
    minStreetsWarn: 5,
    workDir: '.geonames-cache',
    overpassDelayMs: 2000,
    radiusMetersOverride: null,
    // 单次查询里，Overpass 最多返回多少条"道路"/多少个"带门牌号的地址点"——这两个是
    // 硬性封顶（安全阀），实际请求量会按这个城市当次实际需要多少条街道动态计算，通常远小于
    // 这个封顶值，只有在需要量本身很大时才会顶到这里。
    maxRoadsPerCity: 200,
    maxAddrPointsPerCity: 2000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = argv[++i];
    else if (a === '--countries') out.countries = argv[++i].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--cities-per-country') out.citiesPerCountry = Number(argv[++i]);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--min-streets-warn') out.minStreetsWarn = Number(argv[++i]);
    else if (a === '--work-dir') out.workDir = argv[++i];
    else if (a === '--overpass-delay-ms') out.overpassDelayMs = Number(argv[++i]);
    else if (a === '--radius-m') out.radiusMetersOverride = Number(argv[++i]);
    else if (a === '--user-agent') out.userAgent = argv[++i];
    else if (a === '--max-roads-per-city') out.maxRoadsPerCity = Number(argv[++i]);
    else if (a === '--max-addr-points-per-city') out.maxAddrPointsPerCity = Number(argv[++i]);
  }
  return out;
}

// 清理不可见字符 (Zero-width spaces, LRM, RLM, BOM 等)
function sanitizeString(str) {
  if (!str) return '';
  return String(str).replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '').trim();
}

function normKey(value) {
  if (!value) return '';
  return String(value).normalize('NFKC').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 根据国家+城市生成一个"看起来合理"的固定电话区号前缀，纯展示用途，和原脚本逻辑一致
// （用字符串哈希取模，同一个城市每次生成结果稳定不变）。
function generateCityPhonePrefix(countryCode, cityName) {
  let hash = 0;
  const key = `${countryCode}-${cityName}`;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const prefix = 20 + (hash % 79); // 生成一个 20-98 之间的两位数区号
  return `0${prefix}`;
}

// ============================== 第一步：下载 & 解析 GeoNames 城市数据 ==============================

function downloadFile(url, destPath) {
  // 用 curl 而不是 fetch，是因为要写入较大的二进制/文本文件到磁盘，
  // execFileSync 调 curl 比手写 fetch->stream->fs 更少代码、更少出错的地方，
  // GitHub Actions ubuntu-latest runner 自带 curl，不需要额外安装。
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', destPath, url], { stdio: 'inherit' });
}

function ensureGeonamesFiles(workDir) {
  fs.mkdirSync(workDir, { recursive: true });

  const citiesTxt = path.join(workDir, 'cities15000.txt');
  if (!fs.existsSync(citiesTxt)) {
    const zipPath = path.join(workDir, 'cities15000.zip');
    console.log('[geonames] 下载城市数据集 cities15000.zip ...');
    downloadFile(GEONAMES_CITIES_URL, zipPath);
    // GitHub Actions ubuntu-latest 自带 unzip；本地 Ubuntu/Debian 一般也有，没有的话
    // `sudo apt-get install -y unzip` 装一下即可。
    execFileSync('unzip', ['-o', zipPath, 'cities15000.txt', '-d', workDir], { stdio: 'inherit' });
  }

  const admin1Txt = path.join(workDir, 'admin1CodesASCII.txt');
  if (!fs.existsSync(admin1Txt)) {
    console.log('[geonames] 下载省/州名称对照表 admin1CodesASCII.txt ...');
    downloadFile(GEONAMES_ADMIN1_URL, admin1Txt);
  }

  return { citiesTxt, admin1Txt };
}

// admin1CodesASCII.txt 每行格式（Tab 分隔）：code(如 US.CA)  完整名称  ascii名称  geonameid
function loadAdmin1Names(admin1Txt) {
  const map = new Map();
  const raw = fs.readFileSync(admin1Txt, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    map.set(cols[0], cols[1]);
  }
  return map;
}

// cities15000.txt 是 GeoNames 官方 "geoname" 表结构（Tab 分隔，无表头），列定义见
// https://download.geonames.org/export/dump/readme.txt ，这里只取用得到的几列：
//   1=name  4=latitude  5=longitude  8=country code  10=admin1 code  14=population
function loadCitiesForCountries(citiesTxt, admin1Map, countries, citiesPerCountry) {
  const countrySet = new Set(countries);
  const byCountry = new Map(countries.map((c) => [c, []]));

  const raw = fs.readFileSync(citiesTxt, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 15) continue;

    const name = cols[1];
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const countryCode = cols[8];
    const admin1Code = cols[10];
    const population = Number(cols[14]) || 0;

    if (!countrySet.has(countryCode)) continue;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (population < 100_000) continue;

    const admin1Key = admin1Code ? `${countryCode}.${admin1Code}` : '';
    const admin1Name = admin1Map.get(admin1Key) || admin1Code || '-';

    byCountry.get(countryCode).push({ name, lat, lon, admin1: admin1Name, population });
  }

  const result = new Map();
  for (const [cc, cities] of byCountry.entries()) {
    cities.sort((a, b) => b.population - a.population);
    result.set(cc, cities.slice(0, citiesPerCountry));
  }
  return result;
}

// 根据人口规模给一个大致合理的查询半径（米），城市越大范围越大。纯粹是经验取值，
// 追求的是"覆盖到市中心主要路网"而不是精确的行政边界，简单可靠优先。
// （半径比第一版略微调小了一档：现在有下面 out 数量上限兜底控制返回体积，
// 半径主要影响服务器端要扫描的范围大小，适当缩小能降低超大城市查询超时的概率）
function radiusForPopulation(population, override) {
  if (override) return override;
  // 整体再收紧一档，降低大都市 504 / 超时概率
  if (population >= 8_000_000) return 2_000; 
  if (population >= 5_000_000) return 5_000;
  if (population >= 1_000_000) return 3_000;
  if (population >= 300_000) return 2_000; 
  return 3_000; 
}

// ============================== 第二步：Overpass 查询 & 解析 ==============================

// 只保留真正可以作为邮寄地址的道路类型，排除自行车道/人行道/台阶/小径这些——
// 之前没做这个过滤，us.json 里能看到 "Williamsburg Bridge Bike Path" 这种明显不是
// 邮寄地址的东西混进了结果。
const ADDRESSABLE_HIGHWAY_TYPES = 'residential|living_street|unclassified|tertiary|secondary|primary|road';

function buildOverpassQuery(lat, lon, radiusMeters, { maxRoads, maxAddrPoints }) {
  return `[out:json][timeout:60][maxsize:64Mi];
way(around:${radiusMeters},${lat},${lon})["highway"~"^(${ADDRESSABLE_HIGHWAY_TYPES})$"]["name"]->.roads;
node(around:${radiusMeters},${lat},${lon})["addr:housenumber"]["addr:street"]->.addrNodes;
way(around:${radiusMeters},${lat},${lon})["addr:housenumber"]["addr:street"]->.addrWays;
.roads out tags ${maxRoads};
.addrNodes out tags ${maxAddrPoints};
.addrWays out tags ${Math.round(maxAddrPoints / 2)};`;
}

async function queryOverpassWithRetry(query, userAgent, { maxAttemptsPerEndpoint = 2 } = {}) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= maxAttemptsPerEndpoint; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'User-Agent': userAgent,
            // 一部分"疑似爬虫"判定是靠请求头是否齐全——只有 Content-Type 和自定义
            // User-Agent，没有 Accept/Accept-Language 这种正常客户端都会带的头，
            // 本身就是一个可疑信号。补上这两个，让请求更接近真实客户端。
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          body: query,
        });

        if (response.status === 406) {
          // 406 不是限流，是服务器把这次请求判定成"疑似爬虫"直接拒绝——对同一台服务器
          // 重试拿到的会是一模一样的拒绝，浪费时间也没用，直接换下一个 endpoint。
          lastError = new Error('HTTP 406');
          console.warn(`[overpass] ${endpoint} 返回 406（判定为疑似爬虫请求），跳过重试，直接换下一个镜像`);
          break;
        }
        if (response.status === 429 || response.status === 504) {
          // 固定短等再试，不做指数退避，尽快换镜像或进入下一城，缩短总墙钟时间
          const waitMs = 2500;
          console.warn(`[overpass] ${endpoint} 返回 ${response.status}，${waitMs}ms 后重试`);
          await sleep(waitMs);
          continue;
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        return data.elements || [];
      } catch (error) {
        lastError = error;
        console.warn(`[overpass] ${endpoint} 第 ${attempt} 次请求失败: ${error.message}`);
        await sleep(1000);
      }
    }
  }
  throw new Error(`所有 Overpass 实例均请求失败: ${lastError?.message || '未知错误'}`);
}

// 把 Overpass 返回的 elements 数组，整理成 { streetName -> { houseNumbers:Set, postcodes:Set } }
function extractStreetsFromElements(elements) {
  const streets = new Map(); // normKey(name) -> { rawName, houseNumbers:Set, postcodes:Set }

  const ensure = (rawName) => {
    const key = normKey(rawName);
    if (!key) return null;
    if (!streets.has(key)) {
      streets.set(key, { rawName: rawName.trim(), houseNumbers: new Set(), postcodes: new Set() });
    }
    return streets.get(key);
  };

  // 第一遍：道路网络里所有带名字的路，先把"这条街确实存在"记下来
  for (const el of elements) {
    if (el.type === 'way' && el.tags?.highway && el.tags?.name) {
      let rawName = sanitizeString(el.tags.name);
      
      // 规则：OSM 常用 ; 连写双名，拆开只取第一段
      rawName = rawName.split(';')[0].trim();
      if (!rawName) continue; // 边界防御，防止切分/清理后为空
      
      // 规则：长度防御。如果长度超过 50 个字符，大概率是被滥用填入了完整的寄信地址。
      if (rawName.length > 50) continue;
      
      // 规则：极强拦截。正常的街道名极其罕见包含逗号。有逗号 99.9% 是"街道, 城市"的冗余信息
      if (rawName.includes(',')) continue;

      // 规则：过滤掉把门牌号写进道路名的脏数据
      if (/^\d+$/.test(rawName)) continue;
      
      // 规则：过滤掉路床、楼层单元、步道、以及乱填的 POI/地标（如 Opposite, Near, Ground Floor）
      if (/\b(roadbed|penthouse|bike\s*path|ramp|floor|g\/?f|unit\s+no|opp|opposite|near\b|next\s+to|room|suite|apartment|apt)\b/i.test(rawName)) continue;

      el.tags.name = rawName; // 覆写回去，保持一致性
      ensure(rawName);
    }
  }

  // 第二遍：带门牌号标注的地址点/建筑物，按 addr:street 归到对应街道上。
  // 即使这个街道名没有在第一遍里出现（比如查询半径边缘只碰到了地址点没碰到路），
  // 只要有门牌号证据，也认为它是一条真实存在的街道，一并采集。
  for (const el of elements) {
    let street = el.tags?.['addr:street'];
    const houseNumber = el.tags?.['addr:housenumber'];
    if (!street || !houseNumber) continue;

    street = sanitizeString(street);
    street = street.split(';')[0].trim();
    if (!street) continue; // 边界防御，防止切分/清理后为空
    
    // 规则复用：清理并校验非法地址点路名
    if (street.length > 50) continue;
    if (street.includes(',')) continue;
    if (/^\d+$/.test(street)) continue;
    if (/\b(roadbed|penthouse|bike\s*path|ramp|floor|g\/?f|unit\s+no|opp|opposite|near\b|next\s+to|room|suite|apartment|apt)\b/i.test(street)) continue;

    const entry = ensure(street);
    if (!entry) continue;

    // OSM 里偶尔会出现一个字段填了多个值、用分号隔开的情况（比如某个地址正好横跨
    // 两个邮编分区，被标注成 "90013;90015"）。这里按分号拆开，当成多个独立候选。
    for (let hn of String(houseNumber).split(';')) {
      hn = sanitizeString(hn);
      if (hn) entry.houseNumbers.add(hn);
    }

    const postcodeRaw = el.tags?.['addr:postcode'];
    if (postcodeRaw) {
      for (let pc of String(postcodeRaw).split(';')) {
        pc = sanitizeString(pc);
        
        // 规则：邮编粗校验，长度控制在3-10位之间
        // 并且只允许Unicode字母(\p{L})、数字(\p{N})、空格、连字符
        if (pc.length < 3 || pc.length > 10 || !/^[\p{L}\p{N}\s\-]+$/u.test(pc)) {
          continue;
        }

        // 规则：如果是连续9位以上的纯数字(忽略空格和横杠后)，极有可能是电话号码、CPF 等证件号写错进来了
        if (/^\d{9,}$/.test(pc.replace(/[\s\-]/g, ''))) {
          continue;
        }

        entry.postcodes.add(pc);
      }
    }
  }

  return streets;
}

// ============================== 第三步：按城市轮询抽样到 limit 条 ==============================

function pickStreetsRoundRobin(citiesWithStreets, limit) {
  // citiesWithStreets: [{ city, admin1, streets: [{name, houseNumbers, postcodes}, ...] }, ...]
  //
  // 目标是生成"能拼出真实地址"的数据，所以每个城市内部优先消耗有门牌号证据的街道
  // （houseNumbers 非空），纯路名、没有任何门牌号数据的街道排到后面，只有前者不够填满
  // 该城市的配额时才会被用上。两组内部各自打乱顺序，避免总是选到同一批。
  const pool = citiesWithStreets
    .map((c) => {
      // 门牌数量多的优先；数量相同则随机，避免总是同一批
      const sorted = [...c.streets].sort((a, b) => {
        const diff = b.houseNumbers.size - a.houseNumbers.size;
        if (diff !== 0) return diff;
        return Math.random() - 0.5;
      });
      return { ...c, streets: sorted, idx: 0 };
    })
    .filter((c) => c.streets.length > 0);

  const picked = [];
  let stillHasData = true;
  while (picked.length < limit && stillHasData) {
    stillHasData = false;
    for (const city of pool) {
      if (picked.length >= limit) break;
      if (city.idx >= city.streets.length) continue;
      picked.push({ ...city.streets[city.idx], city: city.city, admin1: city.admin1 });
      city.idx++;
      stillHasData = true;
    }
  }
  return picked;
}

// ============================== 第四步：拼装树形 JSON ==============================

// 从门牌号集合里提取数字范围 [min, max]。非数字门牌号（如 "5A"）不参与范围计算——
// "范围"这个概念本身只对数字有意义，为了不引入臃肿的原始数组，这里直接丢弃非数字项。
// 一个都没有数字门牌号时返回 null，表示这条街完全没有门牌号证据。
function extractHouseNumberRange(houseNumbers) {
  const nums = [...houseNumbers]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;

  let min = Math.min(...nums);
  let max = Math.max(...nums);

  // 只采到一个门牌（或全部相同）时，向下扩 30，避免范围退化成单点
  if (min === max) {
    min = Math.max(1, min - 30);
  }

  return [min, max];
}

function buildTreeJSON(countryCode, picked) {
  const root = {};
  for (const s of picked) {
    const a1 = s.admin1 || '-';
    const city = s.city || '-';

    root[a1] ??= {};
    root[a1][city] ??= {
      // 注意：phonePrefix 是根据国家+城市名生成的固定哈希前缀，纯粹为了让生成出来的
      // 电话号码"看起来合理"，不是真实的电信局分配的区号，不能当真实数据使用。
      phonePrefix: generateCityPhonePrefix(countryCode, city),
      postcodes: [],
      streets: {},
    };

    const cityNode = root[a1][city];
    const range = extractHouseNumberRange(s.houseNumbers);
    cityNode.streets[s.rawName] = range ? { houseNumberRange: range } : {};

    // 邮编统一存在城市这一级（而不是每条街单独存一份），生成地址时从这个池子里随机挑一个。
    for (const pc of s.postcodes) {
      if (!cityNode.postcodes.includes(pc)) cityNode.postcodes.push(pc);
    }
  }
  return root;
}

// 道路数量按"这个城市实际还需要多少条街道"动态计算，不再对每个城市都固定按同一个
// 宽松上限去请求——纽约/墨西哥城这类超大都会，路网随便一查就能轻松超过几百条，
// 但如果这次总共只要 60 条、分摊到 6 个城市每城只要 10 条左右，问它要几百条纯粹是浪费，
// 也是这类超大城市最容易 504 超时/被判定成爬虫的原因。
// ROADS_BUFFER_FACTOR / ADDR_BUFFER_FACTOR 是"多要一点做冗余"的倍数——
// 不是查到多少条道路就有多少条带门牌号证据，需要额外冗余才能保证优先挑选逻辑有得选。
const ROADS_BUFFER_FACTOR = 3; // 道路：只是确认"这条街真实存在"，冗余倍数不用太高
const ADDR_BUFFER_FACTOR = 30; // 地址点：很多地址点才能换来一条街的门牌号证据，需要更大冗余
const MIN_ROADS_QUERY = 15;
const MIN_ADDR_QUERY = 100;

function computeDynamicCaps(neededCount, opts) {
  return {
    maxRoads: Math.min(opts.maxRoadsPerCity, Math.max(MIN_ROADS_QUERY, neededCount * ROADS_BUFFER_FACTOR)),
    maxAddrPoints: Math.min(opts.maxAddrPointsPerCity, Math.max(MIN_ADDR_QUERY, neededCount * ADDR_BUFFER_FACTOR)),
  };
}

async function fetchStreetsForCity(city, radius, opts, neededCount) {
  const { maxRoads, maxAddrPoints } = computeDynamicCaps(neededCount, opts);
  const query = buildOverpassQuery(city.lat, city.lon, radius, { maxRoads, maxAddrPoints });
  const elements = await queryOverpassWithRetry(query, opts.userAgent);
  const streetsMap = extractStreetsFromElements(elements);
  return [...streetsMap.values()];
}

// ============================== 主流程 ==============================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });

  // 之前只是打个警告然后照样跑，结果这个警告被连续忽略了好几轮——现在改成硬性要求：
  // 没有提供合法的 User-Agent 就直接拒绝执行，而不是把"信号越像爬虫就越容易被拦"的
  // 责任丢给日志里一行容易被滚动过去的提示。
  opts.userAgent = resolveUserAgent(opts.userAgent);
  if (!opts.userAgent || opts.userAgent.includes('CHANGE_ME')) {
    console.error(
      '[错误] 没有提供有效的 User-Agent，拒绝执行。\n' +
        '  Overpass/OSM 社区要求请求方能被识别身份，缺失或占位符 User-Agent 是触发\n' +
        '  "疑似爬虫"拦截（HTTP 406）的直接因素之一。\n' +
        '  请用以下任一方式提供：\n' +
        '    1) 命令行参数: --user-agent "your-project/1.0 (contact: you@example.com)"\n' +
        '    2) 环境变量:   OVERPASS_USER_AGENT="your-project/1.0 (contact: you@example.com)"'
    );
    process.exit(1);
  }

  const { citiesTxt, admin1Txt } = ensureGeonamesFiles(opts.workDir);
  const admin1Map = loadAdmin1Names(admin1Txt);
  const citiesByCountry = loadCitiesForCountries(citiesTxt, admin1Map, opts.countries, opts.citiesPerCountry);

  const outPath = path.join(opts.outDir, 'addresses.json');
  const merged = {
    generatedAt: new Date().toISOString(),
    dataSources: {
      cities: 'GeoNames cities15000 (CC-BY 4.0, https://www.geonames.org/)',
      streets: 'OpenStreetMap via Overpass API (ODbL, https://www.openstreetmap.org/copyright)',
    },
    // 每个国家的轻量统计，方便快速核对，不用为了看一眼数量就把整个 countries 树都读一遍。
    meta: { limitPerCountry: opts.limit, countries: {} },
    countries: {},
  };

  for (const cc of opts.countries) {
    const cities = citiesByCountry.get(cc) || [];
    if (cities.length === 0) {
      console.warn(`⚠️ ${cc}: GeoNames 里没有找到符合条件的城市，跳过`);
      continue;
    }

    console.log(`::group::======== [ ${cc} ] ========`);
    const citiesWithStreets = [];
    // 这个国家一共 opts.limit 条，平分到每个城市大概需要多少条——查询上限按这个动态算，
    // 而不是不管三七二十一都按同一个宽松封顶去问 Overpass 要整座城市的路网。
    const neededPerCity = Math.ceil(opts.limit / cities.length);

    for (const city of cities) {
      const radius = radiusForPopulation(city.population, opts.radiusMetersOverride);
      console.log(`[overpass] ${cc} / ${city.name} (人口 ${city.population.toLocaleString()}, 半径 ${radius}m) 查询中 ...`);

      let streets = null;
      try {
        streets = await fetchStreetsForCity(city, radius, opts, neededPerCity);
      } catch (firstError) {
        // 全尺寸半径在所有镜像上都失败了，不直接放弃这个城市——用更小的半径
        // （约40%，请求更轻，服务器处理更快，更不容易 504/被判定为爬虫）再试一次。
        const fallbackRadius = Math.max(2000, Math.round(radius * 0.4));
        console.warn(
          `  ⚠️ ${city.name} 全尺寸查询失败(${firstError.message})，用更小的半径 ${fallbackRadius}m 重试一次 ...`
        );
        try {
          streets = await fetchStreetsForCity(city, fallbackRadius, opts, neededPerCity);
          console.warn(`  ↳ ${city.name} 缩小半径后成功了`);
        } catch (secondError) {
          console.warn(`  ⚠️ ${city.name} 缩小半径后依然失败，跳过该城市: ${secondError.message}`);
        }
      }

      if (streets) {
        if (streets.length < opts.minStreetsWarn) {
          console.warn(`  ⚠️ ${city.name} 只采集到 ${streets.length} 条街道，可能 OSM 在当地标注较少`);
        } else {
          console.log(`  ✓ ${city.name}: 采集到 ${streets.length} 条不同街道`);
        }
        citiesWithStreets.push({ city: city.name, admin1: city.admin1, streets });
      }

      // 加一点随机抖动（0~1.5秒）——完全固定的请求间隔本身也是容易被识别成脚本的
      // 特征之一，抖动一下让请求节奏更接近真人操作。
      await sleep(opts.overpassDelayMs + Math.floor(Math.random() * 1500));
    }

    const picked = pickStreetsRoundRobin(citiesWithStreets, opts.limit);
    const cityCount = citiesWithStreets.filter((c) => c.streets.length > 0).length;

    merged.countries[cc] = buildTreeJSON(cc, picked);
    merged.meta.countries[cc] = { streetCount: picked.length, cityCount };

    // 每处理完一个国家就把整份合并文件重新落盘一次——20 个国家全跑完可能要不少时间，
    // 中途失败/被取消的话，已经跑完的国家不会白跑，文件里已经有数据了。
    fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');

    console.log(`✅ ${cc}: 抽取 ${picked.length} 条真实街道，来自 ${cityCount} 个人口密集城市`);
    console.log('::endgroup::');
  }

  console.log(`🎯 采集结束，数据在: ${outPath}`);
}

main().catch((error) => {
  console.error('[collect-streets-overpass] 脚本执行失败', error);
  process.exit(1);
});
