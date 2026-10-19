// 7-2 로컬 두뇌 통일 (16장): 로컬은 gemma4:12b-64k 하나. 문맥 크기를 태그와 맞춰 Ollama가 다시 올리지 않는다.
import { describe, expect, it } from 'vitest';
import { LOCAL_MODEL, LOCAL_NUM_CTX, PmPlanOutputSchema } from '@ai-office/shared';
import { planOutput } from '../src/brains/mock.ts';
import { DEFAULTS } from '../src/config.ts';
import { tempBrain } from '../src/staff/temp-staff.ts';
import { setup } from './helpers.ts';

describe('7-2 로컬 두뇌 통일', () => {
  it('로컬 두뇌는 gemma4:12b-64k 하나이고, 오케스트레이터도 같은 문맥(65536)으로 부른다', () => {
    expect(LOCAL_MODEL).toBe('gemma4:12b-64k');
    expect(DEFAULTS.ollama.numCtx).toBe(LOCAL_NUM_CTX);
    expect(LOCAL_NUM_CTX).toBe(65_536);
  });

  it('계획서에 임시 직원 두뇌로 Qwen을 고를 수 없다 (로컬은 하나, 아니면 Claude)', () => {
    const withBrain = (brain: string) => planOutput({ tempStaff: [{ key: 'w', kind: 'writer', reason: '안내문', brain } as never] });
    expect(PmPlanOutputSchema.safeParse(withBrain('qwen3:14b')).success).toBe(false);
    expect(PmPlanOutputSchema.safeParse(withBrain('gemma4:12b-64k')).success).toBe(true);
    expect(PmPlanOutputSchema.safeParse(withBrain('claude')).success).toBe(true);
  });

  it('7-2 전에 저장된 계획서의 qwen3:14b 임시 직원도 지금의 로컬 두뇌로 읽는다. 디자인 시스템 담당은 늘 로컬', () => {
    expect(tempBrain({ kind: 'writer', brain: 'qwen3:14b' as never })).toEqual({ provider: 'ollama', model: LOCAL_MODEL });
    expect(tempBrain({ kind: 'writer' })).toEqual({ provider: 'ollama', model: LOCAL_MODEL });
    expect(tempBrain({ kind: 'writer', brain: 'claude' })).toEqual({ provider: 'claude-code', budget: 'dev' });
    expect(tempBrain({ kind: 'design-system', brain: 'claude' })).toEqual({ provider: 'ollama', model: LOCAL_MODEL });
  });

  it('Git 고양이 커밋 메시지 초안도 로컬 두뇌로 쓴다', async () => {
    const s = setup({ handlers: { commit: () => ({ type: 'feat', scope: 'site', subject: '섹션 추가' }) } });
    const draft = await s.engine.draftCommit({ id: 'T-1', title: '섹션 추가', acceptanceCriteria: ['npm test 통과'], reworkCount: 0, reviewPassed: true, reviewerName: 'reviewer' }, ' a.js | 1 +');
    expect(draft).toEqual({ type: 'feat', scope: 'site', subject: '섹션 추가' });
    expect(s.mock.callsFor('commit')[0]!.employee.brain).toEqual({ provider: 'ollama', model: LOCAL_MODEL });
  });
});
