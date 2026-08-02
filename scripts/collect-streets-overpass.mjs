#!/usr/bin/env node
/**
 * 基于 GeoNames(选城市) + Overpass API(拉街道)的离线街道 JSON 采集脚本。
 *
 * 彻底替代之前"daimon3332/address + Overture Maps + DuckDB"那一整套流水线：
 * - 不再需要 Python / DuckDB / sqlite / 第三方仓库 / GitHub Actions 里一堆 ETL 步骤。
 * - 城市选择：用 GeoNames 官方免费数据集（cities15000.zip，人口 >= 1.5 万的全球城市，
 *   CC-BY 4.0 协议）按真实人口数排序，每个国家取人口最多的若干个城市——这是真实人口数据，
 *   比之前"街道组数量"这种代理指标要准确。
 * - 街道数据：对每个选中的城市，直接向 Overpass API（OpenStreetMap 的查询接口）发一次
 *   基于经纬度半径的查询，拿该城市范围内所有有名字的道路，以及带门牌号/邮编标注的地址点。
 *
 * 需要老实说明的数据现实（和之前方案相比的取舍）：
 * 1. 门牌号/邮编覆盖率取决于 OpenStreetMap 在当地的标注完整度，参差不齐——欧洲/日韩这类
 *    国家通常标注率高，东南亚/南美一些城市会明显偏低。没有门牌号证据的街道，range 字段会是
 *    空字符串，但街道本身（来自道路网络数据）依然会被采集，不会像之前的质量门那样直接整条丢弃。
 * 2. 输出里不再有"district"这一级（Overpass 的半径查询不返回行政区划细分），统一填 '-'，
 *    和原脚本在 district 缺失时的兜底行为一致。
 * 3. OpenStreetMap 数据协议是 ODbL（需要署名 + 派生数据库同样开放），GeoNames 是 CC-BY 4.0
 *    （需要署名）。这点和之前用的 Overture Maps（CDLA Permissive 2.0，基本无限制）不一样，
 *    如果你要对外分发这份数据，请附上署名。
 * 4. Overpass 是社区免费运营的公共服务，有"合理使用"的隐性限制，不是无限量 API。脚本里对
 *    每次查询之间做了限速（默认 1.5 秒一次），并且必须设置一个能表明身份的 User-Agent
 *    （见下面 USER_AGENT 常量，请求你改成能联系到你的信息，而不是用默认占位符）。
 *
 * 用法：
 *   node collect-streets-overpass.mjs --out offline-addresses \
 *     [--countries US,CA,MX,...] [--cities-per-country 6] [--limit 300] \
 *     [--min-streets-warn 5] [--work-dir .geonames-cache] [--overpass-delay-ms 1500]
 *
 * 建议先用 --countries US --cities-per-country 1 只测一个国家一个城市，确认真实数据没问题，
 * 再跑全量。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ============================== 配置 ==============================

// 必须改成你自己的信息（项目地址或联系邮箱都行）——Overpass/OSM 社区要求请求方
// 表明身份，用默认占位符长期高频请求，容易被公共实例限流或拉黑。
const USER_AGENT = 'offline-streets-collector/1.0 (contact: CHANGE_ME@example.com)';

const GEONAMES_CITIES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const GEONAMES_ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';

// 多个 Overpass 公共实例，主实例失败/被限流时按顺序尝试下一个。
//
// 关于 HTTP 406：这不是限流也不是查询语法问题。2025-2026 年 overpass-api.de 主实例
// 因为被大量 AI 爬虫流量冲击，加了一套"请求特征"过滤，命中了就直接拒绝——对同一台服务器
// 重试拿到的是一模一样的拒绝，唯一有效的办法是换一台服务器（见下面 queryOverpassWithRetry
// 里 406 分支的处理：不重试同一个 endpoint，直接跳下一个）。这里多放一个镜像兜底。
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const DEFAULT_COUNTRIES = [
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU',
  'JP', 'KR', 'SG', 'VN', 'TH', 'PH', 'MY', 'IN', 'AU', 'BR',
];

// ============================== 工具函数 ==============================

function parseArgs(argv) {
  const out = {
    outDir: 'offline-addresses',
    countries: DEFAULT_COUNTRIES,
    citiesPerCountry: 6,
    limit: 300,
    minStreetsWarn: 5,
    workDir: '.geonames-cache',
    overpassDelayMs: 2000,
    radiusMetersOverride: null,
    // 单次查询里，Overpass 最多返回多少条"道路"/多少个"带门牌号的地址点"。
    // 之前没设上限，纽约一个城市就采回 7268 条街道、墨西哥城 25166 条——
    // 远超实际需要（每城市最终只要 limit/citiesPerCountry 条左右），
    // 白白拖慢查询、加重公共 Overpass 服务器负担，还更容易触发限流/反爬拒绝。
    maxRoadsPerCity: 600,
    maxAddrPointsPerCity: 4000,
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
    else if (a === '--max-roads-per-city') out.maxRoadsPerCity = Number(argv[++i]);
    else if (a === '--max-addr-points-per-city') out.maxAddrPointsPerCity = Number(argv[++i]);
  }
  return out;
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

// 门牌号压缩：按连续数字压缩合并（例如 [1,2,3,5] -> "1-3, 5"）。与原脚本逻辑保持一致。
function compressHouseNumbers(numbers) {
  const nums = Array.from(
    new Set(
      numbers
        .map((n) => String(n).trim())
        .filter(Boolean)
        .map((n) => (Number.isFinite(Number(n)) ? Number(n) : n))
    )
  );
  const numeric = nums.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const nonNumeric = nums.filter((n) => typeof n !== 'number').sort();

  const ranges = [];
  let start = null;
  let prev = null;
  for (const n of numeric) {
    if (start === null) {
      start = n;
      prev = n;
    } else if (n === prev + 1) {
      prev = n;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = n;
      prev = n;
    }
  }
  if (start !== null) ranges.push(start === prev ? `${start}` : `${start}-${prev}`);

  return [...ranges, ...nonNumeric].join(', ');
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
  if (population >= 5_000_000) return 10_000;
  if (population >= 1_000_000) return 8_000;
  if (population >= 300_000) return 6_000;
  return 5_000;
}

// ============================== 第二步：Overpass 查询 & 解析 ==============================

// 只保留真正可以作为邮寄地址的道路类型，排除自行车道/人行道/台阶/小径这些——
// 之前没做这个过滤，us.json 里能看到 "Williamsburg Bridge Bike Path" 这种明显不是
// 邮寄地址的东西混进了结果。
const ADDRESSABLE_HIGHWAY_TYPES = 'residential|living_street|unclassified|tertiary|secondary|primary|road';

function buildOverpassQuery(lat, lon, radiusMeters, { maxRoads, maxAddrPoints }) {
  // 用命名集合(->.roads 等)把"道路"和"带门牌号的地址点"分开统计、分开限流：
  // 如果只在最后统一用一个 out 数量上限，道路数据量一大就会把地址点的配额挤占掉，
  // 导致门牌号证据反而采不到。分开限流之后两者互不影响。
  return `[out:json][timeout:60];
way(around:${radiusMeters},${lat},${lon})["highway"~"^(${ADDRESSABLE_HIGHWAY_TYPES})$"]["name"]->.roads;
node(around:${radiusMeters},${lat},${lon})["addr:housenumber"]["addr:street"]->.addrNodes;
way(around:${radiusMeters},${lat},${lon})["addr:housenumber"]["addr:street"]->.addrWays;
.roads out tags center ${maxRoads};
.addrNodes out tags ${maxAddrPoints};
.addrWays out tags center ${Math.round(maxAddrPoints / 2)};`;
}

async function queryOverpassWithRetry(query, { maxAttemptsPerEndpoint = 2 } = {}) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= maxAttemptsPerEndpoint; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'User-Agent': USER_AGENT,
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
          // 429/504 才是真的限流/服务器端超时，退避后重试同一个实例，不行再换下一个实例
          const backoffMs = 3000 * attempt;
          console.warn(`[overpass] ${endpoint} 返回 ${response.status}，${backoffMs}ms 后重试`);
          await sleep(backoffMs);
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
        await sleep(1000 * attempt);
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
      ensure(el.tags.name);
    }
  }

  // 第二遍：带门牌号标注的地址点/建筑物，按 addr:street 归到对应街道上。
  // 即使这个街道名没有在第一遍里出现（比如查询半径边缘只碰到了地址点没碰到路），
  // 只要有门牌号证据，也认为它是一条真实存在的街道，一并采集。
  for (const el of elements) {
    const street = el.tags?.['addr:street'];
    const houseNumber = el.tags?.['addr:housenumber'];
    if (!street || !houseNumber) continue;
    const entry = ensure(street);
    if (!entry) continue;

    // OSM 里偶尔会出现一个字段填了多个值、用分号隔开的情况（比如某个地址正好横跨
    // 两个邮编分区，被标注成 "90013;90015"）。之前直接把整串当一个邮编存了进去，
    // 这里按分号拆开，当成多个独立候选。
    for (const hn of String(houseNumber).split(';').map((s) => s.trim()).filter(Boolean)) {
      entry.houseNumbers.add(hn);
    }
    const postcodeRaw = el.tags?.['addr:postcode'];
    if (postcodeRaw) {
      for (const pc of String(postcodeRaw).split(';').map((s) => s.trim()).filter(Boolean)) {
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
      const addressed = shuffleInPlace(c.streets.filter((s) => s.houseNumbers.size > 0));
      const nameOnly = shuffleInPlace(c.streets.filter((s) => s.houseNumbers.size === 0));
      return { ...c, streets: [...addressed, ...nameOnly], idx: 0 };
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

function buildTreeJSON(countryCode, picked) {
  const root = {};
  for (const s of picked) {
    const a1 = s.admin1 || '-';
    const city = s.city || '-';
    const district = '-'; // Overpass 半径查询不返回行政区划细分，统一填 '-'

    root[a1] ??= {};
    root[a1][city] ??= {
      _meta: {
        // 注意：phonePrefix 是根据国家+城市名生成的固定哈希前缀，纯粹为了让生成出来的
        // 电话号码"看起来合理"，不是真实的电信局分配的区号，不能当真实数据使用。
        phonePrefix: generateCityPhonePrefix(countryCode, city),
        postcodes: [],
      },
    };
    root[a1][city][district] ??= {};

    const postcodeList = [...s.postcodes];
    const houseNumberList = [...s.houseNumbers];
    root[a1][city][district][s.rawName] = {
      postcode: postcodeList[0] || '',
      range: compressHouseNumbers(houseNumberList),
      // 原始门牌号数组，未压缩。生成具体地址时直接从这里随机取一个真实门牌号即可，
      // 不需要反解析 range 那个压缩字符串（"1-3, 5" 这种格式）。为空说明这条街
      // 在采集范围内没有找到任何门牌号标注，生成地址时需要自行决定兜底策略
      // （比如随机造一个 1-200 的数字，但那就是纯虚构的了，不是真实数据）。
      houseNumbers: houseNumberList,
    };

    for (const pc of postcodeList) {
      if (!root[a1][city]._meta.postcodes.includes(pc)) {
        root[a1][city]._meta.postcodes.push(pc);
      }
    }
  }
  return { [countryCode]: root };
}

// ============================== 主流程 ==============================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });

  if (USER_AGENT.includes('CHANGE_ME')) {
    console.warn(
      '[警告] USER_AGENT 还是默认占位符，请改成能联系到你的信息（邮箱/项目地址），' +
        '否则高频请求公共 Overpass 实例容易被限流或拉黑。'
    );
  }

  const { citiesTxt, admin1Txt } = ensureGeonamesFiles(opts.workDir);
  const admin1Map = loadAdmin1Names(admin1Txt);
  const citiesByCountry = loadCitiesForCountries(citiesTxt, admin1Map, opts.countries, opts.citiesPerCountry);

  const index = {
    generatedAt: new Date().toISOString(),
    mode: 'overpass-population-based',
    dataSources: {
      cities: 'GeoNames cities15000 (CC-BY 4.0, https://www.geonames.org/)',
      streets: 'OpenStreetMap via Overpass API (ODbL, https://www.openstreetmap.org/copyright)',
    },
    limitPerCountry: opts.limit,
    countries: {},
  };
  const indexPath = path.join(opts.outDir, 'index.json');

  for (const cc of opts.countries) {
    const cities = citiesByCountry.get(cc) || [];
    if (cities.length === 0) {
      console.warn(`⚠️ ${cc}: GeoNames 里没有找到符合条件的城市，跳过`);
      continue;
    }

    console.log(`::group::======== [ ${cc} ] ========`);
    const citiesWithStreets = [];

    for (const city of cities) {
      const radius = radiusForPopulation(city.population, opts.radiusMetersOverride);
      console.log(`[overpass] ${cc} / ${city.name} (人口 ${city.population.toLocaleString()}, 半径 ${radius}m) 查询中 ...`);
      try {
        const query = buildOverpassQuery(city.lat, city.lon, radius, {
          maxRoads: opts.maxRoadsPerCity,
          maxAddrPoints: opts.maxAddrPointsPerCity,
        });
        const elements = await queryOverpassWithRetry(query);
        const streetsMap = extractStreetsFromElements(elements);
        const streets = [...streetsMap.values()];

        if (streets.length < opts.minStreetsWarn) {
          console.warn(`  ⚠️ ${city.name} 只采集到 ${streets.length} 条街道，可能 OSM 在当地标注较少`);
        } else {
          console.log(`  ✓ ${city.name}: 采集到 ${streets.length} 条不同街道`);
        }

        citiesWithStreets.push({ city: city.name, admin1: city.admin1, streets });
      } catch (error) {
        console.warn(`  ⚠️ ${city.name} Overpass 查询失败，跳过该城市: ${error.message}`);
      }

      await sleep(opts.overpassDelayMs); // 限速，善待公共 Overpass 实例
    }

    const picked = pickStreetsRoundRobin(citiesWithStreets, opts.limit);
    const totalAvailable = citiesWithStreets.reduce((sum, c) => sum + c.streets.length, 0);

    const file = `${cc.toLowerCase()}.json`;
    const treeData = buildTreeJSON(cc, picked);
    fs.writeFileSync(path.join(opts.outDir, file), JSON.stringify(treeData, null, 2), 'utf8');

    index.countries[cc] = {
      file,
      streetCount: picked.length,
      totalAvailable,
      cityCount: citiesWithStreets.filter((c) => c.streets.length > 0).length,
      cities: cities.map((c) => c.name),
    };
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

    console.log(`✅ ${cc}: 抽取 ${picked.length}/${totalAvailable} 条真实街道，来自 ${citiesWithStreets.length} 个人口密集城市 -> ${file}`);
    console.log('::endgroup::');
  }

  console.log(`🎯 采集结束，数据均在: ${opts.outDir}`);
}

main().catch((error) => {
  console.error('[collect-streets-overpass] 脚本执行失败', error);
  process.exit(1);
});
