// 7장 비밀 파일 읽기 막기: Claude 거부 규칙과 주인이 실행할 권한 스크립트(protect/unprotect-secrets.ps1).
// 스크립트 시험은 임시 폴더의 가짜 파일에만 한다. 진짜 secrets.json은 건드리지 않는다.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { devSettings, readonlySettings } from '../src/workspace/claude-settings.ts';
import { claudeAbsPattern, claudeDataDenyRules, CODEX_SANDBOX_GROUP, SECRET_FILES, SECRETS_CANARY, secretPaths } from '../src/workspace/secret-files.ts';

const SCRIPTS = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const PROTECT = join(SCRIPTS, 'protect-secrets.ps1');
const UNPROTECT = join(SCRIPTS, 'unprotect-secrets.ps1');

describe('Claude 데이터 폴더 거부 규칙', () => {
  it('Windows 경로를 Claude 권한 규칙의 절대 경로 꼴(//c/...)로 바꾼다', () => {
    expect(claudeAbsPattern('C:\\ai-office\\data')).toBe('//c/ai-office/data');
    expect(claudeAbsPattern('D:/x/y/')).toBe('//d/x/y');
    expect(claudeAbsPattern('/home/me/data')).toBe('//home/me/data');
  });

  it('파일 도구는 데이터 폴더 전체를, Bash는 경로·비밀 파일 이름이 보이는 명령을 거부한다', () => {
    expect(claudeDataDenyRules('C:\\ai-office\\data')).toEqual([
      'Read(//c/ai-office/data/**)',
      'Edit(//c/ai-office/data/**)',
      'Write(//c/ai-office/data/**)',
      'Bash(*\\ai-office\\data*)',
      'Bash(*/ai-office/data*)',
      'Bash(*secrets.json*)',
    ]);
    expect(SECRET_FILES).toContain('secrets.json');
  });

  it('개발자·읽기 전용 설정 모두에 들어가고, 읽기 전용은 Bash도 막는다', () => {
    const rules = claudeDataDenyRules('C:\\ai-office\\data');
    const dev = devSettings('C:\\ai-office\\data') as { permissions: { deny: string[] } };
    const ro = readonlySettings('C:\\ai-office\\data') as { permissions: { deny: string[] } };
    expect(dev.permissions.deny).toEqual(expect.arrayContaining(rules));
    expect(ro.permissions.deny).toEqual(expect.arrayContaining([...rules, 'Bash']));
  });
});

describe('권한 스크립트 (주인이 실행)', () => {
  it('스크립트는 한글 때문에 UTF-8 BOM으로 저장되어 있다', () => {
    for (const f of [PROTECT, UNPROTECT]) expect([...readFileSync(f).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('막는 그룹·파일 이름이 코드와 같다 (canary도 함께 막아야 확인이 맞다)', () => {
    const p = readFileSync(PROTECT, 'utf8');
    const u = readFileSync(UNPROTECT, 'utf8');
    expect(p).toContain(`$Group = '${CODEX_SANDBOX_GROUP}'`);
    for (const name of [...SECRET_FILES, SECRETS_CANARY]) {
      expect(p).toContain(`'${name}'`);
      expect(u).toContain(`'${name}'`);
    }
    expect(secretPaths('C:\\d')).toEqual([join('C:\\d', 'secrets.json'), join('C:\\d', SECRETS_CANARY)]);
    // 주인 권한을 먼저 준 뒤에 물려받기를 끊는다(잠기지 않게). 되돌리기는 물려받는 권한으로 reset
    expect(p.indexOf("'/grant'")).toBeLessThan(p.indexOf("'/inheritance:r'"));
    expect(p.indexOf("'/inheritance:r'")).toBeLessThan(p.indexOf("'/deny'"));
    expect(u).toContain('/reset');
  });
});

const ps = (file: string, ...args: string[]) =>
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8' });
const sddl = (f: string) =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Acl -LiteralPath '${f}').Sddl`], { encoding: 'utf8' }).trim();
const groupSid = (() => {
  if (process.platform !== 'win32') return '';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-LocalGroup -Name '${CODEX_SANDBOX_GROUP}' -ErrorAction SilentlyContinue).SID.Value`], { encoding: 'utf8' });
  return r.stdout.trim();
})();

describe.skipIf(!groupSid)('권한 스크립트를 가짜 폴더에 실제로 돌려 본다 (Windows, Codex 샌드박스 그룹이 있을 때)', () => {
  it('막기: 물려받기 끊고, Codex 그룹 거부, 주인은 읽는다 / 되돌리기: 물려받는 권한으로 돌아간다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-office-acl-'));
    try {
      const secrets = join(dir, 'secrets.json');
      writeFileSync(secrets, '{ "fake": "not-a-secret" }', 'utf8');

      const on = ps(PROTECT, '-DataDir', dir);
      expect(on.status, on.stdout + on.stderr).toBe(0);
      for (const f of [secrets, join(dir, SECRETS_CANARY)]) {
        const s = sddl(f);
        expect(s).toMatch(/D:P/);
        expect(s).toMatch(new RegExp(`\\(D;[^)]*;;;${groupSid}\\)`));
        expect(s).not.toMatch(/;;;(BU|AU|WD)\)/);
        expect(readFileSync(f, 'utf8').length).toBeGreaterThan(0);
      }

      const off = ps(UNPROTECT, '-DataDir', dir);
      expect(off.status, off.stdout + off.stderr).toBe(0);
      const s = sddl(secrets);
      expect(s).not.toMatch(/D:P/);
      // 거부만 사라지면 된다(임시 폴더에는 Codex가 그룹 허용을 걸어 둬서 물려받은 허용은 남을 수 있다)
      expect(s).not.toMatch(new RegExp(`\\(D;[^)]*;;;${groupSid}\\)`));
      expect(readFileSync(secrets, 'utf8')).toContain('not-a-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('secrets.json이 없으면 아무것도 바꾸지 않고 멈춘다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-office-acl-'));
    try {
      const r = ps(PROTECT, '-DataDir', dir);
      expect(r.status).toBe(1);
      expect(spawnSync('powershell.exe', ['-NoProfile', '-Command', `Test-Path '${join(dir, SECRETS_CANARY)}'`], { encoding: 'utf8' }).stdout.trim()).toBe('False');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
