// 모델 호출 없이 구조화된 내부 기록을 Discord용 문단·목록으로 바꾼다.
const LABELS: Record<string, string> = {
  summary: '요약', changedFiles: '변경 파일', criteriaSelfCheck: '완료 조건 자체 점검', criterion: '완료 조건', claimed: '자체 확인',
  notes: '참고', document: '문서', claims: '주장과 근거', text: '내용', sources: '근거 링크', noSource: '근거 없음',
  verdict: '검토 결과', criteria: '완료 조건 점검', pass: '통과 여부', reason: '이유', reasonCategory: '반려 분류', fixRequests: '수정 요청',
  claim: '의견', agree: '동의 여부', nextActions: '다음 할 일', issues: '지적 사항', missingCriteria: '빠진 완료 조건',
  kind: '종류', where: '위치', note: '설명', passed: '통과 여부', objection: '반대 의견', goal: '목표', questions: '확인할 내용',
  tickets: '작업 목록', title: '제목', type: '종류', assignee: '담당', reviewer: '검토', acceptanceCriteria: '완료 조건',
  needsCeoApproval: 'CEO 결재 필요', estimatedTokens: '예상 토큰', understanding: '이해한 내용', lines: '안내',
  whatWrong: '문제', why: '원인', preventAt: '예방 단계', confirmed: '확인 여부',
};
const VALUES: Record<string, string> = {
  pass: '통과', fail: '반려', spelling: '맞춤법', tone: '말투', missing: '누락', unclear: '불명확',
  'criteria-unmet': '완료 조건 미충족', 'test-failed': '테스트 실패', 'no-source': '근거 없음',
};

/** 업무 출력의 의미를 보존하면서 직원 본인의 설명으로 바꾼다. 모델이 없어도 원본 필드를 보여 주지 않는다. */
function workText(row: Record<string, unknown>): string | null {
  const list = (value: unknown) => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  if (typeof row.text === 'string' && (typeof row.intent === 'string' || Object.keys(row).length === 1)) return row.text;
  if (typeof row.summary === 'string' && Array.isArray(row.changedFiles)) {
    if (Array.isArray(row.criteriaSelfCheck) && !row.criteriaSelfCheck.every((x) => x && typeof x.criterion === 'string' && typeof x.claimed === 'boolean')) return null;
    const checks = Array.isArray(row.criteriaSelfCheck) ? row.criteriaSelfCheck as { criterion: string; claimed: boolean }[] : [];
    return [row.summary, list(row.changedFiles).length ? `이번에 손본 파일이에요.\n${bullets(list(row.changedFiles))}` : '',
      checks.length ? `제가 확인한 내용이에요. 최종 판정은 검토를 거쳐야 해요.\n${bullets(checks.map((x) => `${x.criterion}: ${x.claimed ? '자체 확인' : '아직 확인하지 못함'}`))}` : '',
      typeof row.notes === 'string' ? row.notes : ''].filter(Boolean).join('\n\n');
  }
  if ((row.verdict === 'pass' || row.verdict === 'fail') && Array.isArray(row.fixRequests)) {
    if (Array.isArray(row.criteria) && !row.criteria.every((x) => x && typeof x.criterion === 'string' && typeof x.pass === 'boolean')) return null;
    const checks = Array.isArray(row.criteria) ? row.criteria as { criterion: string; pass: boolean; reason?: string }[] : [];
    return [row.verdict === 'pass' ? '검토를 마쳤어요. 정해 둔 완료 조건을 통과했어요.' : '검토해 보니 아직 보완할 부분이 있어요.',
      checks.length ? bullets(checks.map((x) => `${x.criterion}: ${x.pass ? '통과' : '보완 필요'}${x.reason ? ` — ${x.reason}` : ''}`)) : '',
      row.reasonCategory ? `보완이 필요한 이유는 ${VALUES[String(row.reasonCategory)] ?? row.reasonCategory}이에요.` : '',
      list(row.fixRequests).length ? `이렇게 고쳐 주시겠어요?\n${bullets(list(row.fixRequests))}` : ''].filter(Boolean).join('\n\n');
  }
  if (Array.isArray(row.issues) && Array.isArray(row.missingCriteria)) {
    if (!row.issues.every((x) => x && typeof x === 'object')) return null;
    const issues = row.issues as { where?: string; note?: string; kind?: string }[];
    return [issues.length ? `글을 살펴보니 이 부분을 다듬으면 좋겠어요.\n${bullets(issues.map((x) => `${x.where ?? '본문'}: ${x.note ?? VALUES[x.kind ?? ''] ?? '확인이 필요해요'}`))}` : '이번 점검에서 문장상 고칠 부분은 찾지 못했어요.',
      list(row.missingCriteria).length ? `요청하신 내용 중 빠진 부분도 있어요.\n${bullets(list(row.missingCriteria))}` : ''].filter(Boolean).join('\n\n');
  }
  if (typeof row.document === 'string' && Array.isArray(row.claims)) {
    if (!row.claims.every((x) => x && typeof x.text === 'string' && Array.isArray(x.sources))) return null;
    const claims = row.claims as { text: string; sources: string[]; noSource?: boolean }[];
    return [row.document, claims.length ? `근거도 함께 정리했어요.\n${bullets(claims.map((x) => `${x.text}\n  ${x.noSource || !x.sources.length ? '근거를 확인하지 못했어요.\n  ' : ''}${x.sources.join('\n  ')}`.trimEnd()))}` : ''].filter(Boolean).join('\n\n');
  }
  if (typeof row.claim === 'string' && typeof row.agree === 'boolean') {
    return [row.agree ? '저도 그 방향에 동의해요.' : '저는 다른 의견이 있어요.', row.claim,
      list(row.nextActions).length ? `다음에는 이렇게 하면 좋겠어요.\n${bullets(list(row.nextActions))}` : ''].filter(Boolean).join('\n\n');
  }
  return null;
}

