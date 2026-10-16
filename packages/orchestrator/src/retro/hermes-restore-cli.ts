// npm run hermes:restore -- <YYYY-MM-DD> — 헤르메스 기억·스킬을 그날 백업으로 되돌린다. 날짜 없이 실행하면 백업 목록.
// 헤르메스를 끈 상태에서 주인이 직접 실행한다.
import { join } from 'node:path';
import { DEFAULTS, loadConfig } from '../config.ts';
import { listHermesBackups, restoreHermes } from './hermes-backup.ts';

const dataDir = process.env.AI_OFFICE_DATA ?? DEFAULTS.paths.data;
const config = loadConfig(join(dataDir, 'config.json'));
const date = process.argv[2];
if (!date) {
  const list = listHermesBackups(config);
  console.log(list.length ? `백업: ${list.join(', ')}` : `백업이 없어요 (${config.hermes.backupDir})`);
  process.exit(0);
}
const restored = restoreHermes(config, date);
console.log(`되돌렸어요: ${restored.join(', ') || '없음'} (${date})`);
