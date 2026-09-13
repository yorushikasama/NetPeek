// 运行 ui-tests 下的全部用例：node scripts/ui-tests/run-all.mjs
// 任一用例失败则整体退出码非零，可直接串进构建或 pre-commit。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tests = fs.readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(HERE, test)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

console.log(failed === 0
  ? `\n全部通过（${tests.length} 个用例文件）`
  : `\n${failed}/${tests.length} 个用例文件失败`);
process.exit(failed ? 1 : 0);
