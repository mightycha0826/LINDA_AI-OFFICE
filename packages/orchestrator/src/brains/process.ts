// 자식 프로세스 실행 (Claude Code, Codex, 테스트 명령, git).
// - 환경 변수는 허용 목록만 넘긴다. GitHub 토큰과 API 키는 절대 넘기지 않는다 (3장, 11장).
//   API 키가 넘어가면 구독이 아니라 API 요금으로 나가기도 한다.
// - git 자격 증명 도우미를 끈다. Windows 자격 증명 관리자에 GitHub 로그인이 남아 있어도
//   AI가 띄운 git은 그것을 쓰지 못한다 (worktree에 인증 정보가 없게 하는 이중 잠금의 보강).
// - 프롬프트는 stdin으로 넘긴다. Windows 명령줄 길이 제한과 따옴표 문제를 피한다.
// - 시간 초과나 /정지면 프로세스 트리째 끝낸다.
import spawn from 'cross-spawn';
import { spawn as nodeSpawn } from 'node:child_process';

const ALLOWED_ENV = new Set(
  [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'COMPUTERNAME',
    'LANG', 'LC_ALL', 'TZ', 'TERM',
    // CLI 자체의 로그인 정보 위치 (구독 로그인 파일이 있는 폴더 경로일 뿐 비밀 값이 아니다)
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  ].map((k) => k.toUpperCase()),
);

/** 이름에 이런 말이 들어간 변수는 허용 목록에 있어도 넘기지 않는다. */
export const SECRET_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE|AUTH/i;

/** 자식 프로세스의 git이 저장된 자격 증명을 쓰지 못하게 한다. */
const GIT_LOCKDOWN: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  // 환경 변수 설정이 가장 우선한다. 빈 값은 앞서 등록된 도우미 목록을 지운다.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
};

export function safeEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (!ALLOWED_ENV.has(k.toUpperCase())) continue;
    if (SECRET_ENV_PATTERN.test(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (SECRET_ENV_PATTERN.test(k)) throw new Error(`비밀로 보이는 환경 변수는 넘길 수 없어요: ${k}`);
    env[k] = v;
  }
  return { ...env, ...GIT_LOCKDOWN };
}

export interface RunOptions {
  bin: string;
  args: readonly string[];
  cwd: string;
  stdin?: string;
  extraEnv?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 명령 문자열을 셸로 실행 (등록된 testCommand용) */
  shell?: boolean;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** 실행 파일을 못 찾는 등 시작 자체가 실패함 */
  spawnError?: string;
  durationMs: number;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 끝남 */
    }
  }
}

export function runProcess(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = o.maxOutputBytes ?? 10 * 1024 * 1024;
  return new Promise((resolve) => {
    if (o.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, durationMs: 0 });
      return;
    }
    const child = o.shell
      ? nodeSpawn(o.bin, { cwd: o.cwd, env: safeEnv(o.extraEnv), shell: true, windowsHide: true })
      : spawn(o.bin, [...o.args], { cwd: o.cwd, env: safeEnv(o.extraEnv), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const append = (cur: string, chunk: string) => (cur.length + chunk.length > max ? cur + chunk.slice(0, Math.max(0, max - cur.length)) : cur + chunk);

    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout = append(stdout, d)));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr = append(stderr, d)));
    child.stdin?.on('error', () => {}); // 프로세스가 stdin을 읽기 전에 끝나도 무시
    if (o.stdin !== undefined) child.stdin?.end(o.stdin, 'utf8');
    else child.stdin?.end();

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started, ...(spawnError ? { spawnError } : {}) });
    };
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}
