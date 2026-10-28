/**
 * Engineering Workflow v1
 *
 * Amaç:
 * - 4 fazlı mühendislik akışını Pi içinde yürütmek.
 * - Modelin yerine düşünmek değil; faz geçişlerini ve kritik kuralları
 *   mekanik olarak kontrol etmek.
 * - Bilgi eksikliğinde uydurma yerine araştırma/kanıt yolunu zorunlu kılmak.
 * - Onaylanan plan + mimariyi uygulama sırasında sözleşme olarak korumak.
 *
 * Kurulum:
 *   ~/.pi/agent/extensions/engineering-workflow.ts
 *
 * Komutlar:
 *   /eng init
 *   /eng plan <görev>
 *   /eng plan-check
 *   /eng plan-approve
 *   /eng architecture
 *   /eng architecture-check
 *   /eng architecture-approve
 *   /eng implement
 *   /eng verify
 *   /eng audit [--slow]
 *   /eng status
 *   /eng gate
 *
 * Model seçimi bu extension tarafından faz bazında otomatik yapılır.
 * /auto veya ayrı bir model-router gerekmez. Fallback mekanizması ayrı
 * extension tarafından yürütülebilir; bu dosya fazın birincil modelini seçer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

const DIR = ".engineering-agent";
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const PLAN_FILE = "plan.draft.md";
const ARCHITECTURE_FILE = "architecture.draft.md";
const CONTRACT_FILE = "contract.json";
const VERIFICATION_FILE = "verification.json";
const DURUM_FILE = "DURUM.md";

const CODE_EXTENSIONS = ["py", "ts", "tsx", "js", "jsx", "dart", "go", "rs", "java", "kt", "cs", "cpp", "c", "php", "rb", "swift"];

type ModelRef = `${string}/${string}`;
type EngineeringPhase = "PLAN" | "ARCHITECTURE" | "IMPLEMENTATION" | "VERIFY";

// Engineering Workflow'un faz -> model fallback zinciri.
// Sırayla denenir; biri registry'de yoksa veya Pi seçemezse sıradakine düşülür.
// Böylece tek bir modelin kredisi bitince/erişilemezse akış durmaz.
// Engineering Workflow'un faz -> model fallback zinciri.
// Sırayla denenir; biri registry'de yoksa, kredi/quota tükenmişse veya Pi
// seçemezse sıradakine düşülür. Ücretsiz NVIDIA modeli her fazda son güvenlik
// ağıdır: ücretli sağlayıcıların tamamı tükendiğinde akış kilitlenmez.
// Engineering Workflow'un faz -> model fallback zinciri (tamamı OpenRouter).
// Sırayla denenir; biri registry'de yoksa, kredi/quota tükenmişse veya Pi
// seçemezse sıradakine düşülür. Ücretsiz NVIDIA modeli her fazda son güvenlik
// ağıdır: ücretli sağlayıcıların tamamı tükendiğinde akış kilitlenmez.
export const PHASE_MODEL_CHAINS: Record<EngineeringPhase, ModelRef[]> = {
  // PLAN: Geniş bağlamda araştırma, kanıt sentezi ve alternatif üretme.
  PLAN: [
    "qwen/qwen3.8-max-0902",          // 1M bağlam, güçlü planlama
    "deepseek/deepseek-v4-pro",        // derin akıl yürütme yedeği
    "deepseek/deepseek-v4-flash",      // ucuz/hızlı son çare
    "nvidia/nemotron-3.5-lightning-30b-a3b", // ücretsiz güvenlik ağı
  ],

  // ARCHITECTURE: Mevcut kod tabanını anlama, soyutlama, sözleşme tasarımı.
  ARCHITECTURE: [
    "qwen/qwen3.8-max-0902",          // uzun bağlam + çoklu dosya analizi
    "deepseek/deepseek-v4-pro",        // akıl yürütme yedeği
    "qwen/qwen3.8-flash",              // daha hafif Qwen yedeği
    "nvidia/nemotron-3.5-lightning-30b-a3b",
  ],

  // IMPLEMENTATION: Hızlı ve maliyet-etkin kod üretimi.
  IMPLEMENTATION: [
    "deepseek/deepseek-v4-flash",      // en iyi maliyet/hız dengesi
    "qwen/qwen3.8-flash",              // alternatif hızlı model
    "deepseek/deepseek-v4-pro",        // karmaşık görevler için yedek
    "nvidia/nemotron-3.5-lightning-30b-a3b",
  ],

  // VERIFY: Titiz doğrulama, gate kontrolü, test yorumlama.
  VERIFY: [
    "deepseek/deepseek-v4-pro",        // en yüksek kodlama doğruluğu
    "qwen/qwen3.8-max-0902",          // kapsamlı doğrulama yedeği
    "qwen/qwen3.8-flash",              // hızlı ve ekonomik son çare
    "nvidia/nemotron-3.5-lightning-30b-a3b",
  ],
};

function modelRef(model: any): ModelRef {
  return `${model.provider}/${model.id}` as ModelRef;
}

/**
 * Model kimlikleri sağlayıcıya göre nokta/tire ile yazılabiliyor
 * (claude-opus-5.5 vs claude-opus-5-5). Karşılaştırmalar normalize edilir;
 * normalize edilmiş ad yalnızca eşleştirmede kullanılır, setModel'e ham ref gider.
 */
function normalizeModelRef(ref: string): string {
  return String(ref ?? "").trim().toLowerCase().replace(/\./g, "-");
}

function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeModelRef(a);
  const nb = normalizeModelRef(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // OpenRouter kimlikleri "openrouter/qwen/qwen3.8-flash" gibi üç parçalı
  // çözülürken zincir "qwen/qwen3.8-flash" yazar. Sağlayıcı öneki farkını
  // suffix eşleşmesiyle kapat; aksi halde fallback ölü modeli tekrar seçer.
  return na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

/**
 * Faz zincirlerinde tanımlı bir modelin fallback sahibi bu extension'dır;
 * model-fallback gibi genel fallback'ler bu modellere karışmamalı.
 */
export function isPhaseModel(ref: string): boolean {
  return Object.values(PHASE_MODEL_CHAINS).some((chain) =>
    chain.some((model) => sameModel(model, ref)),
  );
}

function findModel(ctx: ExtensionContext, wanted: ModelRef): any | undefined {
  const [provider, ...parts] = wanted.split("/");
  const id = parts.join("/");
  const registry: any = ctx.modelRegistry as any;

  const direct = registry.find?.(provider, id) ?? registry.getModel?.(provider, id);
  if (direct) return direct;

  // ModelRegistry gerçek API'si getAll()/getAvailable(); getAllModels diye bir metot yok.
  // Eskiden bu satır hep [] dönüyordu, dolayısıyla nokta/tire farkı olan kimlikler
  // (claude-opus-5.5 vs claude-opus-5-5) hiç eşleşmiyor ve zincir sessizce atlıyordu.
  const all: any[] =
    registry.getAll?.() ?? registry.getAvailable?.() ?? registry.getAllModels?.() ?? registry.getModels?.() ?? [];

  return (
    all.find((m) => sameModel(modelRef(m), wanted)) ??
    // Sağlayıcı adı farklı yazılmış olabilir (llama-local vs llama.cpp);
    // aynı modele işaret eden ilk kaydı kullan.
    all.find((m) => sameModel(String(m?.id ?? ""), String(wanted).split("/").slice(1).join("/")))
  );
}

function phaseModelChain(ctx: ExtensionContext, phase: EngineeringPhase): ModelRef[] {
  const configured = (loadConfig(ctx) as any).phase_models?.[phase];
  if (Array.isArray(configured)) {
    const clean = configured.map((x: unknown) => String(x ?? "").trim()).filter(Boolean) as ModelRef[];
    if (clean.length) return clean;
  }
  return PHASE_MODEL_CHAINS[phase] ?? [];
}

export async function selectPhaseModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  phase: EngineeringPhase,
): Promise<ModelRef | null> {
  const tried: string[] = [];

  const state = loadState(ctx);
  const failed = state.failed_models ?? [];

  for (const wanted of phaseModelChain(ctx, phase)) {
    // Kredisi tükendiği bilinen model tekrar seçilmez; yoksa her faz başında
    // aynı ölü modele düşüp akış kilitleniyordu.
    if (failed.some((f) => sameModel(f, wanted))) {
      tried.push(`${wanted} (kredi/quota nedeniyle devre dışı)`);
      continue;
    }

    const current = ctx.model ? modelRef(ctx.model) : "yok";
    if (sameModel(current, wanted)) {
      ctx.ui.setStatus("engineering-model", `${phase} → ${current}`);
      return current as ModelRef;
    }

    const model = findModel(ctx, wanted);
    if (!model) {
      tried.push(`${wanted} (registry'de yok)`);
      continue;
    }

    try {
      const ok = await pi.setModel(model);
      if (!ok) {
        tried.push(`${wanted} (Pi seçemedi)`);
        continue;
      }
      const resolved = modelRef(model);
      ctx.ui.setStatus("engineering-model", `${phase} → ${resolved}`);
      ctx.ui.notify(`ENGINEERING MODEL: ${phase} → ${resolved}`, "info");
      return resolved;
    } catch (error) {
      tried.push(`${wanted} (${String(error)})`);
    }
  }

  ctx.ui.notify(
    [
      `MODEL SEÇİMİ BAŞARISIZ: ${phase} için zincirdeki hiçbir model kullanılamadı.`,
      ...tried.map((t) => `  - ${t}`),
    ].join("\n"),
    "error",
  );
  return null;
}

const DEFAULT_CONFIG = {
  version: 1,
  max_auto_repair_prompts: 1,
  max_revisions_per_phase: 2,
  // Faz başına model zinciri. Boş bırakılırsa PHASE_MODEL_CHAINS varsayılanı kullanılır.
  phase_models: {},
  // Birleşik motor deposu: pipeline/ ve product_audit/ aynı dizinde durur.
  engineering_dir: "",
  // Geriye dönük uyumluluk: tek tek dizin vermek isteyenler için.
  quality_pipeline_dir: "",
  commands: {
    test: "",
    lint: "",
    typecheck: "",
    build: "",
  },
  gates: {
    placeholder: true,
    contract_integrity: true,
    scope: true,
    verification: true,
  },
};

// ---------------------------------------------------------------------------
// Existing project audit / quality_pipeline
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isQualityPipelineDir(dir: string): boolean {
  return existsSync(path.join(dir, "pipeline", "cli.py"));
}

// Birleşik motor deposu. Global pakette kişisel yol varsayılanı yoktur:
// yalnız proje config'i (engineering_dir) veya ortam değişkeni.
function engineRepoCandidates(config: Config): string[] {
  return [
    String((config as any).engineering_dir ?? "").trim(),
    String(process.env.PI_ENGINEERING_DIR ?? process.env.ENGINEERING_DIR ?? "").trim(),
  ].filter(Boolean);
}

