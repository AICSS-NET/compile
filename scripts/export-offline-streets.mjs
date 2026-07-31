/**
 * 从 daimon3332/address 的 address.sqlite 导出离线街道 JSON
 *
 * - 按 国家+州+城市+区+邮编+街道 去重
 * - houseNumbers 仅含库中真实出现的门牌
 * - 按 admin1（州/省）轮询分散
 * - 语言只保留 native + en
 * - 空字段不写出；不含坐标
 *
 * 用法:
 *   node scripts/export-offline-streets.mjs
 *   node scripts/export-offline-streets.mjs --limit 300 --out offline-addresses
 *   node scripts/export-offline-streets.mjs --countries US,JP --limit 300
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseArgs(argv) {
  const out = {
    db: process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite',
    outDir: 'offline-addresses',
    limit: 300,
    countries: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 300);
    else if (a === '--countries') {
      out.countries = argv[++i]
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return out;
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

function compact(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const s = value.trim();
    return s === '' ? undefined : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const arr = value.map(compact).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cv = compact(v);
      if (cv !== undefined) out[k] = cv;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function listCountries(db) {
  return db
    .prepare(
      `SELECT DISTINCT country_code AS c FROM address_pool WHERE active = 1 ORDER BY 1`
    )
    .all()
    .map((r) => r.c);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickStreetsSpreadByAdmin1(streets, limit) {
  const byAdmin = new Map();
  for (const s of streets) {
    const k = normKey(s.admin1) || normKey(s.admin1Code) || '_unknown';
    if (!byAdmin.has(k)) byAdmin.set(k, []);
    byAdmin.get(k).push(s);
  }

  const buckets = [...byAdmin.values()];
  for (const b of buckets) shuffleInPlace(b);
  shuffleInPlace(buckets);

  const picked = [];
  const seen = new Set();
  let progress = true;
  while (picked.length < limit && progress) {
    progress = false;
    for (const bucket of buckets) {
      if (picked.length >= limit) break;
      while (bucket.length) {
        const s = bucket.pop();
        const key = recordDedupeKey(s);
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(s);
        progress = true;
        break;
      }
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
        addressVariants: undefined,
        componentVariants: undefined,
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
      g.street = row.street || g.street;
      g.admin1 = row.admin1 || g.admin1;
      g.admin1Code = row.admin1_code || g.admin1Code;
      g.locality = row.locality || g.locality;
      g.postalLocality = row.postal_locality || g.postalLocality;
      g.district = row.district || g.district;
      g.postcode = row.postcode || g.postcode;
      g.nativeLanguage = row.native_language || g.nativeLanguage;
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

    const record = {
      country: g.country,
      admin1: g.admin1,
      admin1Code: g.admin1Code,
      locality: g.locality,
      postalLocality: g.postalLocality,
      district: g.district,
      postcode: g.postcode,
      street: g.street,
      houseNumbers: [...g.houseNumbers].sort((a, b) =>
        a.localeCompare(b, 'und', { numeric: true })
      ),
      buildingNames: [...g.buildingNames].sort((a, b) => a.localeCompare(b, 'und')),
      propertyType: propertyType === 'unknown' ? '' : propertyType,
      nativeLanguage: g.nativeLanguage,
      address: g.addressVariants,
      components: g.componentVariants,
    };

    const compacted = compact(record) || {};
    if (!compacted.houseNumbers?.length) compacted.houseNumbers = record.houseNumbers;
    if (!compacted.country) compacted.country = g.country;
    if (!compacted.street) compacted.street = g.street;
    return compacted;
  });
}

function assertNoDuplicateStreets(streets, country) {
  const seen = new Set();
  for (const s of streets) {
    const key = recordDedupeKey(s);
    if (seen.has(key)) throw new Error(`重复街道: ${country} / ${s.street}`);
    seen.add(key);
  }
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

  const index = {
    generatedAt: new Date().toISOString(),
    mode: 'street-dedup-spread-admin1',
    languages: ['native', 'en'],
    limitPerCountry: opts.limit,
    coordinates: false,
    countries: {},
  };

  for (const cc of countries) {
    const all = loadStreetGroups(db, cc);
    const picked = pickStreetsSpreadByAdmin1(all, opts.limit);
    assertNoDuplicateStreets(picked, cc);

    const admin1Set = new Set(
      picked.map((s) => s.admin1 || s.admin1Code || '').filter(Boolean)
    );

    const file = `${cc.toLowerCase()}.json`;
    fs.writeFileSync(path.join(opts.outDir, file), JSON.stringify(picked), 'utf8');
    index.countries[cc] = {
      file,
      streetCount: picked.length,
      totalInDb: all.length,
      admin1Count: admin1Set.size,
    };
    console.log(
      `${cc}: streets ${picked.length}/${all.length}, admin1=${admin1Set.size} -> ${file}`
    );
  }

  fs.writeFileSync(
    path.join(opts.outDir, 'index.json'),
    JSON.stringify(index, null, 2),
    'utf8'
  );
  db.close();
  console.log(`done: ${opts.outDir}`);
}

main();
