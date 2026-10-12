import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  allowedReplyStatuses,
  assessInterpretation,
  computeRank,
  type PointInput,
  validateInterpretations,
} from "./interpretation.ts";

const base: PointInput = {
  kind: "fix",
  location: { judgment: "explicit", path: "src/a.ts", line: 3, reason: "行コメント" },
  intent: { judgment: "clear", reason: "期待が明記" },
  scope: { judgment: "local", reason: "1 行" },
  plan: "型を付ける",
};
const item = (key: string, ...points: unknown[]) => ({ key, points });

describe("computeRank（§3-3 の表）", () => {
  const rank = (patch: Partial<Record<"location" | "intent" | "scope", string>>, kind = "fix") =>
    computeRank({
      kind: kind as never,
      location: { ...base.location, judgment: (patch.location ?? "explicit") as never },
      intent: { ...base.intent, judgment: (patch.intent ?? "clear") as never },
      scope: { ...base.scope, judgment: (patch.scope ?? "local") as never },
    }).rank;

  test("high", () => {
    assert.equal(rank({}), "high");
    assert.equal(rank({ location: "inferred_unique" }), "high");
  });
  test("low", () => {
    assert.equal(rank({ location: "unknown" }), "low");
    assert.equal(rank({ intent: "ambiguous" }), "low");
    assert.equal(rank({ location: "unknown", scope: "wide" }), "low");
  });
  test("mid", () => {
    assert.equal(rank({ location: "inferred_multiple" }), "mid");
    assert.equal(rank({ scope: "wide" }), "mid");
  });
  test("fix 以外にはランクを付けない", () => {
    assert.equal(rank({}, "answer"), null);
  });
  test("理由を返す", () => {
    assert.deepEqual(computeRank({ ...base, scope: { judgment: "wide", reason: "" } }).reasons, ["影響範囲が広い"]);
  });
});

describe("validateInterpretations", () => {
  test("正しい入力。RC- 付きの key も受け付ける", () => {
    const { items, errors } = validateInterpretations([item("RC-10", base)]);
    assert.deepEqual(errors, []);
    assert.equal(items[0].key, "10");
    assert.equal(items[0].points.length, 1);
  });

  test("分割した key と、points のない以前の形は受け付けない（§7-8）", () => {
    assert.match(validateInterpretations([item("RC-10#2", base)]).errors.join(), /分割しません/);
    assert.match(validateInterpretations([{ key: "10", ...base }]).errors.join(), /points/);
    assert.match(validateInterpretations([item("10")]).errors.join(), /points/);
  });

  test("論点が複数あるときは、論点ごとに summary が必要", () => {
    assert.match(validateInterpretations([item("10", base, base)]).errors.join(), /summary/);
    assert.deepEqual(validateInterpretations([item("10", { ...base, summary: "a" }, { ...base, summary: "b" })]).errors, []);
  });

  test("不正な値と重複を検出する", () => {
    const { errors } = validateInterpretations([
      item("9", { ...base, kind: "maybe" }),
      item("10", { ...base, location: { judgment: "explicit", path: null, line: null, reason: "x" } }),
      item("11", { ...base, intent: { judgment: "clear" } }),
      item("11", base),
    ]);
    assert.equal(errors.length, 4);
    assert.match(errors.join("\n"), /points\[0\] kind/);
    assert.match(errors.join("\n"), /location\.path/);
    assert.match(errors.join("\n"), /intent/);
    assert.match(errors.join("\n"), /重複/);
  });

  test("リポジトリの外を指すパスは受け付けない（R-5）", () => {
    for (const path of ["../secret.ts", "/etc/passwd", "src/../../x.ts", "C:/x.ts", "src\\x.ts"]) {
      assert.match(validateInterpretations([item("10", { ...base, location: { ...base.location, path } })]).errors.join(), /相対パス/, path);
    }
    const docs = { ...base, scope: { judgment: "local_with_docs", reason: "r", docs: ["../docs/a.md"] } };
    assert.match(validateInterpretations([item("10", docs)]).errors.join(), /scope\.docs が不正/);
    assert.deepEqual(validateInterpretations([item("10", { ...base, location: { ...base.location, path: "./src/a..b.ts" } })]).errors, []);
  });

  test("エージェントがランクを書いても無視される（ランクは CLI が決める）", () => {
    const { items } = validateInterpretations([item("10", { ...base, rank: "high", scope: { judgment: "wide", reason: "広い" } })]);
    assert.equal("rank" in items[0].points[0], false);
    assert.equal(assessInterpretation(items[0].points).rank, "mid");
  });
});

