// AI 직원의 두뇌 인터페이스. 1단계는 MockLLM, 2단계에서 Ollama·Claude Code·Codex 어댑터가 같은 인터페이스를 구현한다.
import type { UsageSource } from '@ai-office/shared';
import type { EmployeeRow } from '../core/budget.ts';

export type BrainTask = 'plan' | 'gate' | 'work' | 'review' | 'meeting';

export interface BrainRequest {
  employee: EmployeeRow;
  task: BrainTask;
  /** 출력 스키마 이름 (역할 카드에 넣을 형식) */
  schemaName: string;
  /** 작업 입력. 2단계에서 역할 카드와 합쳐 프롬프트가 된다. */
  input: unknown;
  ticketId?: string;
  orderId?: string;
  /** 1부터. 2면 형식 오류 뒤 재시도 */
  attempt: number;
  /** 재시도 때 붙이는 앞선 형식 오류 */
  previousError?: string;
  /** 리서치 몫 소진 뒤 로컬로 바꿔 쓰는 중 */
  lowPrecision?: boolean;
  /** /정지가 진행 중인 호출을 끊는다 */
  signal: AbortSignal;
}

export interface BrainResult {
  /** 파싱한 JSON. 형식 검사는 오케스트레이터가 한다. */
  output: unknown;
  /** estimatedPct는 5시간 한도 대비, estimatedWeeklyPct는 주간 한도 대비 % */
  usage: { inputTokens: number; outputTokens: number; estimatedPct: number; estimatedWeeklyPct: number; source: UsageSource };
}

export interface Brain {
  call(req: BrainRequest): Promise<BrainResult>;
}

/** 오케스트레이터가 직접 돌린 테스트 결과 (6장 리뷰어 입력). 2단계에서 testCommand를 실제로 실행한다. */
export interface TestResult {
  passed: boolean;
  summary: string;
}

export interface TestRunner {
  run(ticketId: string, signal: AbortSignal): Promise<TestResult>;
}
