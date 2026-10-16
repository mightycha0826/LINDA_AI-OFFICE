// AI 직원의 두뇌 인터페이스. MockLLM(1단계)과 Ollama·Claude Code·Codex 어댑터(2단계)가 같은 인터페이스를 구현한다.
import type { z } from 'zod';
import type { UsageSource } from '@ai-office/shared';
import type { EmployeeRow } from '../core/budget.ts';
import { OfficeError } from '../errors.ts';

/** search: 로컬 직원의 검색어 정하기, design: 디자인 시스템 담당의 조합 고르기, commit: Git 고양이 커밋 메시지 초안 */
export type BrainTask = 'plan' | 'gate' | 'work' | 'review' | 'meeting' | 'search' | 'design' | 'commit' | 'retro';

export interface BrainRequest {
  employee: EmployeeRow;
  task: BrainTask;
  /** 출력 형식. 어댑터가 JSON 스키마로 바꿔 구조화 출력을 강제한다 (6장) */
  schema: z.ZodType;
  /** 작업 입력(구조화). 프롬프트는 이것으로 만든다. MockLLM은 이것을 본다. */
  input: unknown;
  /** 역할 카드(system)와 작업 설명(user) */
  prompt: { system: string; user: string };
  /**
   * 일하는 폴더. 개발자 작업·코드 리뷰는 티켓 worktree, 리서치·관문은 빈 샌드박스.
   * 어댑터는 이 폴더가 작업 공간(paths.wt) 밖이면 실행하지 않는다.
   */
  workdir?: string;
  ticketId?: string;
  orderId?: string;
  /** 1부터. 2면 형식 오류나 실패 뒤 재시도 */
  attempt: number;
  /** 재시도 때 붙이는 앞선 형식 오류 */
  previousError?: string;
  /** 리서치 몫 소진 뒤 로컬로 바꿔 쓰는 중 */
  lowPrecision?: boolean;
  /** /정지가 진행 중인 호출을 끊는다 */
  signal: AbortSignal;
}

export interface BrainUsage {
  inputTokens: number;
  outputTokens: number;
  source: UsageSource;
  /** 한도 대비 %. 어댑터가 모르면 비워 두고 오케스트레이터가 토큰으로 추정한다 */
  estimatedPct?: number;
  estimatedWeeklyPct?: number;
}

export interface BrainResult {
  /** 파싱한 JSON. 형식 검사는 오케스트레이터가 한다. */
  output: unknown;
  usage: BrainUsage;
}

export interface Brain {
  call(req: BrainRequest): Promise<BrainResult>;
}

/**
 * 두뇌 호출 실패의 종류. 오케스트레이터는 종류에 따라 다르게 처리한다.
 * - offline: 인터넷 끊김 → 클라우드 직원 티켓만 paused(offline), 연결되면 재개 (3장)
 * - limit: 구독 한도 도달 → 그 몫을 막고 paused(budget) (8장)
 * - timeout, crash: 한 번 다시 시도, 또 실패하면 paused(system-error) (10장)
 */
export type BrainFailure = 'offline' | 'limit' | 'timeout' | 'crash';

export class BrainError extends OfficeError {
  readonly failure: BrainFailure;
  /** limit일 때 한도가 다시 차는 시각(알면) */
  readonly resetsAt: string | undefined;

  constructor(failure: BrainFailure, message: string, resetsAt?: string) {
    super(`brain-${failure}`, message);
    this.failure = failure;
    this.resetsAt = resetsAt;
  }
}

/** 오케스트레이터가 직접 돌린 테스트 결과 (6장 리뷰어 입력). */
export interface TestResult {
  passed: boolean;
  summary: string;
}

export interface TestRunner {
  run(ticketId: string, signal: AbortSignal): Promise<TestResult>;
}
