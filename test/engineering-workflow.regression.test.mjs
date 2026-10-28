/**
 * Engineering Workflow — kapı/orkestrasyon regresyon testleri.
 *
 * Extension'ı sahte Pi API'siyle uçtan uca sürer: plan → mimari → implement →
 * verify. Model/LLM çağrısı yoktur; yalnız dosya, state ve gate mantığı test
 * edilir.
 *
 * Çalıştırma:
 *   node --test workflow-regression.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import engineeringWorkflow, { PHASE_MODEL_CHAINS } from "../src/engineering-workflow.ts";

const MODELS = [...new Set(Object.values(PHASE_MODEL_CHAINS).flat())].map((ref) => {
  const i = ref.indexOf("/");
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
});

const PLAN = `# PLAN: fixture

## 1. Problem ve Gerçeklik Kontrolü
- Problem: test
- Neden gerekli: test
- Varsayımlar: yok
- Mevcut durum: fixture

## 2. Araştırma ve Kanıt
- Kaynak / kanıt 1: test dosyası
- Doğrulanmış bilgiler: fixture
- Bilinmeyenler: yok
- Araştırma yolu: test komutu ile doğrula

## 3. Fayda / Maliyet
- Fayda: test
- Maliyet: test
- Alternatiften maliyet farkı: test
- Değer gerekçesi: test

## 4. Alternatifler (en az 2)
### A. birinci
- Artıları: hızlı
- Eksileri: yok
- Risk: düşük
- Tahmini karmaşıklık: düşük

### B. ikinci
- Artıları: sağlam
- Eksileri: yavaş
- Risk: düşük
- Tahmini karmaşıklık: orta

### Seçim ve gerekçe
A seçildi.

## 5. Yapılabilirlik / Feasibility Verification
- Teknik olarak mümkün mü?: evet
- Dayanak: fixture
- Harici bağımlılıklar: yok
- Kritik kısıtlar: yok
- Maliyet / kota / limit: yok
- Açık teknik belirsizlikler: yok

## 6. Kabul Kriterleri
- [ ] KR-1: fixture testi geçer — doğrulama yöntemi: test

## 7. Kapsam İçi
- src

## 8. Kapsam Dışı
- diğer

## 9. Riskler ve Bağımlılıklar
- Risk: yok — önlem: yok

## 10. Önerilen Plan
1. uygula

## 11. Çalışabilirlik Durumu
- Uygulama ayağa kalkıyor mu: evet
\`\`\`
$ node -e "process.exit(0)"
ok
\`\`\`
- Çekirdek akışlar: çalışıyor
`;

const ARCH = `# ARCHITECTURE: fixture

## 1. Mimari Hedef
hedef

## 2. Mevcut Sistem Analizi
- Mevcut bileşenler: src

## 3. Önerilen Mimari
basit

## 4. Bileşenler ve Sorumluluklar
- app: iş

## 5. Veri ve Kontrol Akışı
app -> test

## 6. API / Interface / Veri Sözleşmeleri
- Girdi: yok

## 7. Bağımlılıklar ve Yapılabilirlik
- Yeni bağımlılık: yok

## 8. Hata / Güvenlik / Performans
- Hata senaryoları: yok

## 9. Test Stratejisi
- Unit: test

## 10. Etkilenecek Dosyalar ve Modüller
- src/*

## 11. Mimari Kararlar
- Karar: basit

## 12. Açık Konular
- NONE

## 13. Kalite Baseline ve Audit Bulguları
- Audit kaynağı: fixture
- Audit bulgusu yoksa: NONE
`;

function makeProject({ git = false, testCommand = 'node -e "process.exit(0)"', confirm = true, hasUI = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "eng-regression-"));
  writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}\n');
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), "export const x = 1;\n");
  mkdirSync(path.join(dir, "other"), { recursive: true });
  writeFileSync(path.join(dir, "other", "x.ts"), "export const y = 1;\n");
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  }
  const notices = [];
  let handler;
  const pi = {
    on: () => {},
    registerCommand: (_name, opts) => { handler = opts.handler; },
    setModel: async () => true,
    sendUserMessage: () => {},
  };
  const ctx = {
    workspaceRoot: dir,
    hasUI,
    model: { provider: "qwen", id: "qwen3.8-max-0902" },
    modelRegistry: {
      find: (p, id) => MODELS.find((m) => m.provider === p && m.id === id),
      getAll: () => MODELS,
    },
    ui: {
      setStatus: () => {},
      notify: (m) => { notices.push(m); },
      confirm: async () => confirm,
    },
  };
  engineeringWorkflow(pi);
  return {
    dir,
    ctx,
    run: (args) => handler(args, ctx),
    notices,
    testCommand,
  };
}

function stateOf(p) {
  return JSON.parse(readFileSync(path.join(p.dir, ".engineering-agent", "state.json"), "utf8"));
}

async function bootstrap(p, { audit = true } = {}) {
  await p.run("init");
  const cfgPath = path.join(p.dir, ".engineering-agent", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.commands.test = p.testCommand;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  await p.run("plan fixture");
  writeFileSync(path.join(p.dir, ".engineering-agent", "plan.draft.md"), PLAN);
  await p.run("plan-check");
  await p.run("plan-approve");
  if (audit) writeFileSync(path.join(p.dir, ".engineering-agent", "audit.json"), '{"overall_status":"pass"}\n');
  await p.run("architecture");
  writeFileSync(path.join(p.dir, ".engineering-agent", "architecture.draft.md"), ARCH);
  await p.run("architecture-check");
  await p.run("architecture-approve");
  await p.run("implement");
}

test("git yokken verify fail-closed: değişen dosyalar doğrulanamaz", async () => {
  const p = makeProject();
  try {
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "src", "app.ts"), "// TODO: bitir\nexport const x = 1;\n");
    await p.run("verify");
    assert.notEqual(stateOf(p).phase, "DONE");
    assert.match(p.notices.at(-1), /VERIFY BLOKLANDI/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("yinelenen verify FAIL revizyon sayacını korur ve eskalasyon yapar", async () => {
  const p = makeProject({ testCommand: 'node -e "process.exit(1)"' });
  try {
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "src", "app.ts"), "export const x = 2;\n");
    for (let i = 0; i < 4; i++) await p.run("verify");
    const state = stateOf(p);
    assert.equal(state.phase, "BLOCKED");
    assert.ok(Object.values(state.revisions).some((n) => n > 2));
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("yeni /eng plan önceki revizyon ve repair sayaçlarını sıfırlar", async () => {
  const p = makeProject();
  try {
    await bootstrap(p, { audit: false });
    const statePath = path.join(p.dir, ".engineering-agent", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.revisions = { "IMPLEMENTATION:VERIFICATION": 5 };
    state.repair_prompts = 1;
    writeFileSync(statePath, JSON.stringify(state));
    await p.run("plan yeni görev");
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(after.revisions, {});
    assert.equal(after.repair_prompts, 0);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("contract onayından sonra config.json değişikliği verify'ı kandıramaz", async () => {
  const p = makeProject({ git: true, testCommand: 'node -e "process.exit(1)"' });
  try {
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "src", "app.ts"), "export const x = 3;\n");
    const cfgPath = path.join(p.dir, ".engineering-agent", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.commands.test = 'node -e "process.exit(0)"';
    writeFileSync(cfgPath, JSON.stringify(cfg));
    await p.run("verify");
    assert.notEqual(stateOf(p).phase, "DONE");
    assert.match(p.notices.at(-1), /VERIFY BLOKLANDI/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("baseline'da kirli dosyaya sonradan eklenen placeholder yakalanır", async () => {
  const p = makeProject({ git: true });
  try {
    writeFileSync(path.join(p.dir, "src", "app.ts"), "export const x = 99;\n");
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "src", "app.ts"), "// TODO: sonradan\nexport const x = 100;\n");
    await p.run("verify");
    assert.notEqual(stateOf(p).phase, "DONE");
    assert.match(p.notices.at(-1), /PLACEHOLDER/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("temiz git projesinde kapsam içi değişiklik verify'dan geçer", async () => {
  const p = makeProject({ git: true });
  try {
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "src", "app.ts"), "export const x = 2;\n");
    await p.run("verify");
    assert.equal(stateOf(p).phase, "DONE");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("kapsam dışı dosya değişikliği verify'ı bloklar", async () => {
  const p = makeProject({ git: true });
  try {
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "other", "x.ts"), "export const y = 2;\n");
    await p.run("verify");
    assert.notEqual(stateOf(p).phase, "DONE");
    assert.match(p.notices.at(-1), /KAPSAM SORUNU/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("UI yoksa verify komutları onaysız çalışmaz", async () => {
  const old = process.env.PI_ENGINEERING_ALLOW_COMMANDS;
  delete process.env.PI_ENGINEERING_ALLOW_COMMANDS;
  const p = makeProject({ git: true, hasUI: false });
  try {
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "src", "app.ts"), "export const x = 2;\n");
    await p.run("verify");
    assert.notEqual(stateOf(p).phase, "DONE");
    assert.ok(p.notices.some((m) => /ONAY ALINAMADI/.test(m)));
  } finally {
    if (old === undefined) delete process.env.PI_ENGINEERING_ALLOW_COMMANDS;
    else process.env.PI_ENGINEERING_ALLOW_COMMANDS = old;
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("UI onayı reddedilirse verify komutları çalışmaz", async () => {
  const p = makeProject({ git: true, confirm: false });
  try {
    await bootstrap(p);
    writeFileSync(path.join(p.dir, "src", "app.ts"), "export const x = 2;\n");
    await p.run("verify");
    assert.notEqual(stateOf(p).phase, "DONE");
    assert.match(p.notices.at(-1), /VERIFY İPTAL/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});
