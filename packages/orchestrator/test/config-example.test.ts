// docs/config.example.json이 실제 설정 형식과 어긋나지 않게 한다 (주인이 이 파일을 복사해서 쓴다)
import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { tempRoot } from './helpers.ts';

describe('설정 예시', () => {
  it('docs/config.example.json은 그대로 읽힌다', () => {
    const file = join(tempRoot(), 'config.json');
    copyFileSync(resolve(import.meta.dirname, '..', '..', '..', 'docs', 'config.example.json'), file);
    const c = loadConfig(file);
    expect(c.screen.combo).toBe(1);
    expect(c.retro.weeklyTime).toBe('22:00');
    expect(c.hermes.folders).toEqual(['memories', 'skills']);
  });
});