describe("論点の組み合わせと返信の状態（§3-3「論点と指摘全体」）", () => {
  const p = (kind: string, patch: Partial<PointInput> = {}): PointInput => ({ ...base, kind: kind as never, ...patch });
  const low = p("fix", { intent: { judgment: "ambiguous", reason: "x" } });
  const docs = p("fix", { scope: { judgment: "local_with_docs", reason: "r", docs: ["docs/a.md"] } });
  const status = (...points: PointInput[]) => assessInterpretation(points).replyStatus;

  test("論点が 1 つなら、これまでの判定と同じ", () => {
    assert.equal(status(p("fix")), "fixed");
    assert.equal(status(low), "needs_info");
    assert.equal(status(p("answer")), "answered");
    assert.equal(status(p("needs_info")), "needs_info");
    assert.equal(status(p("wontfix")), "wontfix");
    assert.equal(status(p("not_actionable")), null);
  });

  test("直し方の決まらない論点が 1 つでもあれば、何も直さず needs_info。ランクはいちばん低いもの", () => {
    const a = assessInterpretation([p("fix"), low]);
    assert.equal(a.replyStatus, "needs_info");
    assert.equal(a.rank, "low");
    assert.deepEqual(a.rankReasons, ["論点 2: 直し方が 1 通りに決まらない"]);
    assert.deepEqual(allowedReplyStatuses(a), ["needs_info"]);
    assert.equal(status(p("fix"), p("needs_info")), "needs_info");
  });

  test("見送りたい論点がほかの論点と混ざっていれば、見送ってよいかを聞く", () => {
    const a = assessInterpretation([p("fix"), p("wontfix")]);
    assert.equal(a.replyStatus, "needs_info");
    assert.match(a.rankReasons.join(), /見送り/);
    assert.equal(status(p("answer"), p("wontfix")), "needs_info");
    assert.equal(status(p("wontfix"), p("not_actionable")), "wontfix");
  });

  test("fix がすべて high なら fixed。answer の論点は同じ返信で答える", () => {
    assert.equal(status(p("fix"), p("fix"), p("answer"), p("not_actionable")), "fixed");
    assert.equal(status(p("answer"), p("not_actionable")), "answered");
    assert.equal(status(p("not_actionable"), p("not_actionable")), null);
    assert.deepEqual(allowedReplyStatuses(assessInterpretation([p("not_actionable")])), []);
  });

  test("仕様書の更新だけが理由なら、利用者が選べば修正（fixed か needs_info）", () => {
    const a = assessInterpretation([p("fix"), docs]);
    assert.equal(a.rank, "mid");
    assert.equal(a.fixableWithApproval, true);
    assert.deepEqual(allowedReplyStatuses(a), ["fixed", "needs_info"]);
  });

  test("ほかに判断の要る論点があれば、利用者が選んでも修正しない", () => {
    assert.equal(assessInterpretation([docs, low]).fixableWithApproval, false);
    assert.equal(assessInterpretation([docs, p("needs_info")]).fixableWithApproval, false);
    assert.equal(assessInterpretation([docs, p("wontfix")]).fixableWithApproval, false);
  });
});

describe("仕様書の更新を伴う修正（§3-3, §7-4 の例外）", () => {
  const withDocs = { ...base, scope: { judgment: "local_with_docs" as const, reason: "design.md の関数名も変わる", docs: [".kiro/specs/order/design.md"] } };

  test("local_with_docs は mid。理由が仕様書の更新だけなら、利用者が選べば修正してよい", () => {
    assert.deepEqual(computeRank(withDocs), { rank: "mid", reasons: ["仕様書の更新が必要"], fixableWithApproval: true });
  });

  test("ほかにも mid の理由があれば、利用者が選んでも修正しない", () => {
    const r = computeRank({ ...withDocs, location: { ...base.location, judgment: "inferred_multiple" } });
    assert.equal(r.rank, "mid");
    assert.equal(r.fixableWithApproval, false);
  });

  test("low や high、fix 以外には付かない", () => {
    assert.equal(computeRank({ ...withDocs, intent: { judgment: "ambiguous", reason: "x" } }).fixableWithApproval, false);
    assert.equal(computeRank(base).fixableWithApproval, false);
    assert.equal(computeRank({ ...withDocs, kind: "answer" }).fixableWithApproval, false);
  });

  test("local_with_docs には直す仕様書のパスが必要。パスは安全なものに限る", () => {
    assert.deepEqual(validateInterpretations([item("10", withDocs)]).errors, []);
    assert.match(
      validateInterpretations([item("10", { ...withDocs, scope: { judgment: "local_with_docs", reason: "r" } })]).errors.join(),
      /scope\.docs/,
    );
    assert.match(
      validateInterpretations([item("10", { ...withDocs, scope: { ...withDocs.scope, docs: ["docs/a'b.md"] } })]).errors.join(),
      /scope\.docs が不正/,
    );
    assert.deepEqual(validateInterpretations([item("10", withDocs)]).items[0].points[0].scope.docs, [".kiro/specs/order/design.md"]);
  });
});