function findQualityPipelineDir(ctx: ExtensionContext, config: Config): string | null {
  const configured = String((config as any).quality_pipeline_dir ?? "").trim();
  const envConfigured = String(
    process.env.PI_QUALITY_PIPELINE_DIR ?? process.env.QUALITY_PIPELINE_DIR ?? "",
  ).trim();

  const candidates = [
    configured,
    envConfigured,
    ...engineRepoCandidates(config),
    projectRoot(ctx),
    path.resolve(projectRoot(ctx), "..", "quality_pipeline"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isQualityPipelineDir(resolved)) return resolved;
  }

  return null;
}

type QualityAuditIssue = {
  file?: string;
  line?: number;
  severity?: string;
  message?: string;
  rule?: string | null;
};

type QualityAuditResult = {
  check_id?: string;
  tool?: string;
  status?: string;
  issue_count?: number;
  summary?: string;
  duration_sec?: number;
  error?: string | null;
  issues?: QualityAuditIssue[];
};

type QualityAuditSummary = {
  project_path?: string;
  project_types?: string[];
  overall_status?: string;
  results?: QualityAuditResult[];
};

function runQualityAudit(
  ctx: ExtensionContext,
  config: Config,
  slow: boolean,
): { ok: boolean; code: number; output: string; report: QualityAuditSummary | null; pipelineDir: string | null } {
  const pipelineDir = findQualityPipelineDir(ctx, config);
  if (!pipelineDir) {
    return {
      ok: false,
      code: 1,
      output: [
        "quality_pipeline bulunamadı.",
        "Çözüm: .engineering-agent/config.json içindeki quality_pipeline_dir alanına repo yolunu yazabilir veya PI_QUALITY_PIPELINE_DIR ortam değişkenini tanımlayabilirsin.",
      ].join("\n"),
      report: null,
      pipelineDir: null,
    };
  }

  ensureDir(ctx);
  const reportPath = filePath(ctx, "audit.json");
  const markdownPath = filePath(ctx, "audit.md");
  const python = process.env.PI_PYTHON ?? process.env.PYTHON ?? "python";
  const args = [
    "-m",
    "pipeline.cli",
    projectRoot(ctx),
    "--out",
    reportPath,
    "--md-out",
    markdownPath,
  ];
  if (slow) args.push("--slow");

  let result: { code: number; out: string };
  try {
    const out = execFileSync(python, args, {
      cwd: pipelineDir,
      timeout: slow ? 20 * 60_000 : 10 * 60_000,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    result = { code: 0, out: String(out) };
  } catch (error: any) {
    result = {
      code: Number(error?.status ?? 1),
      out: String(error?.stdout ?? "") + String(error?.stderr ?? ""),
    };
  }
  const report = existsSync(reportPath)
    ? readJson<QualityAuditSummary | null>(reportPath, null)
    : null;

  return {
    ok: report !== null,
    code: result.code,
    output: result.out,
    report,
    pipelineDir,
  };
}

function formatQualityAudit(report: QualityAuditSummary): string[] {
  const lines: string[] = [
    `Proje: ${report.project_path ?? "-"}`,
    `Tip: ${(report.project_types ?? []).join(", ") || "tespit edilemedi"}`,
    `Genel durum: ${(report.overall_status ?? "unknown").toUpperCase()}`,
    "",
    "Kontroller:",
  ];

  for (const result of report.results ?? []) {
    const status = String(result.status ?? "unknown").toUpperCase();
    const issues = typeof result.issue_count === "number" ? `, bulgu=${result.issue_count}` : "";
    const duration = typeof result.duration_sec === "number" ? `, ${result.duration_sec}s` : "";
    lines.push(`  [${status}] ${result.check_id ?? "?"} / ${result.tool ?? "?"}${issues}${duration} — ${result.summary ?? ""}`);
    if (result.error) lines.push(`      hata: ${result.error}`);
  }

  return lines;
}


function writeQualityBaseline(ctx: ExtensionContext, report: QualityAuditSummary): void {
  const auditHash = hashFile(ctx, "audit.json");
  const lines = [
    "# QUALITY BASELINE",
    "",
    `Audit JSON: ${DIR}/audit.json`,
    `Audit hash: ${auditHash ?? "-"}`,
    `Proje: ${report.project_path ?? "-"}`,
    `Tip: ${(report.project_types ?? []).join(", ") || "tespit edilemedi"}`,
    `Genel durum: ${(report.overall_status ?? "unknown").toUpperCase()}`,
    "",
    "## Kontrol Özeti",
  ];
  for (const result of report.results ?? []) {
    const issueCount = typeof result.issue_count === "number" ? result.issue_count : 0;
    lines.push(`- ${result.check_id ?? "?"} / ${result.tool ?? "?"}: ${String(result.status ?? "unknown").toUpperCase()} — ${issueCount} bulgu — ${result.summary ?? ""}`);
  }
  lines.push(
    "",
    "## Mimari Kullanım Kuralı",
    "- Bu dosya yalnızca kalite baseline özetidir.",
    "- Eksiksiz bulgu kaynağı `.engineering-agent/audit.json` dosyasıdır; `audit.md` özet/truncate edilebilir.",
    "- Mimari kararlar sayıdan değil, ilgili bulgunun dosya/yol, satır, rule ve mesaj alanlarından türetilmelidir.",
    "- İlgisiz bulguları mimariye taşımayın; yalnızca plan kapsamında etkilenen alanlarla ilişkili bulguları kararlarla eşleştirin.",
  );
  writeFileSync(filePath(ctx, "quality-baseline.md"), lines.join("\n") + "\n", "utf8");
}
const PLAN_TEMPLATE = `# PLAN: <tek cümlelik görev özeti>

## 1. Problem ve Gerçeklik Kontrolü
- Problem: <hangi gerçek problemi çözüyoruz?>
- Neden gerekli: <neden bu iş gerekli?>
- Varsayımlar: <doğrulanması gereken varsayımlar>
- Mevcut durum: <mevcut sistemde ne var?>

## 2. Araştırma ve Kanıt
- Kaynak / kanıt 1: <kaynak + neyi doğruluyor?>
- Kaynak / kanıt 2: <kaynak + neyi doğruluyor?>
- Doğrulanmış bilgiler: <...>
- Bilinmeyenler: <...>
- Araştırma yolu: <bilinmeyenleri nasıl doğrulayacağız?>
- Kanıt yoksa kesin hüküm verme.

## 3. Fayda / Maliyet
- Fayda: <ölçülebilir veya dürüstçe tahmini>
- Maliyet: <zaman, para, bağımlılık, teknik borç, bakım>
- Alternatiften maliyet farkı: <...>
- Değer gerekçesi: <...>

## 4. Alternatifler (en az 2)
### A. <yaklaşım>
- Artıları: <...>
- Eksileri: <...>
- Risk: <...>
- Tahmini karmaşıklık: <...>

### B. <yaklaşım>
- Artıları: <...>
- Eksileri: <...>
- Risk: <...>
- Tahmini karmaşıklık: <...>

### Seçim ve gerekçe
<hangi yaklaşım neden seçiliyor; kanıt ve trade-off ile açıklayın>

## 5. Yapılabilirlik / Feasibility Verification
- Teknik olarak mümkün mü?: <evet/hayır/bilinmiyor>
- Dayanak: <dokümantasyon, test, mevcut kod, API cevabı vb.>
- Harici bağımlılıklar: <...>
- Kritik kısıtlar: <...>
- Maliyet / kota / limit: <...>
- Açık teknik belirsizlikler: <...>

## 6. Kabul Kriterleri
- [ ] KR-1: <kriter> — doğrulama yöntemi: <test/gözlem>
- [ ] KR-2: <kriter> — doğrulama yöntemi: <test/gözlem>

## 7. Kapsam İçi
- <özellik / alan / modül>

## 8. Kapsam Dışı
- <dokunulmayacak alan>

## 9. Riskler ve Bağımlılıklar
- Risk: <...> — önlem: <...>
- Bağımlılık: <...> — etkisi: <...>

## 10. Önerilen Plan
1. <adım>
2. <adım>
3. <adım>

## 11. Çalışabilirlik Durumu (mevcut kod tabanı varsa zorunlu)
- Uygulama ayağa kalkıyor mu: <komut + gerçek çıktı>
- Derleme / tip kontrolü: <komut + gerçek çıktı>
- Çekirdek akışlar: <akış> — çalışıyor / kısmi / stub / yok (kanıt: dosya:satır)
- Doğrulanmamış: <...> — doğrulama yolu: <komut>

## 12. Plan Kararı
- Durum: DRAFT
- Planın doğrulanmamış kısımları: <...>
- Kullanıcı onayı gerektiği noktalar: <...>
`;

const ARCHITECTURE_TEMPLATE = `# ARCHITECTURE: <plan başlığı>

## 1. Mimari Hedef
<onaylı planı nasıl gerçekleştireceğimizi açıklayın>

## 2. Mevcut Sistem Analizi
- Mevcut bileşenler: <...>
- Mevcut pattern'ler: <...>
- Mevcut veri akışı: <...>
- Mevcut kısıtlar: <...>

## 3. Önerilen Mimari
<genel mimari ve neden>

## 4. Bileşenler ve Sorumluluklar
- Bileşen: <sorumluluk>
- Bileşen: <sorumluluk>

## 5. Veri ve Kontrol Akışı
<ASCII veya Mermaid diyagramı>

## 6. API / Interface / Veri Sözleşmeleri
- Girdi: <...>
- Çıktı: <...>
- Hata davranışı: <...>
- Uyumluluk: <...>

## 7. Bağımlılıklar ve Yapılabilirlik
- Yeni bağımlılık: <var/yok>
- Gerekçe: <...>
- Alternatif: <...>
- Operasyonel maliyet: <...>

## 8. Hata / Güvenlik / Performans
- Hata senaryoları: <...>
- Güvenlik: <...>
- Performans: <...>
- Geri dönüş / rollback: <...>

## 9. Test Stratejisi
- Unit: <...>
- Integration: <...>
- E2E: <...>
- Manuel doğrulama: <...>

## 10. Etkilenecek Dosyalar ve Modüller
- <tam yol veya repo içi glob>
- <tam yol veya repo içi glob>
- Yeni dosyalar: <tam yol veya NONE>

## 11. Mimari Kararlar
- Karar: <...>
- Neden: <...>
- Reddedilen alternatif: <...>

## 12. Açık Konular
- <... veya NONE>

## 13. Kalite Baseline ve Audit Bulguları
- Audit kaynağı: .engineering-agent/audit.json
- Audit hash: <...>
- Etkilenen kalite bulguları: <check_id/tool + dosya + satır + rule + mesaj ile eşleştir>
- Mimari karşılığı: <hangi bulgu hangi mimari kararla ele alınıyor?>
- Kapsam dışında kalan bulgular: <neden kapsam dışında?>
- Audit bulgusu yoksa: NONE; yokmuş gibi varsayım üretme.

## 14. Mimari Karar
- Durum: DRAFT
`;

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------

type Phase = "IDLE" | "PLAN" | "ARCHITECTURE" | "IMPLEMENTATION" | "VERIFY" | "DONE" | "BLOCKED";
type GateStatus = "PASS" | "FAIL" | "WARN" | "NOT_RUN";

type Config = typeof DEFAULT_CONFIG;

type State = {
  version: 1;
  task: string;
  phase: Phase;
  status: "DRAFT" | "READY_FOR_APPROVAL" | "APPROVED" | "ACTIVE" | "FAILED" | "VERIFIED" | "DONE" | "BLOCKED";
  plan_hash: string | null;
  audit_hash: string | null;
  architecture_hash: string | null;
  contract_hash: string | null;
  // Son seçilen faz modeli (gerçekten kullanılan) ve faz:kapı bazlı hata sayacı.
  phase_model: string | null;
  // Kredi/quota nedeniyle başarısız olmuş modeller; seçim ve fallback bunları atlar.
  failed_models: string[];
  revisions: Record<string, number>;
  baseline: {
    captured_at: string | null;
    git_available: boolean;
    git_head: string | null;
    changed_files: string[];
    // Baseline anında zaten kirli olan dosyaların içerik hash'i. Aksi halde
    // aynı dosyaya sonradan yapılan değişiklik "önceden de kirliydi" diye
    // görünmez oluyordu.
    changed_file_hashes: Record<string, string>;
  };
  last_gate: {
    name: string;
    status: GateStatus;
    at: string;
    details: string[];
  } | null;
  repair_prompts: number;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Dosya / state yardımcıları
// ---------------------------------------------------------------------------

function projectRoot(ctx: ExtensionContext): string {
  return String((ctx as any)?.workspaceRoot ?? (ctx as any)?.cwd ?? process.cwd());
}

function rootDir(ctx: ExtensionContext): string {
  return path.join(projectRoot(ctx), DIR);
}

function filePath(ctx: ExtensionContext, file: string): string {
  return path.join(rootDir(ctx), file);
}

function ensureDir(ctx: ExtensionContext): void {
  mkdirSync(rootDir(ctx), { recursive: true });
  ensureProjectDurum(ctx);
}

function ensureProjectDurum(ctx: ExtensionContext): void {
  const p = path.join(projectRoot(ctx), DURUM_FILE);
  if (existsSync(p)) {
    try {
      readFileSync(p, "utf8");
      return;
    } catch {
      try {
        renameSync(p, `${p}.bozuk`);
      } catch {
        // Okunamayan dosya yeni DURUM yazımını engellemez.
      }
    }
  }
  const template = `# DURUM — proje durumu

> ZORUNLU: Yeni oturumda herhangi bir plan/kod/komut/test öncesi bu dosyayı oku.
> Oturum kapanmadan bu dosyayı güncelle. /eng verify sonucu buraya yazılır.

## Amaç
- Bu projenin amacı ve kapsamı.

## Mevcut durum
- Henüz kayıtlı durum yok.

## Açık işler
- Henüz kayıtlı açık iş yok.

## Test komutları
- /eng verify
`;
  writeFileSync(p, template, "utf8");
}

function upsertDurumSection(text: string, heading: string, body: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return `${text.trimEnd()}

${body}
`;
  const rest = text.slice(start + heading.length);
  const nextMatch = rest.match(/\n## /);
  const next = nextMatch ? start + heading.length + nextMatch.index : -1;
  return `${text.slice(0, start)}${body}${next >= 0 ? text.slice(next) : "\n"}`;
}

function writeVerifyDurum(ctx: ExtensionContext, status: string, details: string[]): void {
  try {
    ensureProjectDurum(ctx);
    const p = path.join(projectRoot(ctx), DURUM_FILE);
    const text = readFileSync(p, "utf8");
    const body = [
      "## Son /eng verify",
      `- Tarih: ${now()}`,
      `- Durum: ${status}`,
      ...details.slice(0, 12).map((line) => `- ${line}`),
    ].join("\n");
    writeFileSync(p, upsertDurumSection(text, "## Son /eng verify", body), "utf8");
  } catch {
    // DURUM yazımı verify sonucunu engellemez.
  }
}

function now(): string {
  return new Date().toISOString();
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hashFile(ctx: ExtensionContext, file: string): string | null {
  const p = filePath(ctx, file);
  if (!existsSync(p)) return null;
  return hashText(readFileSync(p, "utf8"));
}

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function loadConfig(ctx: ExtensionContext): Config {
  const p = filePath(ctx, CONFIG_FILE);
  if (!existsSync(p)) return structuredClone(DEFAULT_CONFIG) as Config;
  const loaded = readJson<Partial<Config>>(p, {});
  return {
    ...DEFAULT_CONFIG,
    ...loaded,
    commands: { ...DEFAULT_CONFIG.commands, ...(loaded.commands ?? {}) },
    gates: { ...DEFAULT_CONFIG.gates, ...(loaded.gates ?? {}) },
  } as Config;
}

function writeJson(ctx: ExtensionContext, file: string, value: unknown): void {
  ensureDir(ctx);
  writeFileSync(filePath(ctx, file), JSON.stringify(value, null, 2) + "\n", "utf8");
}

function initialState(): State {
  return {
    version: 1,
    task: "",
    phase: "IDLE",
    status: "DRAFT",
    plan_hash: null,
    audit_hash: null,
    architecture_hash: null,
    contract_hash: null,
    phase_model: null,
    failed_models: [],
    revisions: {},
    baseline: {
      captured_at: null,
      git_available: false,
      git_head: null,
      changed_files: [],
      changed_file_hashes: {},
    },
    last_gate: null,
    repair_prompts: 0,
    updated_at: now(),
  };
}

function loadState(ctx: ExtensionContext): State {
  const p = filePath(ctx, STATE_FILE);
  if (!existsSync(p)) return initialState();
  const base = initialState();
  const loaded = readJson<Partial<State>>(p, {});
  // Eski state.json dosyaları yeni alanları içermez; varsayılanlarla birleştir.
  return {
    ...base,
    ...loaded,
    baseline: {
      ...base.baseline,
      ...(loaded.baseline ?? {}),
      changed_file_hashes: { ...(loaded.baseline?.changed_file_hashes ?? {}) },
    },
    failed_models: loaded.failed_models ?? [],
    revisions: loaded.revisions ?? {},
  };
}

function saveState(ctx: ExtensionContext, state: State): void {
  state.updated_at = now();
  writeJson(ctx, STATE_FILE, state);
}

function updateGate(
  ctx: ExtensionContext,
  name: string,
  status: GateStatus,
  details: string[],
): void {
  const state = loadState(ctx);
  state.last_gate = { name, status, at: now(), details };
  if (status === "FAIL") state.status = "FAILED";

  // Aynı fazda aynı kapı tekrar tekrar başarısız olursa otomatik onarımı durdur.
  const key = `${state.phase}:${name}`;
  if (status === "FAIL") {
    state.revisions[key] = (state.revisions[key] ?? 0) + 1;
  } else if (status === "PASS") {
    delete state.revisions[key];
  }

  const limit = loadConfig(ctx).max_revisions_per_phase ?? 2;
  if (status === "FAIL" && limit > 0 && state.revisions[key] > limit) {
    state.phase = "BLOCKED";
    state.status = "FAILED";
    saveState(ctx, state);
    ctx.ui.notify(
      [
        `ESKALASYON: "${name}" kapısı ${state.revisions[key]} kez başarısız oldu (limit ${limit}).`,
        "Otomatik onarım durduruldu; insan kararı gerekli.",
        "Seçenekler: /eng back plan | /eng back architecture | /eng status",
      ].join("\n"),
      "error",
    );
    return;
  }

  saveState(ctx, state);
}

// ---------------------------------------------------------------------------
// Shell / Git
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string, timeoutMs = 120_000): { code: number; out: string } {
  try {
    const out = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    });
    return { code: 0, out: String(out) };
  } catch (error: any) {
    return {
      code: Number(error?.status ?? 1),
      out: String(error?.stdout ?? "") + String(error?.stderr ?? ""),
    };
  }
}

function git(ctx: ExtensionContext, args: string[]): { code: number; out: string } {
  return run(`git ${args.join(" ")}`, projectRoot(ctx));
}

function gitAvailable(ctx: ExtensionContext): boolean {
  return git(ctx, ["rev-parse", "--is-inside-work-tree"]).code === 0;
}

function gitHead(ctx: ExtensionContext): string | null {
  const r = git(ctx, ["rev-parse", "HEAD"]);
  return r.code === 0 ? r.out.trim() : null;
}

function gitStatusFiles(ctx: ExtensionContext): string[] {
  const r = git(ctx, ["status", "--porcelain"]);
  if (r.code !== 0) return [];
  return r.out
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim().split(" -> ").pop() ?? "")
    .filter(Boolean);
}

function hashWorkingFile(ctx: ExtensionContext, file: string): string | null {
  try {
    return hashText(readFileSync(path.join(projectRoot(ctx), file), "utf8"));
  } catch {
    return null;
  }
}

function captureBaseline(ctx: ExtensionContext): State["baseline"] {
  const available = gitAvailable(ctx);
  const changedFiles = available ? gitStatusFiles(ctx) : [];
  const changedFileHashes: Record<string, string> = {};
  // Baseline'da kirli olan dosyanın sonradan değişip değişmediğini
  // anlayabilmek için içerik hash'i saklanır. Okunamayan dosya "" olarak
  // işaretlenir; sonraki okuma farklıysa değişiklik sayılır (fail-closed).
  for (const file of changedFiles.slice(0, 500)) {
    changedFileHashes[file] = hashWorkingFile(ctx, file) ?? "";
  }
  return {
    captured_at: now(),
    git_available: available,
    git_head: available ? gitHead(ctx) : null,
    changed_files: changedFiles,
    changed_file_hashes: changedFileHashes,
  };
}

/** Değişen dosyalar güvenilir biçimde belirlenemiyorsa kapı kapanmalı. */
function changeDetectionError(ctx: ExtensionContext, baseline: State["baseline"]): string[] {
  if (!baseline.captured_at) return [];
  if (!baseline.git_available) {
    return ["baseline git olmadan alınmış; değişen dosyalar belirlenemez. Projeyi git ile başlatıp /eng plan ile yeniden baseline alın."];
  }
  if (!gitAvailable(ctx)) return ["git artık erişilebilir değil; değişen dosyalar belirlenemez."];
  return [];
}

function changedFilesSinceBaseline(ctx: ExtensionContext, baseline: State["baseline"]): string[] {
  if (!baseline.git_available || !gitAvailable(ctx)) return [];
  const nowFiles = new Set(gitStatusFiles(ctx));
  const before = new Set(baseline.changed_files);
  const beforeHashes = baseline.changed_file_hashes ?? {};
  const changed = new Set<string>();

  for (const file of nowFiles) {
    if (file.replace(/\\/g, "/").startsWith(`${DIR}/`)) continue;
    const beforeHash = beforeHashes[file];
    if (!before.has(file) || beforeHash === undefined || hashWorkingFile(ctx, file) !== beforeHash) {
      changed.add(file);
    }
  }
  // Baseline'da kirli olup artık status'ta görünmeyen dosya geri alınmış,
  // silinmiş veya commit edilmiş olabilir; ikisi de değişikliktir.
  for (const file of before) {
    if (file.replace(/\\/g, "/").startsWith(`${DIR}/`)) continue;
    if (!nowFiles.has(file)) changed.add(file);
  }
  return [...changed].sort();
}

function isCodeFile(file: string): boolean {
  return CODE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(`.${ext}`));
}

