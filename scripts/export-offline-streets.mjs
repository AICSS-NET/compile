/**
 * 从 daimon3332/address 的 address.sqlite 导出离线街道 JSON
 *
 * 【重构优化版 v3 - 20国定制混合版】
 * - 强制固定输出限制：每个国家绝对抽取 300 条数据。
 * - 数据结构扁平改树形：Country -> Admin1 -> Locality -> District -> Street -> { postcode, range, ... }
 * - 特性增强：在 Locality(城市) 层级自动注入 _meta 元数据，包含生成的固定电话区号前缀以及该市所有邮编。
 * - 门牌号(houseNumbers) 压缩：按连续数字压缩合并（例如 [1,2,3,5] -> "1-3, 5"）
 * - 提取策略（Round-Robin）：多省市轮流循环均匀抽取，缺额自动补足，保证分布极其均匀。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 固定需求：不管什么情况，每个国家固定抽取 300 条
const FIXED_LIMIT = 300;

function parseArgs(argv) {
  const out = {
    db: process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite',
    outDir: 'offline-addresses',
    countries: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--out') out.outDir = argv[++i];
    // 兼容 --country 和 --countries 确保工作流参数能够正确被解析
    else if (a === '--countries' || a === '--country') {
      out.countries = argv[++i]
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return out;
}

// 基于国家和城市名字生成一个固定的电话区号前缀
function generateCityPhonePrefix(countryCode, city) {
  // 核心20国的国际区号映射
  const ccMap = {
    'US': '1', 'CA': '1', 'GB': '44', 'DE': '49', 'FR': '33', 'IT': '39',
    'ES': '34', 'NL': '31', 'RU': '7', 'JP': '81', 'KR': '82', 'SG': '65',
    'VN': '84', 'TH': '66', 'PH': '63', 'MY': '60', 'IN': '91', 'AU': '61',
    'BR': '55', 'MX': '52'
  };
  
  // 使用简单的 Hash 算法，确保同一个城市（字母排列相同）每次运行生成的区号都绝对一致
  let hash = 0;
  const str = String(city).toUpperCase();
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // 生成 2-3 位的固定区号 (100 - 999)
  const areaCode = Math.abs(hash) % 900 + 100;
  const cc = ccMap[countryCode] || '00';
  
  // 输出示例: "+1 213" 或 "+44 802" 等特征前缀
  return `+${cc} ${areaCode}`;
}

function normKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('und');
}

function streetGroupKey(row) {
  return [
    row.country_code,
    normKey(row.admin1),
    normKey(row.locality),
    normKey(row.district),
    normKey(row.postcode),
    normKey(row.street),
  ].join('\u001f');
}

function recordDedupeKey(s) {
  return [
    s.country,
    normKey(s.admin1),
    normKey(s.locality),
    normKey(s.district),
    normKey(s.postcode),
    normKey(s.street),
  ].join('\u001f');
}

function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function pickLangVariants(raw, mode) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const lang of ['native', 'en']) {
    const v = raw[lang];
    if (v == null) continue;
    if (mode === 'address') {
      const s = String(v).trim();
      if (s) out[lang] = s;
    } else if (mode === 'component' && typeof v === 'object' && !Array.isArray(v)) {
      const cleaned = {};
      for (const [k, val] of Object.entries(v)) {
        if (val == null) continue;
        const s = String(val).trim();
        if (s) cleaned[k] = s;
      }
      if (Object.keys(cleaned).length) out[lang] = cleaned;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function listCountries(db) {
  return db
    .prepare(`SELECT DISTINCT country_code AS c FROM address_pool WHERE active = 1 ORDER BY 1`)
    .all()
    .map((r) => r.c);
}

// 核心：门牌号连续压缩合并 (例如: [1, 2, 3, 5, "12A"] -> "1-3, 5, 12A")
function compressHouseNumbers(arr) {
  if (!arr || !arr.length) return "";
  const nums = [];
  const nonNums = [];
  
  for (const val of arr) {
    const str = String(val).trim();
    if (!str) continue;
    const n = parseInt(str, 10);
    // 判断是否是纯数字（防止 "12A" 变成 1 被错误压缩）
    if (String(n) === str) {
      nums.push(n);
    } else {
      nonNums.push(str);
    }
  }
  
  nums.sort((a, b) => a - b);
  nonNums.sort((a, b) => a.localeCompare(b, 'und', { numeric: true }));

  const ranges = [];
  if (nums.length > 0) {
    let start = nums[0];
    let end = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === end + 1) {
        end = nums[i]; // 连续，拓展区间
      } else if (nums[i] > end) { // 遇到断层
        ranges.push(start === end ? String(start) : `${start}-${end}`);
        start = nums[i];
        end = nums[i];
      }
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return [...ranges, ...nonNums].join(', ');
}

// 核心：三级水桶轮询抽样算法
function pickStreetsRoundRobin(streets, limit) {
  const tree = new Map(); // admin1 -> Map(locality -> array of streets)
  for (const s of streets) {
    const a1 = normKey(s.admin1) || normKey(s.admin1Code) || '-';
    const loc = normKey(s.locality) || '-';

    if (!tree.has(a1)) tree.set(a1, new Map());
    const a1Map = tree.get(a1);
    if (!a1Map.has(loc)) a1Map.set(loc, []);
    a1Map.get(loc).push(s);
  }

  const pool = [];
  for (const [a1, locMap] of tree.entries()) {
    const localities = [];
    const locKeys = Array.from(locMap.keys());
    shuffleInPlace(locKeys);

    let a1Total = 0;
    for (const loc of locKeys) {
      const locStreets = locMap.get(loc);
      shuffleInPlace(locStreets);
      // 限制 1：单城市最大 100 条（打散城市集中度）
      const capped = locStreets.slice(0, 100);
      a1Total += capped.length;
      localities.push({ key: loc, streets: capped });
    }

    // 限制 2：单省份最大 1000 条（防止加州等超级大州吃光配额）
    if (a1Total > 1000) {
      let kept = 0;
      for (const locState of localities) {
        const space = 1000 - kept;
        if (space <= 0) {
          locState.streets = [];
        } else if (locState.streets.length > space) {
          locState.streets = locState.streets.slice(0, space);
          kept = 1000;
        } else {
          kept += locState.streets.length;
        }
      }
    }

    const validLocalities = localities.filter(l => l.streets.length > 0);
    if (validLocalities.length > 0) {
      pool.push({ key: a1, localities: validLocalities, locIdx: 0 });
    }
  }

  // 打乱省份顺序
  shuffleInPlace(pool);

  const picked = [];
  const seen = new Set();
  let progress = true;

  // 开始抽牌轮询
  while (picked.length < limit && progress && pool.length > 0) {
    progress = false;
    for (let i = 0; i < pool.length; i++) {
      if (picked.length >= limit) break;
      const a1State = pool[i];
      if (a1State.localities.length === 0) continue;

      const locState = a1State.localities[a1State.locIdx];

      // 拿取该城市中一条未见过的数据
      let street = null;
      while (locState.streets.length > 0) {
        const s = locState.streets.pop();
        const key = recordDedupeKey(s);
        if (!seen.has(key)) {
          seen.add(key);
          street = s;
          break;
        }
      }

      if (street) {
        picked.push(street);
        progress = true;
      }

      // 移动游标或剔除耗尽的城市
      if (locState.streets.length === 0) {
        a1State.localities.splice(a1State.locIdx, 1);
        if (a1State.locIdx >= a1State.localities.length) {
          a1State.locIdx = 0; // Wrap around
        }
      } else {
        a1State.locIdx = (a1State.locIdx + 1) % a1State.localities.length;
      }
    }

    // 剔除耗尽的省份
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].localities.length === 0) pool.splice(i, 1);
    }
  }
  return picked;
}

function loadStreetGroups(db, countryCode) {
  const rows = db
    .prepare(
      `
    SELECT
      country_code, admin1, admin1_code, locality, postal_locality, district,
      postcode, street, house_number, building_name, property_type,
      native_language, component_variants_json, address_variants_json, quality_score
    FROM address_pool
    WHERE active = 1
      AND country_code = ?
      AND length(trim(street)) > 0
      AND length(trim(house_number)) > 0
  `
    )
    .all(countryCode);

  const groups = new Map();

  for (const row of rows) {
    const key = streetGroupKey(row);
    let g = groups.get(key);
    if (!g) {
      g = {
        country: row.country_code,
        admin1: row.admin1 || '',
        admin1Code: row.admin1_code || '',
        locality: row.locality || '',
        postalLocality: row.postal_locality || '',
        district: row.district || '',
        postcode: row.postcode || '',
        street: row.street || '',
        nativeLanguage: row.native_language || '',
        houseNumbers: new Set(),
        buildingNames: new Set(),
        propertyTypes: new Map(),
        bestQuality: -1,
      };
      groups.set(key, g);
    }

    g.houseNumbers.add(String(row.house_number).normalize('NFKC').trim());
    
    const bn = String(row.building_name || '').trim();
    if (bn) g.buildingNames.add(bn);

    const pt = row.property_type || 'unknown';
    g.propertyTypes.set(pt, (g.propertyTypes.get(pt) || 0) + 1);

    const q = Number(row.quality_score) || 0;
    if (q >= g.bestQuality) {
      g.bestQuality = q;
      g.addressVariants = pickLangVariants(parseJson(row.address_variants_json), 'address');
      g.componentVariants = pickLangVariants(parseJson(row.component_variants_json), 'component');
    }
  }

  return [...groups.values()].map((g) => {
    let propertyType = 'unknown';
    let best = -1;
    for (const [pt, n] of g.propertyTypes) {
      if (n > best) {
        best = n;
        propertyType = pt;
      }
    }
    return {
      country: g.country,
      admin1: g.admin1,
      admin1Code: g.admin1Code,
      locality: g.locality,
      postalLocality: g.postalLocality,
      district: g.district,
      postcode: g.postcode,
      street: g.street,
      houseNumbers: [...g.houseNumbers],
      buildingNames: [...g.buildingNames].sort((a, b) => a.localeCompare(b, 'und')),
      propertyType: propertyType === 'unknown' ? '' : propertyType,
      nativeLanguage: g.nativeLanguage,
      address: g.addressVariants,
      components: g.componentVariants,
    };
  });
}

// 核心：构建树形 JSON 对象 (按层级嵌套，加入 _meta 城市级数据)
function buildTreeJSON(streets) {
  const tree = {};
  for (const s of streets) {
    const c = (s.country || '-').toUpperCase();
    const a1 = s.admin1 ? s.admin1 : (s.admin1Code ? s.admin1Code : '-');
    const loc = s.locality ? s.locality : '-';
    const dist = s.district ? s.district : '-';
    let streetName = s.street ? s.street : '-';

    if (!tree[c]) tree[c] = {};
    if (!tree[c][a1]) tree[c][a1] = {};
    
    // 初始化 Locality 层级，并注入 _meta (固话区号和邮编库)
    if (!tree[c][a1][loc]) {
      tree[c][a1][loc] = {
        _meta: {
          cityPhonePrefix: generateCityPhonePrefix(c, loc),
          postcodes: [] 
        }
      };
    }
    
    if (!tree[c][a1][loc][dist]) tree[c][a1][loc][dist] = {};

    // 收集该城市下所有出现过的邮编到 _meta.postcodes
    if (s.postcode && !tree[c][a1][loc]._meta.postcodes.includes(s.postcode)) {
      tree[c][a1][loc]._meta.postcodes.push(s.postcode);
    }

    // 冲突防御：极小概率下同区同名街道但邮编不同
    if (tree[c][a1][loc][dist][streetName] && tree[c][a1][loc][dist][streetName].postcode !== s.postcode) {
      streetName = `${streetName} (zip:${s.postcode || 'null'})`;
    }

    // 组装最终最精简的街道节点
    const node = {
      postcode: s.postcode || "",
      range: compressHouseNumbers(s.houseNumbers)
    };
    if (s.propertyType) node.propertyType = s.propertyType;
    if (s.nativeLanguage) node.nativeLanguage = s.nativeLanguage;
    if (s.address) node.address = s.address;
    if (s.components) node.components = s.components;
    if (s.postalLocality) node.postalLocality = s.postalLocality;
    if (s.buildingNames && s.buildingNames.length > 0) node.buildingNames = s.buildingNames;

    tree[c][a1][loc][dist][streetName] = node;
  }
  return tree;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.db)) {
    console.error(`数据库不存在: ${opts.db}`);
    process.exit(1);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const db = openDb(opts.db);
  const countries = opts.countries?.length ? opts.countries : listCountries(db);

  // 安全追加模式：读取并更新统一的 index.json
  const indexPath = path.join(opts.outDir, 'index.json');
  let index;
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch { /* 忽略损坏 */ }
  }
  if (!index || index.mode !== 'tree-round-robin') {
    index = {
      generatedAt: new Date().toISOString(),
      mode: 'tree-round-robin',
      languages: ['native', 'en'],
      limitPerCountry: FIXED_LIMIT, // 强制固定为设定数量
      coordinates: false,
      countries: {},
    };
  }

  for (const cc of countries) {
    const all = loadStreetGroups(db, cc);
    // 强制按统一写死的数量上限（300条）进行均匀轮询抽取
    const picked = pickStreetsRoundRobin(all, FIXED_LIMIT);

    const admin1Set = new Set(picked.map((s) => s.admin1 || s.admin1Code || '').filter(Boolean));

    const file = `${cc.toLowerCase()}.json`;
    const treeData = buildTreeJSON(picked);

    fs.writeFileSync(path.join(opts.outDir, file), JSON.stringify(treeData, null, 2), 'utf8');

    // 实时更新当前国家的统计到主索引
    index.countries[cc] = {
      file,
      streetCount: picked.length,
      totalInDb: all.length,
      admin1Count: admin1Set.size,
    };
    // 确保写入的配置上限正确
    index.limitPerCountry = FIXED_LIMIT;
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

    console.log(`✅ ${cc}: 抽取 ${picked.length}/${all.length} 条真实街道, 均匀散布于 ${admin1Set.size} 个州/省 -> ${file}`);
  }

  db.close();
  console.log(`🎯 当前轮次导出结束，数据均在: ${opts.outDir}`);
}

main();
