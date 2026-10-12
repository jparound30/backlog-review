/** 信頼できない文字列（コメント・パス・状態ファイル由来の文）を扱うための関数（§6-1） */

/**
 * 表示を偽装できる文字。端末の表示を書き換える制御文字（ANSI エスケープを含む C0・DEL・C1）、
 * 文字の並びを逆に見せる bidi の制御文字、行や段落を区切る U+2028 / U+2029
 */
const DECEPTIVE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/** 端末に出す前に、表示を偽装できる文字を取り除く。改行とタブは残す */
export function sanitizeForTerminal(text: string): string {
  return text.replace(DECEPTIVE, "");
}

/**
 * リポジトリの中を指す相対パスか（R-5）。絶対パス・ドライブ文字・`\`・`..` の区切りを含むものは、
 * リポジトリの外を指しうるので受け付けない
 */
export function isRepoRelativePath(path: string): boolean {
  return !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.includes("\\") && !path.split("/").includes("..");
}

/**
 * 単一引用符で囲んでもシェルで安全に扱えない、または表示を偽装できるパス。
 * `'`・制御文字・bidi の制御文字・U+2028/2029 を含むもの、`-` で始まるもの
 */
export function isUnsafePath(path: string): boolean {
  return /['\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(path) || path.startsWith("-");
}
