/**
 * Engineering Workflow — saf fonksiyon testleri.
 *
 * Pi ExtensionAPI/Context gerektirmez; yalnız kapı mantığının çekirdeğini
 * (hash, kapsam regex'i, placeholder taraması, plan bölüm ayrıştırma) test eder.
 *
 * Çalıştırma (Node >= 22.6, yerleşik TS type-stripping):
 *   node --test engineering-workflow.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PHASE_MODEL_CHAINS,
  bulletLines,
  containsPlaceholderText,
  extractAcceptanceCriteria,
  extractScopePatterns,
  hashText,
  isPhaseModel,
  patternToRegex,
  placeholderHits,
  section,
  selectPhaseModel,
} from "../src/engineering-workflow.ts";

test("hashText deterministik ve içeriğe duyarlı", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  assert.equal(hashText("abc").length, 64);
});

test("patternToRegex anlamsız desenleri reddeder", () => {
  assert.equal(patternToRegex(""), null);
  assert.equal(patternToRegex("  "), null);
  assert.equal(patternToRegex("<dosya>"), null);
  assert.equal(patternToRegex("none"), null);
  assert.equal(patternToRegex("yok"), null);
});

test("patternToRegex kapsam eşleşmesi", () => {
  const re = patternToRegex("app/*");
  assert.ok(re);
  assert.ok(re!.test("app/main.py"));
  assert.ok(re!.test("app/sub/deep.ts"));
  assert.ok(!re!.test("other/x.py"));
});

test("placeholderHits placeholder'ları satır numarasıyla bulur", () => {
  const lines = placeholderHits("x = 1\n# TODO: bitir\n    pass\n").map((h) => h.line);
  assert.ok(lines.includes(2), `TODO satırı bulunamadı: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes(3), `pass satırı bulunamadı: ${JSON.stringify(lines)}`);
});

test("placeholderHits temiz kodda boş döner (yanlış pozitif yok)", () => {
  assert.deepEqual(placeholderHits("const x = 1;\n"), []);
  assert.deepEqual(placeholderHits('const pasword = "pass";\n'), []);
});

test("containsPlaceholderText şablon placeholder'ını yakalar", () => {
  assert.equal(containsPlaceholderText("## 1. Problem\n- <ne?>"), true);
  assert.equal(containsPlaceholderText("## 1. Problem\n- gerçek içerik"), false);
});

test("section ve bulletLines plan bölümlerini ayıklar", () => {
  const plan =
    "## 6. Kabul Kriterleri\n- [ ] KR-1: test\n- [x] KR-2: bitti\n\n## 7. Kapsam İçi\n- a\n";
  assert.match(section(plan, 6), /KR-1/);
  assert.deepEqual(extractAcceptanceCriteria(plan), ["KR-1: test", "KR-2: bitti"]);
  assert.deepEqual(bulletLines(section(plan, 7)), ["a"]);
});

test("extractScopePatterns dosya desenlerini ayıklar", () => {
  const arch = "## 10. Etkilenecek Dosyalar ve Modüller\n- app/*\n- tests/*\n- NONE\n";
  assert.deepEqual(extractScopePatterns(arch), ["app/*", "tests/*"]);
});

// --- E1: faz model fallback zinciri -----------------------------------------

function modelFromRef(ref: string) {
  const i = ref.indexOf("/");
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

function fakeCtx(models: Array<{ provider: string; id: string }>) {
  const notices: string[] = [];
  return {
    ctx: {
      workspaceRoot: process.cwd(),
      model: undefined,
      // Gerçek ModelRegistry yüzeyi: find() + getAll(). getAllModels yok.
      modelRegistry: {
        find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
        getAll: () => models,
      },
      ui: { setStatus: () => {}, notify: (m: string) => { notices.push(m); } },
    } as any,
    notices,
  };
}

function fakePi(acceptAfter = 0) {
  const calls: string[] = [];
  return {
    pi: { setModel: async (m: any) => { calls.push(`${m.provider}/${m.id}`); return calls.length > acceptAfter; } } as any,
    calls,
  };
}

test("selectPhaseModel zincirdeki ilk kullanılabilir modeli seçer", async () => {
  const last = modelFromRef(PHASE_MODEL_CHAINS.PLAN.at(-1)!);
  const { ctx } = fakeCtx([last]);
  const { pi, calls } = fakePi();
  assert.equal(await selectPhaseModel(pi, ctx, "PLAN"), `${last.provider}/${last.id}`);
  assert.deepEqual(calls, [`${last.provider}/${last.id}`]);
});

test("selectPhaseModel setModel reddederse sıradaki modele düşer", async () => {
  const first = modelFromRef(PHASE_MODEL_CHAINS.PLAN[0]);
  const second = modelFromRef(PHASE_MODEL_CHAINS.PLAN[1]);
  const { ctx } = fakeCtx([first, second]);
  const { pi, calls } = fakePi(1); // ilk çağrı reddedilir
  assert.equal(await selectPhaseModel(pi, ctx, "PLAN"), `${second.provider}/${second.id}`);
  assert.deepEqual(calls, [`${first.provider}/${first.id}`, `${second.provider}/${second.id}`]);
});

test("selectPhaseModel hiçbiri yoksa null döner ve hata bildirir", async () => {
  const { ctx, notices } = fakeCtx([]);
  const { pi } = fakePi();
  assert.equal(await selectPhaseModel(pi, ctx, "PLAN"), null);
  assert.ok(notices.some((m) => m.includes("MODEL SEÇİMİ BAŞARISIZ")));
});

// Regresyon: OpenRouter üç parçalı çözülür (openrouter/qwen/...), zincir iki
// parçalı yazar (qwen/...). Sağlayıcı öneki farkı eşleşmeyi bozmamalı.
test("selectPhaseModel sağlayıcı önekli çözülmüş kimliği tanır", async () => {
  const first = modelFromRef(PHASE_MODEL_CHAINS.PLAN[0]);
  const resolved = { provider: "openrouter", id: `${first.provider}/${first.id}` };
  const { ctx } = fakeCtx([resolved]);
  ctx.model = resolved;
  const { pi, calls } = fakePi();
  const expected = `openrouter/${first.provider}/${first.id}`;
  assert.equal(await selectPhaseModel(pi, ctx, "PLAN"), expected);
  assert.deepEqual(calls, [], "mevcut model zaten zincirde; yeniden setModel gerekmez");
  assert.equal(isPhaseModel(expected), true);
  assert.equal(isPhaseModel(`openrouter/${first.provider}/${first.id}`.replace(/\./g, "-")), true);
});

test("placeholderHits aynı dosyadaki tüm eşleşmeleri satır numarasıyla bulur", () => {
  const hits = placeholderHits("// TODO: bir\n// FIXME: iki\n// TODO: üç\n");
  assert.deepEqual(hits.map((h) => h.line), [1, 2, 3]);
});

test("patternToRegex glob dışı ? karakterini kaçırır", () => {
  const re = patternToRegex("src/file?.ts");
  assert.ok(re);
  assert.ok(re!.test("src/file?.ts"));
  assert.ok(!re!.test("src/file.ts"));
});
