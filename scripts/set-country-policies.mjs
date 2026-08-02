#!/usr/bin/env node
/**
 * 覆盖 daimon3332/address 数据库里目标国家的采集策略 (sync_country_policies.target_count)。
 *
 * 背景（为什么需要这个脚本，而不是继续调 .env 里的 ADDRESS_SYNC_MAX_RECORDS_PER_SHARD）：
 *
 * - server/sync/address-etl.mjs 在真正跑同步时，会调用 loadImportPolicy(database, countryCode,
 *   maxRecords, perLocality)。这个函数只有在数据库里【完全查不到】该国家的策略记录时，才会
 *   使用传进来的 maxRecords（也就是 .env 里的 ADDRESS_SYNC_MAX_RECORDS_PER_SHARD）当兜底值；
 *   只要数据库里已经有这个国家的策略记录，就会直接用数据库里存的 target_count，
 *   完全无视 .env 里的配置。
 *
 * - server/sync/address-policy.mjs 里的 ADDRESS_POLICY_DEFAULTS 给每个国家都内置了一份
 *   默认策略（例如 US target=50000，JP target=40000，SG target=8000……），而
 *   ensureAddressPolicies() 会在每次调用 loadImportPolicy 时，用 INSERT OR IGNORE
 *   把这些默认值写进 sync_country_policies 表。我们要跑的 20 个国家全部都在
 *   ADDRESS_POLICY_DEFAULTS 里有内置默认值，所以 .env 里调低的
 *   ADDRESS_SYNC_MAX_RECORDS_PER_SHARD 对这 20 个国家从未真正生效过 ——
 *   materialize 阶段实际请求的候选行数，一直是按国家内置的巨大默认目标
 *   （US 50000、JP 40000 ……）在远程 DuckDB 里采样/排序/落盘，这才是
 *   "US materialize 耗时 10 分钟" 的根本原因。
 *
 * 这个脚本在 db:migrate 之后、address-etl.mjs 真正开始处理任何国家之前执行，
 * 直接调用仓库自己导出的 updateCountryPolicy()，把每个目标国家的 target_count
 * 显式下调到 ADDRESS_SYNC_POLICY_TARGET_COUNT（默认 900，是 export-offline-streets.mjs
 * 里 FIXED_LIMIT=300 的 3 倍缓冲，用来覆盖 active=1 / street 与 house_number 非空等
 * 过滤条件造成的损耗，避免最终可用地址不足 300 条）。
 *
 * 只覆盖 target_count，不改动每个国家原有的 level1-4 分级限额（levelLimits）：
 * 一旦全局 target_count 已经远小于原有的分级限额，分级限额本身就不会再成为瓶颈，
 * 保留它们可以把这次改动对原有行为的影响降到最低。
 *
 * 之所以通过官方导出的 updateCountryPolicy() 写库，而不是继续对第三方仓库源码做
 * sed 替换：sed 是脆弱的字符串匹配，一旦上游改了写法就会静默失效而不报错
 * （这正是这次排查发现的、workflow 里原有两行 sed 从一开始就没生效的原因）。
 * updateCountryPolicy() 是仓库自己维护、专门用来调整采集策略的公开函数，
 * 语义明确、带校验，不会引入无法预料的副作用。
 *
 * 关于按国家单独覆盖 target_count：
 * server/sync/overture-export.py 里做建筑物空间匹配（residential/apartment 判定）时，
 * 有一处写死的常量 `residential_grid_limit = min(24, residential_probe_limit)`——
 * 不管候选池多大，全国范围内只会挑地址候选最密集的 24 个地理网格去做匹配，网格外的候选
 * 一律因为拿不到 residentialSourceRecordId 被拒。这个限制对国土面积大、地址点分布分散
 * 的国家（典型如 US）影响明显更大：SQL 层面把候选按州/省均匀打散后，大部分网格根本凑不够
 * 密度进这 24 个，实测 US 在 target_count=900 时最终只有 119 条通过（约 13% 转化率），
 * 远达不到导出脚本需要的 300 条。相邻的 CA 在同样 900 时也只是勉强够（418 条）。
 * 这里允许通过 ADDRESS_SYNC_POLICY_TARGET_OVERRIDES 单独给这类国家设置更高的
 * target_count，而不必为了照顾少数几个国家把全部 20 个国家的候选池、materialize
 * 耗时一起抬高。
 */