// ---------------------------------------------------------------------------
// Metin / section yardımcıları
// ---------------------------------------------------------------------------

export function section(text: string, number: number): string {
  const re = new RegExp(`^##\\s*${number}\\.[^\\n]*`, "im");
  const m = re.exec(text);
  if (!m || m.index < 0) return "";
  const start = m.index;
  const next = /^##\s*\d+\./gim;
  next.lastIndex = m.index + m[0].length;
  const n = next.exec(text);
  const end = n ? n.index : text.length;
  return text.slice(start, end).trim();
}

export function bulletLines(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

export function containsPlaceholderText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /<[^>]+>/.test(text) ||
    /\b(todo|tbd|fill this|buraya yaz|sonra doldur)\b/i.test(normalized)
  );
}

// ---------------------------------------------------------------------------
// Çalışabilirlik kanıtı (brownfield)
// ---------------------------------------------------------------------------
// Sıfırdan başlanmamış projede planın "uygulama gerçekten çalışıyor mu"
// sorusunu yanıtlaması zorunlu. Kapı cümle kalitesine değil, artefakt varlığına
// bakar: fenced çıktı bloğu, komut istemi işareti veya çıktı sözcüğü.
export const CODEBASE_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "pubspec.yaml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "Gemfile",
];

export function isExistingCodebase(
  root: string,
  exists: (p: string) => boolean = existsSync,
  resolve: (a: string, b: string) => string = path.join,
): boolean {
  return CODEBASE_MANIFESTS.some((m) => exists(resolve(root, m)));
}

