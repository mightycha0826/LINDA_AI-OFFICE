// 0단계 #5·#6에서 찾은 것: 회사 AI는 주인 개인 설정(플러그인, 스킬, MCP 서버, 모델)을 물려받지 않는다
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeBrain } from '../src/brains/claude-code.ts';
import { CODEX_HOME_CONFIG, CODEX_ISOLATION_OVERRIDES, CodexBrain, codexWorkdirNote, ensureCodexHome } from '../src/brains/codex.ts';
import { safeEnv } from '../src/brains/process.ts';
import { makeConfig } from '../src/config.ts';
import { CEO, tempRoot } from './helpers.ts';

const files = { settings: 's.json', systemPrompt: 'p.md' };
const base = { bin: 'claude', binArgs: [], timeoutMs: 1000, maxTurns: 5, wtRoot: 'C:/wt', dataDir: 'C:/data' };

describe('Claude Code: 개인 설정 분리', () => {
  it('사용자 설정·MCP 서버·스킬을 불러오지 않는다', () => {
    const args = new ClaudeCodeBrain(base).buildArgs('readonly', files, {});
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands']));
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(args).not.toContain('--model');
  });

  it('모델을 정하면 --model로 넘긴다', () => {
    const args = new ClaudeCodeBrain({ ...base, model: 'sonnet' }).buildArgs('dev-work', files, {});
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('기본은 CEO가 정한 Opus 5.5 · 노력 medium이고, 노력은 --effort로 넘긴다', () => {
    const c = makeConfig({ ceoDiscordId: CEO });
    expect(c.claude.model).toBe('claude-opus-5-5');
    expect(c.claude.effort).toBe('medium');
    const args = new ClaudeCodeBrain({ ...base, model: c.claude.model, effort: c.claude.effort }).buildArgs('research', files, {});
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    expect(new ClaudeCodeBrain(base).buildArgs('research', files, {})).not.toContain('--effort');
  });

  it('Claude 앱이 넘긴 ANTHROPIC_BASE_URL 같은 세션 변수는 자식에게 가지 않는다', () => {
    const env = safeEnv({}, { PATH: 'x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop' });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['ANTHROPIC_BASE_URL']));
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });
});

describe('Codex: 회사 전용 CODEX_HOME', () => {
  it('기본 설정은 주인의 ~/.codex가 아니라 회사 폴더', () => {
    const c = makeConfig({ ceoDiscordId: CEO });
    expect(c.codex.home).toBe('C:\\ai-office\\data\\codex-home');
    expect(c.codex.model).toBe('');
  });

  it('처음 쓸 때 플러그인·MCP 없는 설정을 만들고, 이미 있으면 건드리지 않는다', () => {
    const home = join(tempRoot(), 'codex-home');
    ensureCodexHome(home);
    const cfg = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*\[(plugins|mcp_servers)/m);
    expect(cfg).not.toMatch(/^\s*model\s*=/m);
    writeFileSync(join(home, 'config.toml'), '# 주인이 고친 설정\n');
    ensureCodexHome(home);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('# 주인이 고친 설정\n');
    expect(existsSync(join(home, 'auth.json'))).toBe(false); // 로그인 파일은 만들지 않는다
  });

  it('기본 스킬·원격 플러그인을 끄고, 오케스트레이터가 만든 예전 설정은 새로 바꾼다', () => {
    const home = join(tempRoot(), 'codex-home');
    ensureCodexHome(home);
    const cfg = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(cfg).toMatch(/^\[skills\.bundled\]\nenabled = false$/m);
    expect(cfg).toMatch(/^\[skills\]\ninclude_instructions = false$/m);
    for (const f of ['plugins', 'remote_plugin', 'apps', 'tool_suggest']) expect(cfg).toMatch(new RegExp(`^${f} = false$`, 'm'));

    // 0단계 #6 때 만든 설정(스킬·플러그인 끄기 없음)
    const old = `${CODEX_HOME_CONFIG.split('\n').slice(0, 3).join('\r\n')}\r\n[windows]\r\nsandbox = "elevated"\r\n`;
    writeFileSync(join(home, 'config.toml'), old);
    ensureCodexHome(home);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(CODEX_HOME_CONFIG);
    ensureCodexHome(home); // 두 번 불러도 같다
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(CODEX_HOME_CONFIG);
  });

  it('설정 파일과 상관없이 실행할 때도 -c로 스킬·플러그인을 끈다', () => {
    const args = new CodexBrain({ bin: 'codex', binArgs: [], timeoutMs: 1000, promptVia: 'stdin', wtRoot: 'C:/wt', dataDir: 'C:/data' })
      .buildArgs('read-only', 'C:/wt/T-1', { schema: 's.json', lastMessage: 'l.json' }, 'p');
    const overrides = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
    expect(overrides).toEqual([...CODEX_ISOLATION_OVERRIDES]);
    expect(overrides).toEqual(expect.arrayContaining(['skills.bundled.enabled=false', 'features.plugins=false', 'features.remote_plugin=false']));
  });

  it('모델을 정하면 -m으로 넘기고, 읽기 전용 샌드박스는 그대로', () => {
    const b = new CodexBrain({ bin: 'codex', binArgs: [], timeoutMs: 1000, promptVia: 'stdin', wtRoot: 'C:/wt', dataDir: 'C:/data', model: 'gpt-x' });
    const args = b.buildArgs('read-only', 'C:/wt/T-1', { schema: 's', lastMessage: 'l' }, 'p');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-x');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    const plain = new CodexBrain({ bin: 'codex', binArgs: [], timeoutMs: 1000, promptVia: 'stdin', wtRoot: 'C:/wt', dataDir: 'C:/data' });
    expect(plain.buildArgs('read-only', 'C:/wt/T-1', { schema: 's', lastMessage: 'l' }, 'p')).not.toContain('-m');
  });
});

describe('Codex: 작업 폴더를 절대 경로로 알려 준다 (0단계 #6)', () => {
  it('Windows 샌드박스에서 -C가 무시돼도 리뷰어가 worktree 파일을 읽을 수 있게', () => {
    const note = codexWorkdirNote('C:\\ai-office\\wt\\T-1');
    expect(note).toContain('C:\\ai-office\\wt\\T-1');
    expect(note).toContain('절대 경로');
  });
});