/** 대화 본문에 잘못 끼어든 응답 봉투만 벗긴다. 사용자가 요청한 코드·JSON 예시는 보존한다. */
export function staffReplyText(content: string): string {
  let text = content.trim();
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = text.replace(/^```(?:json)?\s*\n?([\s\S]*?)```$/i, '$1').trim();
    try {
      const row: unknown = JSON.parse(candidate);
      if (!row || typeof row !== 'object' || Array.isArray(row) || !('text' in row) || typeof row.text !== 'string') break;
      text = row.text.trim();
    } catch { break; }
  }
  return replaceJsonValues(text, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    return typeof row.text === 'string' && ['chat', 'order', 'revise'].includes(String(row.intent)) ? row.text : null;
  });
}

function valueText(value: unknown, depth = 0): string {
  if (value === null) return '없음';
  if (typeof value === 'boolean') return value ? '예' : '아니요';
  if (typeof value !== 'object') return VALUES[String(value)] ?? String(value);
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return '없음';
    return value.map((item) => `${indent}- ${valueText(item, depth + 1).trimStart()}`).join('\n');
  }
  const human = workText(value as Record<string, unknown>);
  if (human !== null) return staffReplyText(human);
  return Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const label = LABELS[key] ?? key;
    const nested = child !== null && typeof child === 'object' && Object.keys(child).length > 0;
    return `${indent}${depth === 0 ? `**${label}**` : label}${nested ? '\n' : ': '}${valueText(child, depth + (nested ? 1 : 0))}`;
  }).join('\n');
}

/** 같은 줄의 접두사 뒤 JSON, 코드 펜스, 여러 JSON 블록도 처리한다. 일반 문장과 코드는 보존한다. */
export function readableDiscordText(content: string): string {
  return replaceJsonValues(content, (value) => valueText(value));
}

function replaceJsonValues(content: string, render: (value: unknown) => string | null): string {
  const input = content.replace(/```(?:json)?\s*\n?([\s\S]*?)```/gi, (whole, body: string) => {
    try { return render(JSON.parse(body.trim())) ?? whole; } catch { return whole; }
  });
  let result = '';
  let cursor = 0;
  for (let start = 0; start < input.length; start++) {
    if (input[start] !== '{' && input[start] !== '[') continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let end = start; end < input.length; end++) {
      const char = input[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const open = stack.pop();
        if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) break;
        if (!stack.length) {
          try {
            const parsed: unknown = JSON.parse(input.slice(start, end + 1));
            const rendered = render(parsed);
            if (rendered === null) { start = end; break; }
            const prefix = input.slice(cursor, start);
            result += prefix + (prefix && !prefix.endsWith('\n') ? '\n' : '') + rendered;
            cursor = end + 1;
            start = end;
          } catch { /* Markdown의 대괄호 등은 보존한다. */ }
          break;
        }
      }
    }
  }
  return (result + input.slice(cursor)).trim();
}

/** 문단·줄 경계를 우선하고 Discord의 UTF-16 길이 제한도 지킨다. 생략하지 않는다. */
export function discordChunks(content: string, max = 1900, readable = true): string[] {
  let remaining = readable ? readableDiscordText(content) : content.trim();
  const chunks: string[] = [];
  while (remaining.length > max) {
    let end = remaining.lastIndexOf('\n', max);
    if (end < max / 2) end = max;
    if (/^[\uDC00-\uDFFF]$/.test(remaining[end] ?? '')) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
    if (remaining.startsWith('\n')) remaining = remaining.slice(1);
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ['내용이 없어요'];
}
