#!/usr/bin/env node
/**
 * 从 collect-streets-overpass.mjs 采集到的 addresses.json 里随机生成完整地址（含电话、邮编）。
 *
 * 用法：
 *   node generate-address-example.mjs offline-addresses/addresses.json [国家代码，如 US] [生成条数，默认1]
 *   国家代码留空则从文件里已有的国家中随机挑一个。
 *
 * 老实说明数据可信度：
 * - 国家/省(admin1)/城市/街道名 —— 真实数据（来自 GeoNames + OpenStreetMap）。
 * - 门牌号 —— 街道有 houseNumberRange 时，在这个区间里随机取一个整数（区间内的具体数字不保证
 *   每一个都真实存在，只保证这是从真实观测到的门牌号里提炼出的范围）；街道没有 houseNumberRange
 *   （对应原始数据里 streets[街道] 是空对象）时，退化成随机生成一个 1-200 的数字，这部分纯虚构，
 *   结果里用 houseNumberInRange:false 标出来。
 * - 邮编 —— 从该城市的 postcodes 候选池里随机挑一个，池子是城市级的，不精确对应到具体某条街，
 *   大城市横跨多个邮区时可能对不上，这是设计上的取舍（避免每条街都存一份重复邮编）。
 * - 电话号码 —— 完全是根据城市名生成的合成前缀 + 随机数字，不是真实电信区号分配，仅用于让
 *   生成结果"看起来像"一个电话号码。
 */

import fs from 'node:fs';

function randomItem(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomIntInRange([min, max]) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomPhoneNumber(prefix) {
  const rest = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
  return `${prefix}-${rest}`;
}

function generateOneAddress(countryCode, countryTree) {
  const admin1Keys = Object.keys(countryTree);
  const admin1 = randomItem(admin1Keys);
  const cityKeys = Object.keys(countryTree[admin1]);
  const city = randomItem(cityKeys);
  const cityNode = countryTree[admin1][city];

  const streetKeys = Object.keys(cityNode.streets);
  const streetName = randomItem(streetKeys);
  const street = cityNode.streets[streetName];

  let houseNumber;
  let houseNumberInRange;
  if (street.houseNumberRange) {
    houseNumber = randomIntInRange(street.houseNumberRange);
    houseNumberInRange = true;
  } else {
    houseNumber = Math.floor(1 + Math.random() * 200);
    houseNumberInRange = false; // 虚构的，这条街没有真实门牌号范围数据
  }

  const postcode = randomItem(cityNode.postcodes) || '';
  const phone = randomPhoneNumber(cityNode.phonePrefix || '000');

  return {
    country: countryCode,
    admin1,
    city,
    street: streetName,
    houseNumber,
    houseNumberInRange,
    postcode,
    phone,
    formatted: `${houseNumber} ${streetName}, ${city}, ${admin1} ${postcode}, ${countryCode}`,
  };
}

function main() {
  const [, , filePath, countryArg, countArg] = process.argv;
  if (!filePath) {
    console.error('用法: node generate-address-example.mjs offline-addresses/addresses.json [国家代码] [生成条数]');
    process.exit(1);
  }

  const merged = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const availableCountries = Object.keys(merged.countries || {});
  if (availableCountries.length === 0) {
    console.error('文件里没有任何国家的数据');
    process.exit(1);
  }

  // 第二个参数如果是数字，说明用户跳过了国家代码直接给了生成条数（国家随机选）
  const countryCode = countryArg && Number.isNaN(Number(countryArg)) ? countryArg.toUpperCase() : null;
  const count = Number(countryCode ? countArg : countryArg) || 1;

  for (let i = 0; i < count; i++) {
    const cc = countryCode || randomItem(availableCountries);
    if (!merged.countries[cc]) {
      console.error(`文件里没有 ${cc} 的数据，可选：${availableCountries.join(', ')}`);
      process.exit(1);
    }
    const addr = generateOneAddress(cc, merged.countries[cc]);
    console.log(JSON.stringify(addr, null, 2));
  }
}

main();
