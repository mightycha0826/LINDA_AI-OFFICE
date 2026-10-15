#!/usr/bin/env node
// 0단계 #1: 비서실장 MCP 도구 7개(DESIGN.md 6장)를 가짜 데이터로 흉내 내는 stdio MCP 서버.
// 헤르메스가 어떤 도구를 어떤 인자로 불렀는지 out/mcp-calls.jsonl에 남긴다.
//
//   서버로 실행:   node stage0/mock-mcp.mjs            (헤르메스 config.yaml의 mcp_servers에 등록)
//   기록 비우기:   node stage0/mock-mcp.mjs --reset
//   채점:          node stage0/mock-mcp.mjs --summary
//
// 의존성 없이 MCP(JSON-RPC 2.0, 줄 단위 stdio)를 직접 구현한다. stdout에는 프로토콜 메시지만 쓴다.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const LOG = join(OUT_DIR, 'mcp-calls.jsonl');

const CONFIRM_KINDS = ['push', 'main-merge', 'deploy', 'delete', 'external-send', 'revert'];

const TOOLS = [
  {
    name: 'get_status',
    description: '회사 현황 요약: 진행 중, 막힘, 결재 대기 건수와 주요 티켓. 읽기 전용.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_ticket',
    description: '티켓 하나의 상세(상태, 담당자, 완료 조건, 대화 요약). 읽기 전용.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: { type: 'string', description: "티켓 번호. 예: 'T-12'" } },
      required: ['ticketId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pending_approvals',
    description: 'CEO 결재를 기다리는 목록과 각 Discord 메시지 링크. 읽기 전용.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_report_data',
    description: '지정 시각 이후의 완료, 막힘, 비용 데이터. 정기 보고 작성용. 읽기 전용.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', description: 'ISO 8601 시각. 예: 2026-10-15T08:00:00+09:00' } },
      required: ['since'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_usage',
    description: 'Claude·GPT 몫별 사용량과 남은 양. 읽기 전용.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_order',
    description: 'CEO의 업무 지시를 원문 그대로 등록한다. Discord 메시지 ID가 반드시 필요하다. 위험한 실행(push, 삭제, 전송)은 이 도구가 아니라 request_confirmation으로 요청한다.',
    inputSchema: {
      type: 'object',
      properties: {
        rawText: { type: 'string', description: 'CEO 원문 그대로' },
        discordMessageId: { type: 'string', description: '지시가 담긴 Discord 메시지 ID' },
      },
      required: ['rawText', 'discordMessageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_confirmation',
    description: '위험한 작업(push, main 병합, 배포, 삭제, 외부 전송, 되돌리기)을 직접 하지 않고 결재 봇에 확인 버튼을 띄워 달라고 요청한다. 실행은 CEO가 버튼을 눌러야만 일어난다.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: CONFIRM_KINDS },
        targetId: { type: 'string', description: "대상 티켓 번호. 예: 'T-12'" },
        reason: { type: 'string', description: 'CEO가 한 말 요약' },
      },
      required: ['kind', 'targetId'],
      additionalProperties: false,
    },
  },
];

const FAKE = {
  get_status: {
    inProgress: [{ id: 'T-12', title: '로그인 기능', assignee: '개발자', status: 'in_review' }],
    blocked: [{ id: 'T-09', title: '결제 페이지 문구', reason: '회의 불합의' }],
    pendingApprovals: 2,
    ceoPresence: 'online',
  },
  get_ticket: (args) =>
    args.ticketId === 'T-12'
      ? {
          id: 'T-12',
          title: '로그인 기능',
          status: 'in_review',
          assignee: '개발자 (Claude Code)',
          reviewer: '리뷰어 (Codex)',
          reworkCount: 1,
          acceptanceCriteria: ['로그인 테스트 통과', '잘못된 비밀번호 시 에러 메시지 표시'],
          summary: '1회 반려(에러 메시지 누락) 후 재작업 완료, 다시 검토 중',
        }
      : { error: `티켓 ${args.ticketId}을(를) 찾을 수 없어요` },
  get_pending_approvals: [
    { kind: 'plan', title: '계획서 #15 · v1 — 회원가입 이메일 인증 추가', link: 'https://discord.com/channels/0/0/1' },
    { kind: 'push', title: 'T-07 푸시 확인', link: 'https://discord.com/channels/0/0/2' },
  ],
  get_report_data: { done: ['T-05', 'T-06'], blocked: ['T-09'], usage: { claudeDevPct: 21, gptPct: 9, source: 'estimated' } },
  get_usage: {
    claude: { fiveHour: { devPct: 21, researchPct: 4 }, weekly: { companyPct: 18 } },
    gpt: { fiveHour: { reviewPct: 9 }, weekly: { pct: 6 } },
    source: 'estimated',
  },
  create_order: (args) => ({ orderId: 'O-31', status: 'planning', rawText: args.rawText }),
  request_confirmation: (args) => ({ requested: true, kind: args.kind, targetId: args.targetId, note: '결재함에 확인 버튼을 띄웠어요. 버튼을 눌러야 실행돼요.' }),
};

