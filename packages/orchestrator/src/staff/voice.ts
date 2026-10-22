/** 자동 소식도 직원 본인이 이야기한다. 상태의 의미는 바꾸지 않는다. */
const VOICES: Record<string, { start: string; review: string; done: string }> = {
  pm: { start: '말씀 나눈 내용을 정리해서 진행할게요.', review: '정해 둔 조건에 맞는지 하나씩 확인할게요.', done: '맡은 내용은 검토까지 마쳤어요. 결과를 정리해 드릴게요.' },
  developer: { start: '제가 맡아서 구현할게요. 바뀌는 부분과 테스트를 함께 살펴보겠습니다.', review: '구현 내용과 테스트를 함께 살펴볼게요.', done: '구현과 검토를 마쳤어요. 확인한 내용을 함께 남겨 둘게요.' },
  'dev-a': { start: '넵! 제가 맡아서 만들어 볼게요. 진행 상황도 알려드릴게요!', review: '넵! 빠진 부분이 없는지 확인해 볼게요.', done: '작업 끝났어요! 검토도 통과했고, 확인한 내용은 아래에 남겼어요.' },
  'dev-b': { start: '제가 맡을게요. 빠질 수 있는 경우도 함께 확인하겠습니다.', review: '조건별로 확인할게요. 예외 상황도 살펴보겠습니다.', done: '작업과 검토를 마쳤어요. 확인한 내용은 아래와 같아요.' },
  reviewer: { start: '제가 맡아서 확인하겠습니다. 기준과 근거를 함께 남길게요.', review: '검토를 시작하겠습니다. 완료 조건과 확인 결과를 대조할게요.', done: '맡은 작업이 검토를 통과했어요. 확인한 근거를 함께 남깁니다.' },
  marketing: { start: '말씀하신 방향으로 써 볼게요. 읽는 사람에게 잘 전달되도록 다듬겠습니다.', review: '문장과 근거를 함께 읽어 볼게요.', done: '글을 다듬고 검토까지 마쳤어요. 완성한 내용을 확인해 주세요.' },
  strategy: { start: '제가 맡아서 살펴볼게요. 확인된 근거를 바탕으로 정리하겠습니다.', review: '결론을 뒷받침하는 근거와 요청하신 항목을 확인할게요.', done: '맡은 작업과 검토를 마쳤어요. 확인한 내용을 정리했습니다.' },
  'qa-local': { start: '제가 꼼꼼히 살펴볼게요. 빠진 내용도 함께 확인하겠습니다.', review: '한 항목씩 확인해 볼게요. 놓친 부분이 없는지도 살펴보겠습니다.', done: '맡은 작업이 검토까지 끝났어요. 확인한 내용을 함께 적어 둘게요.' },
  'git-cat': { start: '제가 잘 챙겨 둘게요. 야옹.', review: '엉킨 부분이 없는지 살펴볼게요. 야옹.', done: '모두 마무리됐어요. 기록도 잘 챙겨 뒀어요. 야옹.' },
};

export function staffUpdate(employeeId: string, state: string): string {
  const voice = VOICES[employeeId];
  if (state === 'in_progress') return voice?.start ?? '제가 맡아서 진행할게요.';
  if (state === 'in_review') return voice?.review ?? '정해 둔 조건에 맞는지 확인할게요.';
  if (state === 'done') return voice?.done ?? '맡은 작업과 검토를 마쳤어요.';
  return ({
    rework: '검토에서 나온 의견을 확인했어요. 그 부분을 고쳐서 다시 보여드릴게요.',
    meeting: '서로 의견이 다른 부분이 있어요. 근거를 비교해서 방향을 맞춰 볼게요.',
    blocked: '혼자 결정하기 어려운 부분에서 멈췄어요. 막힘 채널에서 방향을 알려 주시겠어요?',
    awaiting_approval: '작업이 검토를 통과했어요. 저장소에 반영할 수 있도록 결재함에서 확인해 주세요.',
    cancelled: '이 작업은 취소된 것으로 확인했어요.',
  } as Record<string, string>)[state] ?? '진행 상황을 알려드릴게요.';
}

/** 제안은 준비된 상태만 말한다. 모델이 착수·완료를 섣불리 약속해도 그대로 전달하지 않는다. */
export function staffProposalIntro(employeeId: string): string {
  return ({
    pm: '말씀 나눈 내용을 정리했어요. 아래 범위가 맞는지 확인해 주세요.',
    developer: '원하시는 범위를 이렇게 이해했어요. 확인해 주시면 이 내용을 기준으로 진행할 수 있어요.',
    'dev-a': '넵! 말씀 나눈 내용으로 정리해 봤어요!',
    'dev-b': '말씀 나눈 내용을 정리했어요. 범위와 확인할 항목은 아래와 같아요.',
    reviewer: '요청하신 범위와 확인 기준을 정리했어요.',
    marketing: '말씀하신 방향을 이렇게 정리해 봤어요.',
    strategy: '요청하신 범위와 확인할 내용을 정리했어요.',
    'qa-local': '제가 이해한 내용을 적어 봤어요. 빠뜨린 것이 없는지 확인해 주시겠어요?',
  } as Record<string, string>)[employeeId] ?? '말씀 나눈 내용을 이렇게 정리했어요.';
}
