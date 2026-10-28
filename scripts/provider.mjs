import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
export function cf(args, config, body, raw = false) {
  const cli = resolve('node_modules/cf/bin/cf');
  const values = [...args, ...(body === undefined ? [] : ['--body', JSON.stringify(body)])];
  const providerEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId };
  delete providerEnv.CLOUDFLARE_ZONE_ID;
  const output = execFileSync(process.execPath, [cli, ...values], {
    encoding: raw ? null : 'utf8',
    env: providerEnv,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (raw) return output;
  if (!output.trim()) return null;
  const parsed = JSON.parse(output);
  if (parsed?.success === false) throw new Error('Cloudflare operation did not succeed');
  // Keep pagination metadata for APIs whose result is an object.
  if (parsed?.result_info && parsed.result && !Array.isArray(parsed.result))
    return { ...parsed.result, result_info: parsed.result_info };
  return parsed?.result ?? parsed;
}
export function rows(value) {
  if (!value) return [];
  if (value.columns && Array.isArray(value.rows))
    return value.rows.map((row) =>
      Object.fromEntries(value.columns.map((key, i) => [key, row[i]])),
    );
  if (Array.isArray(value))
    return value.flatMap((item) => (item?.results || item?.columns ? rows(item) : [item]));
  if (value.results) return rows(value.results);
  return value.buckets || value.objects || value.data || [];
}
export function listPages(args, c) {
  const all = [];
  for (let page = 1; page <= 1000; page++) {
    const items = rows(cf([...args, '--page', String(page), '--per-page', '50'], c));
    all.push(...items);
    if (items.length < 50) return all;
  }
  throw new Error('Resource list is too large; refusing an incomplete ownership check');
}
export function rawSql(c, m, sql, params = []) {
  return cf(['d1', 'raw', m.databaseId], c, { sql, params });
}
