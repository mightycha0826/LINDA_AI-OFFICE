// GitHub 저장소 만들기 (11장 새 프로젝트 만들기). Git 고양이만 부른다.
// - 항상 비공개로 만든다. 이 값은 상수다. 설정·명령·AI 출력으로 바꿀 길을 만들지 않는다.
// - README로 첫 커밋을 만들어 기본 브랜치가 생기게 한다(worktree는 기본 브랜치에서 만든다).
// - 토큰은 이 요청의 헤더에만 넣는다. 오류 메시지에는 GitHub가 돌려준 말만 싣고 토큰은 싣지 않는다.
import { OfficeError } from '../errors.ts';

export const NEW_REPO_PRIVATE = true as const;
const API = 'https://api.github.com/user/repos';
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export interface CreatedRepo {
  /** 등록에 쓰는 https 주소 (…/이름.git) */
  repoUrl: string;
  htmlUrl: string;
  defaultBranch: string;
}

export async function createGithubRepo(o: { token: string; name: string; description?: string; fetchImpl?: typeof fetch }): Promise<CreatedRepo> {
  if (!NAME.test(o.name)) throw new OfficeError('repo', `저장소 이름은 영문 소문자·숫자·-만 써요: ${o.name}`);
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: o.name, private: NEW_REPO_PRIVATE, auto_init: true, ...(o.description ? { description: o.description.slice(0, 300) } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new OfficeError('repo', `GitHub에 연결하지 못했어요: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as { clone_url?: string; html_url?: string; default_branch?: string; message?: string; errors?: { message?: string }[] };
  if (res.status === 201 && body.clone_url && body.html_url) {
    return { repoUrl: body.clone_url, htmlUrl: body.html_url, defaultBranch: body.default_branch ?? 'main' };
  }
  const detail = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join(' / ').slice(0, 300);
  if (res.status === 422) throw new OfficeError('repo-exists', `GitHub에 같은 이름(${o.name})의 저장소가 이미 있어요. 그 저장소를 쓰려면 /프로젝트로 등록해 주세요 (${detail})`);
  if (res.status === 401 || res.status === 403) {
    throw new OfficeError('repo-auth', `GitHub가 저장소 만들기를 거부했어요(${res.status}). 토큰이 모든 저장소에 Administration·Contents 쓰기 권한을 갖는지 확인해 주세요 (${detail})`);
  }
  throw new OfficeError('repo', `GitHub 저장소 만들기 실패(${res.status}): ${detail}`);
}
