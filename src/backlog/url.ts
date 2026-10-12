export type PullRequestRef = {
  space: string;
  projectKey: string;
  repoName: string;
  number: number;
};

const PATH_PATTERN = /^\/git\/([A-Z0-9_]+)\/([A-Za-z0-9._-]+)\/pullRequests\/([0-9]+)\/?$/;
const ALLOWED_HOST_SUFFIXES = [".backlog.jp", ".backlog.com"];

/**
 * Backlog の PR URL を解析する。
 * API キーを送る先になるため、ホストは BACKLOG_SPACE と一致するもの、
 * 未設定なら Backlog のドメインに限る。
 */
export function parsePullRequestUrl(input: string, expectedSpace?: string): PullRequestRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`URL として解釈できません: ${input}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("https の URL を指定してください");
  }

  const host = url.hostname.toLowerCase();
  if (expectedSpace) {
    if (host !== expectedSpace.toLowerCase()) {
      throw new Error(`ホスト ${host} が BACKLOG_SPACE (${expectedSpace}) と一致しません`);
    }
  } else if (!ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`Backlog のドメインではありません: ${host}`);
  }

  const match = PATH_PATTERN.exec(url.pathname);
  if (!match) {
    throw new Error("PR の URL の形式ではありません（例: https://{space}/git/{PROJECT}/{repo}/pullRequests/{number}）");
  }

  // ".." などはパスとして解釈され、API の別のエンドポイントを指してしまう
  if (/^\.+$/.test(match[2])) {
    throw new Error(`リポジトリ名が不正です: ${match[2]}`);
  }

  return {
    space: host,
    projectKey: match[1],
    repoName: match[2],
    number: Number(match[3]),
  };
}
