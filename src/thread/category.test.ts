import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { CATEGORIES, categoryFromText, formatCategoryLine, parseCategoryLine, parseReplyCategoryLine } from "./category.ts";

describe("指摘の分類（§4-8）", () => {
  test("表示名かコードで読む。全角・半角と空白の揺れはそろえ、一覧にないものは読まない", () => {
    assert.equal(categoryFromText("エラー処理"), "error_handling");
    assert.equal(categoryFromText(" error_handling "), "error_handling");
    assert.equal(categoryFromText("ＳＥＣＵＲＩＴＹ"), "security");
    assert.equal(categoryFromText("設計 ・ 保守性"), "design");
    assert.equal(categoryFromText("バグ"), null);
    assert.equal(categoryFromText("エラー処理（例外）"), null);
  });

  test("本文の `分類:` の行は、行の先頭のものだけ読む。全角のコロンも受け付ける", () => {
    assert.equal(parseCategoryLine("場所: a.ts L1\n分類: 性能\n指摘: x"), "performance");
    assert.equal(parseCategoryLine("分類：テスト"), "test");
    assert.equal(parseCategoryLine("この分類: 性能 は違う"), null);
    assert.equal(parseCategoryLine("指摘だけ"), null);
  });

  test("書いた行を読み戻せる", () => {
    for (const { code } of CATEGORIES) {
      assert.equal(parseCategoryLine(formatCategoryLine(code)), code);
      assert.equal(parseReplyCategoryLine(`**分類**: ${formatCategoryLine(code).slice("分類: ".length)}`), code);
    }
    assert.equal(parseReplyCategoryLine("**回答**: **分類**: 性能"), null);
  });
});