import { openDatabase } from '../server/database/sqlite.mjs';
import { updateCountryPolicy } from '../server/sync/address-policy.mjs';

const databasePath = process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite';

const defaultTargetCount = Number(process.env.ADDRESS_SYNC_POLICY_TARGET_COUNT || 900);
if (!Number.isInteger(defaultTargetCount) || defaultTargetCount < 1) {
  console.error(
    `[policy-seed] 非法的 ADDRESS_SYNC_POLICY_TARGET_COUNT: ${process.env.ADDRESS_SYNC_POLICY_TARGET_COUNT}`
  );
  process.exit(1);
}

// 按国家覆盖 target_count，JSON 格式，例如 '{"US":4500,"RU":4500}'。
// 没有在这里列出的国家，一律使用上面的 defaultTargetCount。
let targetOverrides = {};
const overridesRaw = process.env.ADDRESS_SYNC_POLICY_TARGET_OVERRIDES;
if (overridesRaw && overridesRaw.trim()) {
  try {
    const parsed = JSON.parse(overridesRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('必须是一个 { 国家代码: 数字 } 形式的 JSON 对象');
    }
    for (const [countryCode, value] of Object.entries(parsed)) {
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric < 1) {
        throw new Error(`国家 ${countryCode} 的覆盖值不是正整数: ${value}`);
      }
      targetOverrides[countryCode.trim().toUpperCase()] = numeric;
    }
  } catch (error) {
    console.error(`[policy-seed] 非法的 ADDRESS_SYNC_POLICY_TARGET_OVERRIDES: ${error.message}`);
    process.exit(1);
  }
}

const resolveTargetCount = (countryCode) => targetOverrides[countryCode] ?? defaultTargetCount;

// 国家列表统一从 COUNTRIES 环境变量读取（workflow 顶层 env 里定义），
// 和 "Process 20 Fixed Countries Loop" 步骤共用同一份列表，避免两处列表
// 不同步——如果以后加了新国家却忘了同步到这里，那个国家会悄悄退回仓库
// 内置的巨大默认 target_count，重新变慢，而且不会有任何报错提示你。
const countries = String(process.env.COUNTRIES || '')
  .split(/[\s,]+/u)
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);

if (countries.length === 0) {
  console.error('[policy-seed] 没有读到任何国家（环境变量 COUNTRIES 为空），请检查 workflow 的 env 配置。');
  process.exit(1);
}

async function main() {
  const database = openDatabase(databasePath);
  const failures = [];
  try {
    for (const countryCode of countries) {
      const targetCount = resolveTargetCount(countryCode);
      const overridden = Object.hasOwn(targetOverrides, countryCode);
      try {
        const updated = await updateCountryPolicy(database, countryCode, { targetCount });
        console.log(
          `[policy-seed] ${countryCode}: target_count -> ${updated.targetCount}` +
            `${overridden ? ' (按国家单独覆盖)' : ' (默认值)'} ` +
            `(level limits 保持不变: [${updated.level1Limit},${updated.level2Limit},${updated.level3Limit},${updated.level4Limit}])`
        );
      } catch (error) {
        failures.push({ countryCode, error });
        console.error(`[policy-seed] ${countryCode} 覆盖策略失败:`, error);
      }
    }
  } finally {
    database.close();
  }

  if (failures.length > 0) {
    console.error(
      `[policy-seed] 共有 ${failures.length} 个国家策略覆盖失败，脚本在这里直接失败退出，` +
        '避免"以为已经调低了采集目标、实际上某些国家还是跑巨大默认值"的情况再次发生而不被发现。'
    );
    process.exit(1);
  }

  console.log(
    `[policy-seed] 完成，共处理 ${countries.length} 个国家，默认 target_count=${defaultTargetCount}，` +
      `其中 ${Object.keys(targetOverrides).length} 个国家使用了单独覆盖值。`
  );
}

main().catch((error) => {
  console.error('[policy-seed] 脚本执行失败', error);
  process.exit(1);
});
