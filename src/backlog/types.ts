/** Backlog API のレスポンスのうち、本ツールで使うフィールドだけを定義する */

export type BacklogUser = {
  id: number;
  userId: string | null;
  name: string;
};

export type BacklogPullRequest = {
  id: number;
  number: number;
  summary: string;
  description: string;
  base: string;
  branch: string;
  status: { id: number; name: string };
  createdUser: BacklogUser;
};

export type BacklogComment = {
  id: number;
  content: string | null;
  createdUser: BacklogUser;
  created: string;
  updated: string;
  // 以下の 4 つは公式ドキュメントにないフィールド（§2-1）。将来なくなる可能性を考え省略可能にする
  filePath?: string | null;
  position?: number | null;
  oldBlobId?: string | null;
  newBlobId?: string | null;
};
