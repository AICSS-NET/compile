#!/usr/bin/env node
/**
 * 从 collect-streets-overpass.mjs 采集到的 xx.json 里随机生成一条完整地址（含电话、邮编）。
 *
 * 用法：node generate-address-example.mjs offline-addresses/us.json [生成条数，默认1]
 *
 * 老实说明数据可信度：
 * - 国家/省(admin1)/城市/街道名 —— 真实数据（来自 GeoNames + OpenStreetMap）。
 * - 门牌号 —— 如果这条街采集到了 houseNumbers，就是真实观测到的门牌号；如果这条街没有
 *   门牌号证据（数组为空），这里会退化成随机生成一个 1-200 的数字，这部分是纯虚构的，
 *   生成结果里会用 houseNumberIsReal:false 标出来，不要当真实数据使用。
 * - 邮编 —— 优先用这条街自己的 postcode；没有的话退化成从该城市 _meta.postcodes 里随机挑
 *   一个"这个城市确实存在的邮编"，但不保证precisely对应这条街道，同样会标 postcodeIsExact:false。
 * - 电话号码 —— 完全是根据城市名生成的合成前缀 + 随机数字，不是真实电信区号分配，仅用于让
 *   生成结果"看起来像"一个电话号码。
 */

import fs from 'node:fs';

function randomItem(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomPhoneNumber(prefix) {
  const rest = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
  return `${prefix}-${rest}`;
}

function generateOneAddress(countryCode, data) {
  const admin1Keys = Object.keys(data);
  const admin1 = randomItem(admin1Keys);
  const cityKeys = Object.keys(data[admin1]);
  const city = randomItem(cityKeys);
  const cityNode = data[admin1][city];
  const cityMeta = cityNode._meta || {};

  const districtKeys = Object.keys(cityNode).filter((k) => k !== '_meta');
  const district = randomItem(districtKeys);
  const streetKeys = Object.keys(cityNode[district]);
  const streetName = randomItem(streetKeys);
  const street = cityNode[district][streetName];

  let houseNumber;
  let houseNumberIsReal;
  if (street.houseNumbers && street.houseNumbers.length > 0) {
    houseNumber = randomItem(street.houseNumbers);
    houseNumberIsReal = true;
  } else {
    houseNumber = String(Math.floor(1 + Math.random() * 200));
    houseNumberIsReal = false; // 虚构的，这条街没有真实门牌号数据
  }

  let postcode;
  let postcodeIsExact;
  if (street.postcode) {
    postcode = street.postcode;
    postcodeIsExact = true;
  } else {
    postcode = randomItem(cityMeta.postcodes) || '';
    postcodeIsExact = false; // 只是"这个城市里存在的某个邮编"，不精确对应这条街
  }

  const phone = randomPhoneNumber(cityMeta.phonePrefix || '000');

  return {
    country: countryCode,
    admin1,
    city,
    street: streetName,
    houseNumber,
    houseNumberIsReal,
    postcode,
    postcodeIsExact,
    phone,
    formatted: `${houseNumber} ${streetName}, ${city}, ${admin1} ${postcode}, ${countryCode}`,
  };
}

function main() {
  const [, , filePath, countArg] = process.argv;
  if (!filePath) {
    console.error('用法: node generate-address-example.mjs offline-addresses/us.json [生成条数]');
    process.exit(1);
  }
  const count = Number(countArg) || 1;

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const countryCode = Object.keys(raw)[0];
  const data = raw[countryCode];

  for (let i = 0; i < count; i++) {
    const addr = generateOneAddress(countryCode, data);
    console.log(JSON.stringify(addr, null, 2));
  }
}

main();