export function hasRunEvidence(block: string): boolean {
  if (!block) return false;
  if (/```[\s\S]*?\S[\s\S]*?```/.test(block)) return true;
  if (/(?:^|\n)\s*(?:\$|>|→|=>)/.test(block)) return true;
  return /çalıştırıldı|komut çıktısı|exit code|stdout/i.test(block);
}

// Plan §11 (Çalışabilirlik Durumu) mevcut kod tabanında zorunludur.
export function checkRunnabilitySection(text: string): string[] {
  const missing: string[] = [];
  const heading = /^##\s*11\.[^\n]*çalışabilirlik/im.test(text);
  if (!heading) {
    return ["§11 Çalışabilirlik Durumu (mevcut kod tabanı tespit edildi; sıfırdan proje değilse zorunlu)"];
  }
  const block = section(text, 11);
  if (!hasRunEvidence(block)) {
    missing.push("§11 çalıştırma kanıtı (gerçek komut çıktısı / fenced blok)");
  }
  if (!/(çalışıyor|kısmi|stub|yok|çalışmıyor)/i.test(block)) {
    missing.push("§11 çekirdek akış durumu (çalışıyor / kısmi / stub / yok)");
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Plan checks
// ---------------------------------------------------------------------------

function checkPlan(ctx: ExtensionContext): { ok: boolean; missing: string[]; text: string } {
  const p = filePath(ctx, PLAN_FILE);
  if (!existsSync(p)) return { ok: false, missing: [PLAN_FILE], text: "" };
  const text = readFileSync(p, "utf8");
  const required: Array<[number, string]> = [
    [1, "Problem ve Gerçeklik Kontrolü"],
    [2, "Araştırma ve Kanıt"],
    [3, "Fayda / Maliyet"],
    [4, "Alternatifler"],
    [5, "Yapılabilirlik / Feasibility Verification"],
    [6, "Kabul Kriterleri"],
    [7, "Kapsam İçi"],
    [8, "Kapsam Dışı"],
    [9, "Riskler ve Bağımlılıklar"],
    [10, "Önerilen Plan"],
  ] as const;
  const missing = required.filter(([n]) => !section(text, n)).map(([, name]) => name);

  const alternatives = text.match(/^###\s+[AB]\./gim) ?? [];
  if (alternatives.length < 2) missing.push("en az 2 alternatif");
  if (!/##\s*4\..*alternatifler[\s\S]*##\s*5\./i.test(text)) {
    // Alternatif başlığının varlığı zaten yukarıda kontrol edildi; bu sadece
    // bölümün plan şablonuna yakın olduğuna dair ek sinyal.
  }
  if (!/\[\s?\]\s+.+/m.test(section(text, 6))) missing.push("en az 1 açık kabul kriteri");
  if (!/(kaynak|kanıt|dokümantasyon|test|api|github|resmi)/i.test(section(text, 2))) {
    missing.push("araştırma/kanıt içeriği");
  }
  if (!/(bilinmeyen|unknown|doğrulanmamış)/i.test(section(text, 2))) {
    missing.push("bilinmeyenler bölümü");
  }
  if (!/(nasıl|yol|araştırma)/i.test(section(text, 2))) missing.push("araştırma yolu");
  if (isExistingCodebase(projectRoot(ctx))) missing.push(...checkRunnabilitySection(text));
  if (containsPlaceholderText(text)) missing.push("şablon placeholder'ları");

  return { ok: missing.length === 0, missing, text };
}

// ---------------------------------------------------------------------------
// Architecture checks
// ---------------------------------------------------------------------------

function checkArchitecture(ctx: ExtensionContext): { ok: boolean; missing: string[]; text: string } {
  const p = filePath(ctx, ARCHITECTURE_FILE);
  if (!existsSync(p)) return { ok: false, missing: [ARCHITECTURE_FILE], text: "" };
  const text = readFileSync(p, "utf8");
  const required: Array<[number, string]> = [
    [1, "Mimari Hedef"],
    [2, "Mevcut Sistem Analizi"],
    [3, "Önerilen Mimari"],
    [4, "Bileşenler ve Sorumluluklar"],
    [5, "Veri ve Kontrol Akışı"],
    [6, "API / Interface / Veri Sözleşmeleri"],
    [7, "Bağımlılıklar ve Yapılabilirlik"],
    [8, "Hata / Güvenlik / Performans"],
    [9, "Test Stratejisi"],
    [10, "Etkilenecek Dosyalar ve Modüller"],
    [11, "Mimari Kararlar"],
    [12, "Açık Konular"],
    [13, "Kalite Baseline ve Audit Bulguları"],
  ] as const;
  const missing = required.filter(([n]) => !section(text, n)).map(([, name]) => name);
  if (containsPlaceholderText(text)) missing.push("şablon placeholder'ları");

  const scope = section(text, 10);
  if (!scope || !bulletLines(scope).length) missing.push("etkilenecek dosya/modül listesi");
  const open = section(text, 12);
  const openItems = bulletLines(open);
  const unresolvedOpenItems = openItems.filter((item) =>
    /^\[(?:OPEN|AÇIK|ACIK)\]/i.test(item),
  );
  if (unresolvedOpenItems.length > 0) {
    missing.push(
      `çözülmemiş açık konular: ${unresolvedOpenItems.join(" | ")}`,
    );
  }

  return { ok: missing.length === 0, missing, text };
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export function extractAcceptanceCriteria(plan: string): string[] {
  return bulletLines(section(plan, 6)).map((line) => line.replace(/^\[[ xX]\]\s*/, ""));
}

function extractOutOfScope(plan: string): string[] {
  return bulletLines(section(plan, 8));
}

function extractRisks(plan: string): string[] {
  return bulletLines(section(plan, 9));
}

export function extractScopePatterns(architecture: string): string[] {
  const lines = bulletLines(section(architecture, 10));
  return lines
    .flatMap((line) => line.split(/[,;]/).map((x) => x.trim()))
    .map((x) => x.replace(/^yeni\s+dosyalar\s*:\s*/i, "").replace(/^dosyalar?\s*:\s*/i, "").trim())
    .filter((x) => x && !/^none$|^yok$/i.test(x));
}

function buildContract(ctx: ExtensionContext): Record<string, unknown> {
  const state = loadState(ctx);
  const plan = readFileSync(filePath(ctx, PLAN_FILE), "utf8");
  const architecture = readFileSync(filePath(ctx, ARCHITECTURE_FILE), "utf8");
  return {
    version: 1,
    status: "approved",
    task: state.task,
    approved_at: now(),
    plan_sha256: hashText(plan),
    architecture_sha256: hashText(architecture),
    // Verification komutları config.json'dan gelir; contract onayından sonra
    // değiştirilirse /eng verify kandırılabilir. Hash contract'a girer.
    config_sha256: hashFile(ctx, CONFIG_FILE),
    acceptance_criteria: extractAcceptanceCriteria(plan),
    out_of_scope: extractOutOfScope(plan),
    risks: extractRisks(plan),
    scope_patterns: extractScopePatterns(architecture),
    hard_rules: [
      "Kanıt yoksa kesin hüküm verme.",
      "Onaylı kapsam dışına sessizce çıkma.",
      "Contract değişmişse implementasyona devam etme.",
      "Test/doğrulama kanıtı olmadan DONE iddiasında bulunma.",
      "Yeni bir teknik gerçek mimariyi etkiliyorsa mimari fazına geri dön.",
    ],
    files: {
      plan: PLAN_FILE,
      architecture: ARCHITECTURE_FILE,
    },
  };
}

function contractIntegrity(ctx: ExtensionContext, state: State): { ok: boolean; details: string[] } {
  if (!state.contract_hash) return { ok: false, details: ["contract hash yok"] };
  const current = hashFile(ctx, CONTRACT_FILE);
  if (!current) return { ok: false, details: ["contract.json yok"] };
  if (current !== state.contract_hash) {
    return {
      ok: false,
      details: ["contract.json değişmiş", `beklenen=${state.contract_hash}`, `mevcut=${current}`],
    };
  }
  const contract = readJson<any>(filePath(ctx, CONTRACT_FILE), {});
  const planHash = hashFile(ctx, PLAN_FILE);
  const architectureHash = hashFile(ctx, ARCHITECTURE_FILE);
  const configHash = hashFile(ctx, CONFIG_FILE);
  const details: string[] = [];
  if (contract.plan_sha256 !== planHash) details.push("onaylı plan değişmiş");
  if (contract.architecture_sha256 !== architectureHash) details.push("onaylı mimari değişmiş");
  if (contract.config_sha256 !== configHash) details.push("onaylı config değişmiş (verification komutları güvenilmez)");
  return { ok: details.length === 0, details: details.length ? details : ["contract bütünlüğü OK"] };
}

export function patternToRegex(pattern: string): RegExp | null {
  const clean = pattern.replace(/^\.?\//, "").trim();
  if (!clean || clean.includes("<") || /^(none|yok|tbd)$/i.test(clean)) return null;
  const escaped = clean
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

function scopeCheck(ctx: ExtensionContext, state: State): { ok: boolean; details: string[] } {
  const contract = readJson<any>(filePath(ctx, CONTRACT_FILE), {});
  const patterns: string[] = Array.isArray(contract.scope_patterns) ? contract.scope_patterns : [];
  const changed = changedFilesSinceBaseline(ctx, state.baseline);
  if (!changed.length) return { ok: true, details: ["bu görevde yeni değişmiş dosya yok"] };
  // Değişen dosya varken scope pattern yoksa kapı atlanmaz; bu bir bypass'tı.
  if (!patterns.length) {
    return { ok: false, details: ["değişen dosya var ama onaylı scope pattern yok (mimari §10)", ...changed] };
  }
  const regexes = patterns.map(patternToRegex).filter((x): x is RegExp => !!x);
  if (!regexes.length) {
    return { ok: false, details: ["geçerli scope pattern yok; kapsam doğrulanamaz", ...changed] };
  }
  const out = changed.filter((file) => !regexes.some((re) => re.test(file)));
  return out.length
    ? { ok: false, details: ["kapsam dışı görünen dosyalar:", ...out] }
    : { ok: true, details: ["değişen dosyalar onaylı scope ile uyumlu"] };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

type CommandResult = { name: string; configured: boolean; code: number | null; output: string };

function executeVerification(ctx: ExtensionContext, config: Config): CommandResult[] {
  const cwd = projectRoot(ctx);
  const entries: Array<[string, string]> = [
    ["test", config.commands.test],
    ["lint", config.commands.lint],
    ["typecheck", config.commands.typecheck],
    ["build", config.commands.build],
  ];
  return entries.map(([name, command]) => {
    if (!command?.trim()) return { name, configured: false, code: null, output: "komut yapılandırılmamış" };
    const r = run(command, cwd);
    return { name, configured: true, code: r.code, output: r.out.slice(-12000) };
  });
}

function verificationPassed(results: CommandResult[]): boolean {
  const configured = results.filter((r) => r.configured);
  return configured.length > 0 && configured.every((r) => r.code === 0);
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\bTODO\b/i,
  /implement\s+later/i,
  /coming\s+soon/i,
  /raise\s+NotImplementedError/i,
  /^\s*(pass|\.\.\.)\s*(#.*)?$/m,
  /FIXME/i,
];

/** Bir metindeki placeholder eşleşmelerini satır numarasıyla döner (saf fonksiyon). */
export function placeholderHits(content: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const seen = new Set<string>();
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of content.matchAll(global)) {
      const line = content.slice(0, match.index ?? 0).split("\n").length;
      const text = match[0].trim().slice(0, 80);
      const key = `${line}:${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ line, text });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function scanPlaceholders(ctx: ExtensionContext, files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files.slice(0, 100)) {
    const absolute = path.join(projectRoot(ctx), file);
    if (!existsSync(absolute)) continue;
    let content = "";
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    for (const hit of placeholderHits(content)) {
      hits.push(`${file}:${hit.line} → ${hit.text}`);
    }
  }
  return hits;
}

function extractAssistantText(messages: any[]): string {
  // Ara ilerleme mesajları son yanıtta geri çekilmiş bir iddiayı yeniden tetiklememeli.
  const message = [...messages].reverse().find((item) => item?.role === "assistant");
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  if (message.content.some((part: any) => part?.type === "toolCall")) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function hasCompletionClaim(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\p{L})'[^'\n]*'/gu, "")
    .replace(/\*\*|__/g, "");
  // ponytail: cümle tabanlı sezgisel uyarı; asıl başarı kapısı contract + verify'dır.
  const claim = /(?<![\p{L}\p{N}_])(?:bitti|tamamlandı|tamamlandi|done|completed|finished|başarıyla tamam|basariyla tamam)(?![\p{L}\p{N}_])/iu;
  const negation = /(?<!\p{L})(?:değil|degil|henüz|henuz|not|never|isn't|isn’t|aren't|wasn't|sayılmaz|sayilmaz)(?!\p{L})/iu;
  return prose.split(/[\n.!?;]+/).some((sentence) => claim.test(sentence) && !negation.test(sentence));
}

// ---------------------------------------------------------------------------
// Faz modeli kredi/quota tespiti
// ---------------------------------------------------------------------------

function extractAssistantError(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const parts = [message.errorMessage, message.error, message.stopReason];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part?.text === "string") parts.push(part.text);
      }
    }
    const text = parts.filter(Boolean).join(" ");
    if (text) return text;
  }
  return "";
}

/** Yalnızca kredi/kota/faturalama kaynaklı hatalar fallback tetikler. */
export function isCreditExhaustion(status: number | undefined, errorText: string): boolean {
  const text = String(errorText ?? "").toLowerCase();
  const patterns = [
    /insufficient[_ -]?quota/,
    /quota[_ -]?exceeded/,
    /quota.*exceed/,
    /exceed.*quota/,
    /insufficient.*credit/,
    /credit.*exhaust/,
    /credits?.*(?:exhaust|deplet|finish)/,
    /insufficient.*balance/,
    /billing/,
    /payment.*required/,
    /usage.*limit/,
    /spending.*limit/,
    /budget.*exceed/,
    /resource[_ -]?exhausted/,
  ];
  return status === 402 || status === 429 || patterns.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" | "success" = "info"): void {
  ctx.ui.notify(message, level === "success" ? "info" : level);
}

function setStatus(ctx: ExtensionContext, status: string): void {
  ctx.ui.setStatus("engineering-workflow", status);
}

function configuredCommandLines(config: Config): string[] {
  return Object.entries(config.commands)
    .filter(([, command]) => Boolean(command?.trim()))
    .map(([name, command]) => `${name}: ${command}`);
}

/**
 * Proje config'inden gelen komutları çalıştırmadan önce insan onayı ister.
 * UI yoksa yalnızca kullanıcı tarafından set edilen ortam değişkeni geçer;
 * repo config'i bu onayı kapatamaz.
 */
async function confirmExecution(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
): Promise<boolean> {
  if (process.env.PI_ENGINEERING_ALLOW_COMMANDS === "1") return true;
  const hasUI = Boolean((ctx as any).hasUI);
  const confirm = (ctx as any).ui?.confirm;
  if (!hasUI || typeof confirm !== "function") {
    notify(
      ctx,
      [
        `${title}: ONAY ALINAMADI`,
        "Etkileşimli UI yok. Komutları çalıştırmak için kullanıcı ortamında PI_ENGINEERING_ALLOW_COMMANDS=1 tanımla.",
      ].join("\n"),
      "error",
    );
    return false;
  }
  try {
    return Boolean(await confirm.call(ctx.ui, title, lines.join("\n")));
  } catch {
    return false;
  }
}

function requirePhase(ctx: ExtensionContext, phase: Phase): State | null {
  const state = loadState(ctx);
  if (state.phase !== phase) {
    notify(ctx, `Bu işlem FAZ ${phase} içindir. Mevcut faz: ${state.phase}`, "warning");
    return null;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

  // -------------------------------------------------------------------------
  // Faz modeli kredi/quota fallback'i
  // -------------------------------------------------------------------------
  // PHASE_MODEL_CHAINS fazın sahibi tek kaynaktır. Model kredisi bitince
  // zincirdeki sıradaki model seçilir ve faz kaldığı yerden devam eder.
  // Pi başarısız bir çağrıyı aynı turda yeniden başlatamadığı için geçiş
  // agent_settled sonrasında yeni bir tur olarak tetiklenir.
  let providerStatus: number | undefined;
  let phaseFallbackPending = false;
  let phaseFallbackBusy = false;

  pi.on("after_provider_response", (event: any) => {
    providerStatus = event?.status;
  });

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    const status = providerStatus;
    providerStatus = undefined;
    if (phaseFallbackBusy) return;

    const state = loadState(ctx);
    if (!state.phase_model) return;
    if (state.phase === "IDLE" || state.phase === "DONE" || state.phase === "BLOCKED") return;

    const current = ctx.model ? modelRef(ctx.model) : null;
    if (!current || !sameModel(current, state.phase_model)) return;

    if (!isCreditExhaustion(status, extractAssistantError(event?.messages ?? []))) return;

    phaseFallbackBusy = true;
    try {
      const failed = state.failed_models.some((f) => sameModel(f, current))
        ? state.failed_models
        : [...state.failed_models, current];
      state.failed_models = failed;

      const phase = state.phase as EngineeringPhase;
      const chain = phaseModelChain(ctx, phase);
      const currentIndex = chain.findIndex((m) => sameModel(m, current));
      const candidates = (currentIndex >= 0 ? chain.slice(currentIndex + 1) : chain).filter(
        (m) => !failed.some((f) => sameModel(f, m)),
      );

      let switched: ModelRef | null = null;
      const tried: string[] = [];
      for (const candidate of candidates) {
        const model = findModel(ctx, candidate);
        if (!model) {
          tried.push(`${candidate} (registry'de yok)`);
          continue;
        }
        const resolved = modelRef(model);
        try {
          if (!(await pi.setModel(model))) {
            tried.push(`${candidate} (Pi seçemedi)`);
            continue;
          }
        } catch (error) {
          tried.push(`${candidate} (${String(error)})`);
          continue;
        }
        switched = resolved;
        break;
      }

      if (switched) {
        state.phase_model = switched;
        saveState(ctx, state);
        phaseFallbackPending = true;
        ctx.ui.setStatus("engineering-model", `${state.phase} → ${switched} (fallback)`);
        ctx.ui.notify(
          [
            `${state.phase}: ${current} kredi/quota nedeniyle kullanılamıyor.`,
            `Yeni faz modeli: ${switched}`,
            "Faz kaldığı yerden devam edecek.",
          ].join("\n"),
          "warning",
        );
        return;
      }

      saveState(ctx, state);
      ctx.ui.notify(
        [
          `${state.phase}: ${current} kredi/quota nedeniyle başarısız oldu, kullanılabilir başka model kalmadı.`,
          `Zincir: ${chain.join(" → ") || "-"}`,
          ...tried.map((t) => `  - ${t}`),
          "Kredi eklendikten sonra /eng reset-models ile zinciri sıfırla.",
        ].join("\n"),
        "error",
      );
    } finally {
      phaseFallbackBusy = false;
    }
  });

  pi.on("agent_settled", () => {
    if (!phaseFallbackPending) return;
    phaseFallbackPending = false;
    pi.sendUserMessage(
      "Önceki model kredi/quota nedeniyle başarısız oldu ve faz modeli değiştirildi. " +
        "Kaldığın yerden devam et; tamamlanmış adımları gereksiz yere tekrarlama.",
    );
  });

  // Model "tamamlandı" dediğinde enforcement durumunu kontrol et.
  // Burada otomatik değişiklik yapılmaz; sadece yolu tekrar gösteren bir gate uyarısı verilir.
  pi.on("agent_end", (event: any, ctx: ExtensionContext) => {
    const state = loadState(ctx);
    if (state.phase !== "IMPLEMENTATION" && state.phase !== "VERIFY") return;

    const text = extractAssistantText(event?.messages ?? []);
    if (!hasCompletionClaim(text)) return;

    const integrity = state.contract_hash ? contractIntegrity(ctx, state) : { ok: true, details: [] };
    if (!integrity.ok) {
      updateGate(ctx, "CONTRACT_INTEGRITY", "FAIL", integrity.details);
      notify(
        ctx,
        [
          "ENGINEERING GATE: SÖZLEŞME DEĞİŞMİŞ.",
          ...integrity.details.map((x) => `  - ${x}`),
          "Uygulama tamamlandı sayılamaz. Değişikliğin gerekçesiyle üst faza dönülmeli.",
        ].join("\n"),
        "error",
      );
      return;
    }

    if (state.phase === "IMPLEMENTATION") {
      notify(
        ctx,
        "ENGINEERING GATE: Model tamamlandı dedi. Final DONE için /eng verify çalıştırılmalı.",
        "warning",
      );
      const config = loadConfig(ctx);
      if (config.max_auto_repair_prompts > 0) {
        const current = loadState(ctx);
        if (current.repair_prompts < config.max_auto_repair_prompts) {
          pi.sendUserMessage(
            "İşlem henüz DONE kabul edilmez. Onaylı contract'a bağlı kal. Kalan implementasyonu tamamla veya bir engel varsa açıkça bildir. Final sonuç için doğrulama gerekir; bu aşamada doğrulanmamış başarı iddiasında bulunma.",
            { deliverAs: "followUp" },
          );
          current.repair_prompts += 1;
          saveState(ctx, current);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // /eng init
  // -------------------------------------------------------------------------

  pi.registerCommand("eng", {
    description: "Engineering Workflow: plan → architecture → implement → verify",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [sub, ...rest] = input.split(/\s+/);
      const command = (sub || "status").toLowerCase();
      const remainder = rest.join(" ").trim();

      if (command === "init") {
        ensureDir(ctx);
        const configPath = filePath(ctx, CONFIG_FILE);
        if (!existsSync(configPath)) writeJson(ctx, CONFIG_FILE, DEFAULT_CONFIG);
        const state = loadState(ctx);
        if (!existsSync(filePath(ctx, STATE_FILE))) saveState(ctx, state);
        notify(
          ctx,
          `Engineering Workflow hazır. Yapı: ${DIR}/\nconfig: ${CONFIG_FILE}\nstate: ${STATE_FILE}\nTest/lint/typecheck/build komutlarını config.json içinde proje için açıkça tanımla.`,
          "success",
        );
        setStatus(ctx, "READY");
        return;
      }

      // ---------------------------------------------------------------------
      // PLAN
      // ---------------------------------------------------------------------

      if (command === "plan") {
        if (!remainder) {
          notify(ctx, "/eng plan <görev> kullan.", "warning");
          return;
        }
        const planModel = await selectPhaseModel(pi, ctx, "PLAN");
        if (!planModel) return;
        ensureDir(ctx);
        const planPath = filePath(ctx, PLAN_FILE);
        if (!existsSync(planPath)) writeFileSync(planPath, PLAN_TEMPLATE + "\n", "utf8");
        const state = loadState(ctx);
        state.task = remainder;
        state.phase = "PLAN";
        state.status = "DRAFT";
        state.phase_model = planModel;
        state.plan_hash = null;
        state.architecture_hash = null;
        state.contract_hash = null;
        state.baseline = captureBaseline(ctx);
        state.last_gate = null;
        // Yeni görev eski görevin hata/onarım bütçesini miras almamalı.
        state.revisions = {};
        state.repair_prompts = 0;
        saveState(ctx, state);

        pi.sendUserMessage(
          [
            `ENGINEERING WORKFLOW — FAZ 1 PLAN`,
            `GÖREV: ${remainder}`,
            "",
            `Önce ${DIR}/${PLAN_FILE} dosyasını doldur. Kod yazma.`,
            `Eğer ${DIR}/audit.json mevcutsa ${DIR}/quality-baseline.md ve ${DIR}/audit.json dosyalarını oku. Audit bulgularından yalnızca görevle ilişkili olanları planın mevcut durum, risk, kapsam ve kabul kriterlerine yansıt; toplam bulgu sayısını tek başına yapılacak iş listesi kabul etme.`,
            `Eğer ${DIR}/product-audit.json mevcutsa onu da oku; ürün amacı (purpose), iddialar (claims), gerçekleşen/kısmi/eksik özellikler, çelişkiler ve ürün hazırlık durumunu planın problem/gerçeklik, kapsam ve risk bölümlerine yansıt. product-audit ürün düzeyi bulgudur, kod kalitesi bulgusu değildir; quality audit ile karıştırma.`,
            `product-audit yoksa veya amacı güvenilmezse (ör. HTML etiketi, boş iddia/özellik listesi), ürün amacını koddan çıkar: metadata.json / index.html meta description, package.json scripts, server uç noktaları, tip modelleri. Kaynağı dosya adıyla yaz; çıkaramadığını bilinmeyen olarak işaretle.`,
            `Mevcut kod tabanı varsa plan §11 "Çalışabilirlik Durumu" bölümünü gerçek komut çıktısıyla doldur: build/tip kontrolü çalıştır ve en az bir çekirdek akışın bugünkü durumunu (çalışıyor/kısmi/stub/yok) kanıtla. Çıktı üretemediysen bunu "doğrulanmadı + doğrulama yolu" olarak yaz; uydurma.`,
            "Plan; gerçeklik, araştırma/kanıt, bilinmeyenler, araştırma yolu, fayda/maliyet, en az iki alternatif, yapılabilirlik, kabul kriterleri, kapsam, riskler ve önerilen adımları içermeli.",
            "Kanıtlanmamış bilgiyi gerçek gibi yazma. Bilinmeyen bir nokta varsa nasıl doğrulanacağını belirt.",
            "Plan tamamlanınca kullanıcı /eng plan-check çalıştıracak.",
          ].join("\n"),
        );
        setStatus(ctx, "FAZ 1: PLAN");
        return;
      }

      if (command === "plan-check") {
        const { ok, missing } = checkPlan(ctx);
        if (!ok) {
          updateGate(ctx, "PLAN_STRUCTURAL", "FAIL", missing);
          notify(ctx, ["PLAN GATE: BAŞARISIZ", ...missing.map((x) => `  - ${x}`)].join("\n"), "error");
          return;
        }
        const state = loadState(ctx);
        state.phase = "PLAN";
        state.status = "READY_FOR_APPROVAL";
        state.plan_hash = hashFile(ctx, PLAN_FILE);
        saveState(ctx, state);
        updateGate(ctx, "PLAN_STRUCTURAL", "PASS", ["Plan yapısal kontrolden geçti."]);
        notify(ctx, "PLAN GATE: GEÇTİ. İnsan kararı için /eng plan-approve kullanılabilir.", "success");
        setStatus(ctx, "FAZ 1 OK — ONAY BEKLENİYOR");
        return;
      }

      if (command === "plan-approve") {
        const state = requirePhase(ctx, "PLAN");
        if (!state) return;
        if (state.status !== "READY_FOR_APPROVAL") {
          notify(ctx, "PLAN ONAYI REDDEDİLDİ: Önce /eng plan-check başarılı olmalı.", "warning");
          return;
        }
        const check = checkPlan(ctx);
        if (!check.ok) {
          notify(ctx, ["ONAY REDDEDİLDİ", ...check.missing.map((x) => `  - ${x}`)].join("\n"), "error");
          return;
        }
        state.status = "APPROVED";
        state.plan_hash = hashText(check.text);
        state.phase = "ARCHITECTURE";
        saveState(ctx, state);
        updateGate(ctx, "PLAN_APPROVAL", "PASS", ["İnsan plan onayı kaydedildi."]);
        notify(ctx, "PLAN ONAYLANDI. Sıradaki faz: ARCHITECTURE → /eng architecture", "success");
        setStatus(ctx, "FAZ 2: ARCHITECTURE");
        return;
      }

      // ---------------------------------------------------------------------
      // ARCHITECTURE
      // ---------------------------------------------------------------------

      if (command === "architecture") {
        const state = requirePhase(ctx, "ARCHITECTURE");
        if (!state) return;
        const plan = readFileSync(filePath(ctx, PLAN_FILE), "utf8");
        const currentPlanHash = hashText(plan);
        if (state.plan_hash !== currentPlanHash) {
          state.status = "BLOCKED";
          saveState(ctx, state);
          updateGate(ctx, "PLAN_INTEGRITY", "FAIL", ["Onaylanan plan değişmiş."]);
          notify(ctx, "MİMARİ BLOKLANDI: onaylanan plan değişmiş. Yeni plan onayı gerekiyor.", "error");
          return;
        }
        const auditPath = filePath(ctx, "audit.json");
        if (!existsSync(auditPath)) {
          updateGate(ctx, "QUALITY_BASELINE", "FAIL", ["Architecture için güncel quality audit gerekli.", `${DIR}/audit.json bulunamadı. Önce /eng audit çalıştırılmalı.`]);
          notify(ctx, ["MİMARİ BLOKLANDI: QUALITY BASELINE YOK.", `${DIR}/audit.json bulunamadı.`, "Önce /eng audit çalıştır; ardından /eng architecture ile devam et."].join("\n"), "error");
          return;
        }
        const currentAuditHash = hashFile(ctx, "audit.json");
        if (state.audit_hash && state.audit_hash !== currentAuditHash) {
          updateGate(ctx, "QUALITY_BASELINE", "FAIL", ["audit.json değişmiş; audit baseline yeniden kaydedilmeli."]);
          notify(ctx, "MİMARİ BLOKLANDI: audit.json değişmiş. Önce /eng audit yeniden çalıştırılmalı.", "error");
          return;
        }
        if (!state.audit_hash) { state.audit_hash = currentAuditHash; saveState(ctx, state); }

        const architectureModel = await selectPhaseModel(pi, ctx, "ARCHITECTURE");
        if (!architectureModel) return;

        const architecturePath = filePath(ctx, ARCHITECTURE_FILE);
        if (!existsSync(architecturePath)) writeFileSync(architecturePath, ARCHITECTURE_TEMPLATE + "\n", "utf8");
        state.status = "DRAFT";
        state.phase_model = architectureModel;
        saveState(ctx, state);
        pi.sendUserMessage(
          [
            "ENGINEERING WORKFLOW — FAZ 2 ARCHITECTURE",
            "Onaylı plan aşağıdaki dosyadadır:",
            `${DIR}/${PLAN_FILE}`,
            "",
            `Şimdi ${DIR}/${ARCHITECTURE_FILE} dosyasını doldur. Kod yazma.`,
            `Önce ${DIR}/quality-baseline.md dosyasını ve ardından ${DIR}/audit.json dosyasını oku. quality-baseline yalnızca özet, audit.json eksiksiz bulgu kaynağıdır; audit.md'yi eksiksiz liste olarak kabul etme.`,
            `Eğer ${DIR}/product-audit.json mevcutsa onu da oku; ürün düzeyi bulguları (purpose, claims, features, contradictions, product readiness) yalnızca mimariyle ilişkiliyse kararlara bağla; product-audit teknik kalite bulgusu değildir.`,
            "Mevcut kod tabanını incele; mevcut pattern'leri koru. Bileşenleri, veri/kontrol akışını, API sözleşmelerini, bağımlılıkları, hata/güvenlik/performance konularını, test stratejisini ve etkilenecek gerçek dosya/modül yollarını belirt.",
            "Audit bulgularından yalnızca plan kapsamıyla ilişkili olanları seç. Her seçili bulguyu mümkün olduğunca check_id/tool + dosya + satır + rule ile mimari karara bağla. Toplam bulgu sayısını tek başına düzeltme listesi kabul etme.",
            "Audit bulgularının tamamını prompta kopyalama; eksiksiz kayıt audit.json'da kalmalı. İhtiyaç duyduğun ilgili bulguları dosyadan oku.",
            "Onaylı planı değiştirme. Teknik olarak mümkün olmayan bir nokta bulursan uydurma; açıkça göster ve kanıt/araştırma yolunu belirt.",
            "Mimari tamamlanınca kullanıcı /eng architecture-check çalıştıracak.",
          ].join("\n"),
        );
        setStatus(ctx, "FAZ 2: ARCHITECTURE DRAFT");
        return;
      }

      if (command === "architecture-check") {
        const state = requirePhase(ctx, "ARCHITECTURE");
        if (!state) return;
        const planHash = hashFile(ctx, PLAN_FILE);
        if (state.plan_hash !== planHash) {
          updateGate(ctx, "PLAN_INTEGRITY", "FAIL", ["onaylı plan değişmiş"]);
          notify(ctx, "MİMARİ GATE: ONAYLI PLAN DEĞİŞMİŞ. Önce planı tekrar onaylamak gerekir.", "error");
          return;
        }
        const auditHash = hashFile(ctx, "audit.json");
        if (!auditHash || state.audit_hash !== auditHash) {
          updateGate(ctx, "QUALITY_BASELINE", "FAIL", ["quality audit baseline yok veya audit.json değişmiş"]);
          notify(ctx, "MİMARİ GATE: QUALITY BASELINE GEÇERSİZ. Önce /eng audit yeniden çalıştırılmalı.", "error");
          return;
        }
        const result = checkArchitecture(ctx);
        if (!result.ok) {
          updateGate(ctx, "ARCHITECTURE_STRUCTURAL", "FAIL", result.missing);
          notify(ctx, ["ARCHITECTURE GATE: BAŞARISIZ", ...result.missing.map((x) => `  - ${x}`)].join("\n"), "error");
          return;
        }
        const st = loadState(ctx);
        st.status = "READY_FOR_APPROVAL";
        st.architecture_hash = hashText(result.text);
        saveState(ctx, st);
        updateGate(ctx, "ARCHITECTURE_STRUCTURAL", "PASS", ["Mimari yapısal kontrolden geçti."]);
        notify(ctx, "ARCHITECTURE GATE: GEÇTİ. İnsan kararı için /eng architecture-approve kullanılabilir.", "success");
        setStatus(ctx, "FAZ 2 OK — ONAY BEKLENİYOR");
        return;
      }

      if (command === "architecture-approve") {
        const state = requirePhase(ctx, "ARCHITECTURE");
        if (!state) return;
        if (state.status !== "READY_FOR_APPROVAL") {
          notify(ctx, "MİMARİ ONAYI REDDEDİLDİ: Önce /eng architecture-check başarılı olmalı.", "warning");
          return;
        }
        const check = checkArchitecture(ctx);
        if (!check.ok) {
          notify(ctx, ["MİMARİ ONAY REDDEDİLDİ", ...check.missing.map((x) => `  - ${x}`)].join("\n"), "error");
          return;
        }
        const planHash = hashFile(ctx, PLAN_FILE);
        if (state.plan_hash !== planHash) {
          notify(ctx, "MİMARİ ONAY REDDEDİLDİ: plan hash'i değişmiş.", "error");
          return;
        }

        const auditHash = hashFile(ctx, "audit.json");
        if (!auditHash || state.audit_hash !== auditHash) {
          notify(ctx, "MİMARİ ONAYI REDDEDİLDİ: quality audit baseline değişmiş veya yok. Önce /eng audit çalıştırılmalı.", "error");
          return;
        }

        const st = loadState(ctx);
        st.architecture_hash = hashText(check.text);
        const contract = buildContract(ctx);
        writeJson(ctx, CONTRACT_FILE, contract);
        st.contract_hash = hashFile(ctx, CONTRACT_FILE);
        st.phase = "IMPLEMENTATION";
        st.status = "APPROVED";
        if (!st.baseline.captured_at) st.baseline = captureBaseline(ctx);
        saveState(ctx, st);

        updateGate(ctx, "ARCHITECTURE_APPROVAL", "PASS", ["İnsan mimari onayı kaydedildi.", "Contract oluşturuldu."]);
        notify(
          ctx,
          `MİMARİ ONAYLANDI. Contract aktif: ${DIR}/${CONTRACT_FILE}\nSıradaki faz: IMPLEMENTATION → /eng implement`,
          "success",
        );
        setStatus(ctx, "FAZ 3: IMPLEMENTATION");
        return;
      }

      // ---------------------------------------------------------------------
      // IMPLEMENTATION
      // ---------------------------------------------------------------------

      if (command === "implement") {
        const state = requirePhase(ctx, "IMPLEMENTATION");
        if (!state) return;
        const integrity = contractIntegrity(ctx, state);
        if (!integrity.ok) {
          updateGate(ctx, "CONTRACT_INTEGRITY", "FAIL", integrity.details);
          writeVerifyDurum(ctx, "FAIL", ["contract integrity", ...integrity.details]);
          notify(ctx, ["IMPLEMENTASYON BLOKLANDI", ...integrity.details.map((x) => `  - ${x}`)].join("\n"), "error");
          return;
        }
        const implementationModel = await selectPhaseModel(pi, ctx, "IMPLEMENTATION");
        if (!implementationModel) return;
        const contract = readJson<any>(filePath(ctx, CONTRACT_FILE), {});
        if (!state.baseline.captured_at) state.baseline = captureBaseline(ctx);
        state.status = "ACTIVE";
        state.phase_model = implementationModel;
        saveState(ctx, state);

        pi.sendUserMessage(
          [
            "ENGINEERING WORKFLOW — FAZ 3 IMPLEMENTATION",
            "Onaylı contract bağlayıcıdır; ancak yeni bir teknik gerçek çıkarsa bunu gizleme, gerekçesiyle bildir ve gerekiyorsa ARCHITECTURE fazına dön.",
            "",
            "CONTRACT:",
            JSON.stringify(contract, null, 2),
            "",
            "Talimat:",
            "- Önce ilgili mevcut dosyaları ve bağımlılıkları incele.",
            "- Onaylı mimariye uygun implementasyon yap.",
            "- Kapsam dışına sessizce çıkma.",
            "- Placeholder bırakma.",
            "- Bilmediğin bir API/veri davranışını uydurma; araştır veya BLOCKED bildir.",
            "- Mimari sözleşmeyle çelişen zorunlu bir durum çıkarsa kodu zorla yamama; üst faza dönülmesini bildir.",
            "- Bu aşamada final başarı iddiası yapma; /eng verify ile doğrulanacaktır.",
          ].join("\n"),
        );
        setStatus(ctx, "FAZ 3: IMPLEMENTATION ACTIVE");
        return;
      }

      // ---------------------------------------------------------------------
      // EXPLICIT BACKTRACK
      // ---------------------------------------------------------------------

      if (command === "back") {
        if (remainder === "architecture") {
          const state = loadState(ctx);
          if (!["IMPLEMENTATION", "VERIFY", "BLOCKED"].includes(state.phase)) {
            notify(ctx, `ARCHITECTURE geri dönüşü bu fazdan yapılamaz: ${state.phase}`, "warning");
            return;
          }
          state.phase = "ARCHITECTURE";
          state.status = "DRAFT";
          state.phase_model = null;
          state.revisions = {};
          state.architecture_hash = null;
          state.contract_hash = null;
          saveState(ctx, state);
          notify(ctx, "Geri dönüş: ARCHITECTURE. Contract artık uygulanabilir değil; mimari yeniden kontrol/onay gerektiriyor.", "warning");
          setStatus(ctx, "FAZ 2: ARCHITECTURE — REVISION");
          return;
        }
        if (remainder === "plan") {
          const state = loadState(ctx);
          if (!["ARCHITECTURE", "IMPLEMENTATION", "VERIFY", "BLOCKED"].includes(state.phase)) {
            notify(ctx, `PLAN geri dönüşü bu fazdan yapılamaz: ${state.phase}`, "warning");
            return;
          }
          state.phase = "PLAN";
          state.status = "DRAFT";
          state.phase_model = null;
          state.revisions = {};
          state.plan_hash = null;
          state.architecture_hash = null;
          state.contract_hash = null;
          saveState(ctx, state);
          notify(ctx, "Geri dönüş: PLAN. Plan yeniden kontrol/onay gerektiriyor; mimari ve contract geçersiz kabul edildi.", "warning");
          setStatus(ctx, "FAZ 1: PLAN — REVISION");
          return;
        }
        notify(ctx, "/eng back architecture | /eng back plan", "warning");
        return;
      }

      // ---------------------------------------------------------------------
      // EXISTING PROJECT AUDIT
      // ---------------------------------------------------------------------

      if (command === "audit") {
        const slow = remainder.split(/\s+/).includes("--slow");
        const config = loadConfig(ctx);
        const pipelineDir = findQualityPipelineDir(ctx, config);
        if (pipelineDir) {
          const approved = await confirmExecution(ctx, "ENGINEERING AUDIT", [
            `Kalite pipeline: ${pipelineDir}`,
            `Proje: ${projectRoot(ctx)}`,
            `Python: ${process.env.PI_PYTHON ?? process.env.PYTHON ?? "python"} -m pipeline.cli`,
            "Audit salt-okunur çalışır; yine de dış süreç başlatılacak.",
          ]);
          if (!approved) {
            notify(ctx, "AUDIT İPTAL: komut onayı verilmedi.", "warning");
            setStatus(ctx, "AUDIT CANCELLED");
            return;
          }
        }
        notify(
          ctx,
          `EXISTING PROJECT AUDIT başlatılıyor${slow ? " (slow kontroller dahil)" : ""}...`,
          "info",
        );

        const audit = runQualityAudit(ctx, config, slow);
        if (!audit.report) {
          notify(
            ctx,
            [
              "AUDIT BAŞLATILAMADI",
              audit.output,
              "",
              "Not: /eng audit mevcut proje için salt-okunur bir kalite denetimidir; Engineering fazını değiştirmez.",
            ].join("\n"),
            "error",
          );
          setStatus(ctx, "AUDIT FAILED");
          return;
        }

        writeQualityBaseline(ctx, audit.report);
        const auditHash = hashFile(ctx, "audit.json");
        const auditState = loadState(ctx);
        auditState.audit_hash = auditHash;
        saveState(ctx, auditState);

        const summary = formatQualityAudit(audit.report);
        const overall = String(audit.report.overall_status ?? "unknown").toLowerCase();
        const level = overall === "pass" ? "success" : overall === "warn" ? "warning" : "error";
        notify(
          ctx,
          [
            "ENGINEERING AUDIT",
            ...summary,
            "",
            `JSON: ${DIR}/audit.json`,
            `Markdown: ${DIR}/audit.md`,
            `Baseline: ${DIR}/quality-baseline.md`,
            `quality_pipeline: ${audit.pipelineDir}`,
            "",
            "Audit kod değiştirmedi ve fazı değiştirmedi.",
            "Güncelleme gerekiyorsa audit bulgularından sonra /eng plan ile normal workflow başlatılabilir.",
          ].join("\n"),
          level,
        );
        setStatus(ctx, `AUDIT: ${overall.toUpperCase()}`);
        return;
      }

      // ---------------------------------------------------------------------
      // VERIFY
      // ---------------------------------------------------------------------

      if (command === "verify") {
        const state = requirePhase(ctx, "IMPLEMENTATION");
        if (!state) return;
        const config = loadConfig(ctx);
        const integrity = contractIntegrity(ctx, state);
        if (!integrity.ok) {
          updateGate(ctx, "CONTRACT_INTEGRITY", "FAIL", integrity.details);
          notify(ctx, ["VERIFY BLOKLANDI", ...integrity.details.map((x) => `  - ${x}`)].join("\n"), "error");
          return;
        }

        const changeProblem =
          config.gates.placeholder || config.gates.scope
            ? changeDetectionError(ctx, state.baseline)
            : [];
        if (changeProblem.length) {
          updateGate(ctx, "CHANGE_DETECTION", "FAIL", changeProblem);
          writeVerifyDurum(ctx, "FAIL", ["change detection", ...changeProblem]);
          notify(ctx, ["VERIFY BLOKLANDI", ...changeProblem.map((x) => `  - ${x}`)].join("\n"), "error");
          return;
        }

        const changed = changedFilesSinceBaseline(ctx, state.baseline);
        const codeChanged = changed.filter(isCodeFile);
        const placeholders = config.gates.placeholder ? scanPlaceholders(ctx, codeChanged) : [];
        if (placeholders.length) {
          updateGate(ctx, "PLACEHOLDER", "FAIL", placeholders);
          writeVerifyDurum(ctx, "FAIL", ["placeholder", ...placeholders]);
          notify(ctx, ["VERIFY GATE: PLACEHOLDER VAR", ...placeholders].join("\n"), "error");
          return;
        }

        if (config.gates.scope) {
          const scope = scopeCheck(ctx, state);
          if (!scope.ok) {
            updateGate(ctx, "SCOPE", "FAIL", scope.details);
            writeVerifyDurum(ctx, "FAIL", ["scope", ...scope.details]);
            notify(ctx, ["VERIFY GATE: KAPSAM SORUNU", ...scope.details.map((x) => `  - ${x}`)].join("\n"), "error");
            return;
          }
        }

        if (config.gates.verification) {
          const commandLines = configuredCommandLines(config);
          if (commandLines.length) {
            const approved = await confirmExecution(ctx, "ENGINEERING VERIFY", [
              `Proje: ${projectRoot(ctx)}`,
              "Şu komutlar çalıştırılacak:",
              ...commandLines.map((line) => `  ${line}`),
              "Komutlar proje config.json dosyasından gelir; yalnız güvendiğin repoda onayla.",
            ]);
            if (!approved) {
              notify(ctx, "VERIFY İPTAL: komut onayı verilmedi.", "warning");
              setStatus(ctx, "IMPLEMENTATION — VERIFY CANCELLED");
              return;
            }
          }
        }

        const results = config.gates.verification ? executeVerification(ctx, config) : [];
        const verifyOk = config.gates.verification ? verificationPassed(results) : true;
        if (!verifyOk) {
          const details = results.flatMap((r) => [
            `${r.name}: ${r.configured ? `exit_code=${r.code}` : "yapılandırılmamış"}`,
            ...(r.configured ? r.output.split(/\r?\n/).slice(-12) : []),
          ]);
          writeJson(ctx, VERIFICATION_FILE, { status: "FAILED", at: now(), changed_files: changed, results });
          updateGate(ctx, "VERIFICATION", "FAIL", details);
          writeVerifyDurum(ctx, "FAIL", details);
          const fresh = loadState(ctx);
          // updateGate limit aşıldıysa BLOCKED yazdı; onu geri alma.
          if (fresh.phase !== "BLOCKED") {
            fresh.phase = "IMPLEMENTATION";
            fresh.status = "FAILED";
          }
          saveState(ctx, fresh);
          notify(ctx, ["VERIFY GATE: BAŞARISIZ", ...details].join("\n"), "error");
          notify(ctx, "Düzeltmeleri IMPLEMENTATION fazında yap ve yeniden /eng verify çalıştır. Contract değiştiyse implementasyona devam etme; ARCHITECTURE fazına dön.", "warning");
          setStatus(ctx, fresh.phase === "BLOCKED" ? "BLOCKED — İNSAN KARARI" : "IMPLEMENTATION — FIX THEN /eng verify");
          return;
        }

        const scopeResult = scopeCheck(ctx, state);
        const summary = {
          status: "PASSED",
          at: now(),
          changed_files: changed,
          code_files: codeChanged,
          placeholders,
          scope: scopeResult,
          results,
          contract_hash: state.contract_hash,
          model_used: state.phase_model,
          revisions: state.revisions,
        };
        writeJson(ctx, VERIFICATION_FILE, summary);

        const next = loadState(ctx);
        next.phase = "DONE";
        next.status = "DONE";
        // Başarılı turda bu fazın hata sayaçları temizlenir; yeni görev eski
        // revizyonları miras almasın.
        for (const key of Object.keys(next.revisions)) {
          if (key.startsWith("IMPLEMENTATION:") || key.startsWith("VERIFY:")) delete next.revisions[key];
        }
        next.last_gate = { name: "FINAL_VERIFY", status: "PASS", at: now(), details: ["placeholder yok", "scope uygun", "yapılandırılmış verification komutları başarılı"] };
        saveState(ctx, next);
        writeVerifyDurum(ctx, "PASS", [
          `Değişen dosya: ${changed.length}`,
          `Kod dosyası: ${codeChanged.length}`,
          `Verification raporu: ${DIR}/${VERIFICATION_FILE}`,
        ]);
        notify(
          ctx,
          [
            "FINAL VERIFY: GEÇTİ ✓",
            `Değişen dosya: ${changed.length}`,
            `Kod dosyası: ${codeChanged.length}`,
            `Verification raporu: ${DIR}/${VERIFICATION_FILE}`,
            "Workflow DONE durumuna geçti.",
          ].join("\n"),
          "success",
        );
        setStatus(ctx, "DONE");
        return;
      }

      // ---------------------------------------------------------------------
      // RESET MODEL FALLBACK
      // ---------------------------------------------------------------------

      if (command === "reset-models") {
        const state = loadState(ctx);
        const cleared = state.failed_models ?? [];
        state.failed_models = [];
        saveState(ctx, state);
        notify(
          ctx,
          cleared.length
            ? `Fallback zinciri sıfırlandı. Devre dışı modeller tekrar denenecek: ${cleared.join(", ")}`
            : "Devre dışı model kaydı yoktu.",
          "success",
        );
        return;
      }

      // ---------------------------------------------------------------------
      // STATUS
      // ---------------------------------------------------------------------

      if (command === "status") {
        const state = loadState(ctx);
        const files = [PLAN_FILE, ARCHITECTURE_FILE, CONTRACT_FILE, VERIFICATION_FILE]
          .map((f) => `${f}: ${existsSync(filePath(ctx, f)) ? "VAR" : "yok"}`)
          .join("\n");
        notify(
          ctx,
          [
            `FAZ: ${state.phase}`,
            `DURUM: ${state.status}`,
            `GÖREV: ${state.task || "-"}`,
            `MODEL: ${state.phase_model ?? "-"}`,
            `PLAN HASH: ${state.plan_hash ?? "-"}`,
            `AUDIT HASH: ${state.audit_hash ?? "-"}`,
            `ARCH HASH: ${state.architecture_hash ?? "-"}`,
            `CONTRACT HASH: ${state.contract_hash ?? "-"}`,
            `REVİZYONLAR: ${Object.entries(state.revisions).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`,
            `DEVRE DIŞI MODELLER: ${(state.failed_models ?? []).join(", ") || "-"}`,
            "",
            files,
            "",
            state.last_gate
              ? `SON GATE: ${state.last_gate.name} / ${state.last_gate.status} / ${state.last_gate.at}`
              : "SON GATE: yok",
          ].join("\n"),
          "info",
        );
        return;
      }

      // ---------------------------------------------------------------------
      // GATE
      // ---------------------------------------------------------------------

      if (command === "gate") {
        const state = loadState(ctx);
        const details: string[] = [];
        let fail = false;

        if (state.contract_hash) {
          const integrity = contractIntegrity(ctx, state);
          details.push(`CONTRACT_INTEGRITY: ${integrity.ok ? "PASS" : "FAIL"}`);
          details.push(...integrity.details.map((x) => `  ${x}`));
          if (!integrity.ok) fail = true;
        }

        const changeProblem =
          state.phase === "IMPLEMENTATION" || state.phase === "VERIFY"
            ? changeDetectionError(ctx, state.baseline)
            : [];
        details.push(`CHANGE_DETECTION: ${changeProblem.length ? "FAIL" : "PASS"}`);
        details.push(...changeProblem.map((x) => `  ${x}`));
        if (changeProblem.length) fail = true;

        const changed = changeProblem.length ? [] : changedFilesSinceBaseline(ctx, state.baseline);
        const codeChanged = changed.filter(isCodeFile);
        const placeholders = scanPlaceholders(ctx, codeChanged);
        details.push(`PLACEHOLDER: ${placeholders.length ? "FAIL" : "PASS"}`);
        details.push(...placeholders.map((x) => `  ${x}`));
        if (placeholders.length) fail = true;

        if (state.phase === "IMPLEMENTATION" || state.phase === "VERIFY") {
          const scope = scopeCheck(ctx, state);
          details.push(`SCOPE: ${scope.ok ? "PASS" : "FAIL"}`);
          details.push(...scope.details.map((x) => `  ${x}`));
          if (!scope.ok) fail = true;
        }

        updateGate(ctx, "MANUAL_GATE", fail ? "FAIL" : "PASS", details);
        notify(ctx, [fail ? "ENGINEERING GATE: FAIL" : "ENGINEERING GATE: PASS", ...details].join("\n"), fail ? "error" : "success");
        return;
      }

      notify(
        ctx,
        [
          "Bilinmeyen /eng komutu.",
          "init | plan | plan-check | plan-approve | architecture | architecture-check | architecture-approve | implement | verify | audit [--slow] | back | status | gate | reset-models",
        ].join("\n"),
        "warning",
      );
    },
  });
}
