// 규칙 위반은 모두 예외로 거부한다. code로 종류를 구분한다.

export class OfficeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 전환표에 없는 전환, 조건 불충족, 요청 주체가 아닌 경우 */
export class TransitionRejected extends OfficeError {}

/** 결재 버튼을 CEO 계정이 아닌 사람이 누름 */
export class NotCeoError extends OfficeError {
  constructor() {
    super('not-ceo', 'CEO 계정이 아니라서 처리하지 않았어요');
  }
}

/** 이미 결정된 결재를 다시 누름 (두 번 클릭) */
export class AlreadyDecidedError extends OfficeError {
  constructor() {
    super('already-decided', '이미 처리된 결재예요');
  }
}

/** 오래된 결재 버튼 (계획서 v2가 올라온 뒤 v1 버튼) */
export class StaleApprovalError extends OfficeError {
  constructor() {
    super('stale', '새 버전이 있어요');
  }
}

/** 같은 행을 다른 쓰기가 먼저 바꿈. 다시 읽고 판단해야 한다. */
export class ConcurrentUpdateError extends OfficeError {
  constructor(what: string) {
    super('concurrent-update', `${what}이(가) 그사이 바뀌었어요`);
  }
}

export class NotFoundError extends OfficeError {
  constructor(what: string) {
    super('not-found', `${what}을(를) 찾지 못했어요`);
  }
}

/** AI 출력이 두 번 연속 형식 검사를 통과하지 못함 (6장) */
export class FormatError extends OfficeError {
  readonly issues: string;

  constructor(issues: string) {
    super('format-error', `AI 출력 형식 오류: ${issues}`);
    this.issues = issues;
  }
}

/** 계획서가 코드 규칙(직원 존재, 검토자 모델 등)을 어김 */
export class PlanRuleError extends OfficeError {
  readonly problems: string[];

  constructor(problems: string[]) {
    super('plan-rule', `계획서 규칙 위반: ${problems.join('; ')}`);
    this.problems = problems;
  }
}