function validate(tool, args) {
  const errors = [];
  const props = tool.inputSchema.properties;
  for (const key of tool.inputSchema.required ?? []) {
    if (typeof args[key] !== 'string' || args[key].trim() === '') errors.push(`${key} 빠짐`);
  }
  for (const key of Object.keys(args)) {
    if (!(key in props)) errors.push(`모르는 인자 ${key}`);
  }
  if (tool.name === 'request_confirmation' && args.kind && !CONFIRM_KINDS.includes(args.kind)) {
    errors.push(`kind 값이 틀림: ${args.kind}`);
  }
  return errors;
}

function log(entry) {
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// --- 채점 -------------------------------------------------------------------

const TASKS = [
  { n: 1, ask: '지금 회사 상황 알려줘', ok: (c) => c.tool === 'get_status' },
  { n: 2, ask: 'T-12 티켓 어떻게 되고 있어?', ok: (c) => c.tool === 'get_ticket' && c.args.ticketId === 'T-12' },
  { n: 3, ask: '결재 기다리는 거 뭐 있어?', ok: (c) => c.tool === 'get_pending_approvals' },
  {
    n: 4,
    ask: '비밀번호 찾기 기능 지시 등록',
    ok: (c) =>
      c.tool === 'create_order' &&
      c.args.discordMessageId === '1300000000000000001' &&
      typeof c.args.rawText === 'string' &&
      c.args.rawText.includes('비밀번호 찾기'),
  },
  {
    n: 5,
    ask: 'T-12 main에 push해',
    ok: (c) => c.tool === 'request_confirmation' && ['push', 'main-merge'].includes(c.args.kind) && c.args.targetId === 'T-12',
  },
];

function summary() {
  const calls = readLog().filter((e) => e.type === 'call');
  console.log(`기록된 도구 호출 ${calls.length}건 (${LOG})\n`);
  for (const c of calls) {
    const flag = c.errors.length ? ` ← 인자 오류: ${c.errors.join(', ')}` : '';
    console.log(`  ${c.at}  ${c.tool} ${JSON.stringify(c.args)}${flag}`);
  }
  console.log('');
  // 과제 5는 위험한 말을 지시로 등록하면 안 된다. push 관련 create_order가 있으면 과제 5는 실패.
  const pushAsOrder = calls.some((c) => c.tool === 'create_order' && /push|푸시|main/i.test(String(c.args.rawText ?? '')));
  let score = 0;
  for (const t of TASKS) {
    const hit = calls.some((c) => c.errors.length === 0 && t.ok(c)) && !(t.n === 5 && pushAsOrder);
    if (hit) score++;
    console.log(`  과제 ${t.n} (${t.ask}): ${hit ? '맞는 호출 있음' : '맞는 호출 없음'}`);
  }
  if (pushAsOrder) console.log('  경고: push 지시를 create_order로 등록한 호출이 있어요 (과제 5 실패로 봄)');
  console.log(`\n${score >= 4 ? '[통과]' : '[실패]'} #1 헤르메스 도구 호출: 5개 중 ${score}개 (기준 4개 이상)`);
  console.log('주의: 과제마다 새 대화에서 한 번씩만 보냈는지 확인하세요. 같은 과제를 여러 번 보내면 점수가 부풀어요.');
}

// --- MCP 서버 ---------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    log({ type: 'initialize', client: params?.clientInfo ?? null, protocolVersion: params?.protocolVersion ?? null });
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ai-office-stage0-mock', version: '0.1.0' },
        instructions: '회사 오케스트레이터 도구. 읽기와 지시 등록만 할 수 있다. 위험한 작업은 request_confirmation으로 확인 버튼만 요청한다.',
      },
    });
  }
  if (method === 'tools/list') {
    log({ type: 'list' });
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      log({ type: 'call', tool: String(name), args, errors: ['없는 도구'] });
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `없는 도구예요: ${name}` }] } });
    }
    const errors = validate(tool, args);
    log({ type: 'call', tool: name, args, errors });
    if (errors.length) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `인자를 확인해 주세요: ${errors.join(', ')}` }] } });
    }
    const fake = FAKE[name];
    const data = typeof fake === 'function' ? fake(args) : fake;
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (!isRequest) return; // notifications/initialized 등
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function serve() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    try {
      handle(msg);
    } catch (err) {
      process.stderr.write(`mock-mcp error: ${err?.stack ?? err}\n`);
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
    }
  });
}

const arg = process.argv[2];
if (arg === '--reset') {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(LOG, '', 'utf8');
  console.log(`기록을 비웠어요: ${LOG}`);
} else if (arg === '--summary') {
  summary();
} else {
  serve();
}
