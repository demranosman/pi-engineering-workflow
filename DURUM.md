# DURUM — pi-engineering-workflow

## Amaç
Pi coding agent için kanıt kapılı (evidence-gated) plan → mimari → implementasyon → verify
iş akışı eklentisi. npm paketi olarak yayınlanabilir hale getirildi.

## Mevcut durum (2026-10-28)
- Paket hazır: `package.json` (name `pi-engineering-workflow`, v0.1.0, `pi.extensions` alanı dolu).
- Depo: https://github.com/demranosman/pi-engineering-workflow (main temiz, 3 commit).
- Testler: `npm test` → 23/23 pass (pure gate + fake-Pi API e2e).
- `npm pack --dry-run` → 6 dosya, 26.8 kB, src + examples + README + LICENSE + CHANGELOG.
- npm kullanıcısı girişli: `demranosman` (npm whoami).
- Paket npm'de **yayınlanmadı**: `npm view pi-engineering-workflow` → 404.

## Açık iş (blokaj)
- Publish zinciri: `E403 2FA required` → web login yapıldı (yeni token `npm_ZA...`) →
  hâlâ E403 (hesapta `tfa: false`) → 2FA (authenticator, Authorization and Writes) açıldı →
  **yeni hata: E403 "Your account has been temporarily suspended due to a recent
  security-sensitive action."**
- Yorum: hesap 2026-10-28T20:22'de açıldı (saatler içinde 2FA + publish denemesi) →
  npm'in yeni hesap güvenlik askıya alması. Tekrar tekrar denemek askıyı uzatabilir.
- Sonraki adım: birkaç saat (gerekirse 24s) bekle, tek deneme yap; sürerse npm support.
  O zamana kadar kurulum GitHub üzerinden çalışıyor:
  `pi install git:github.com/demranosman/pi-engineering-workflow`
- 2026-10-28: kullanıcı hesabın askıya alındığını doğruladı. Fallback doğrulandı:
  repo public (git ls-remote OK), CI main@5825b4b → success. Yani GitHub kurulumu bugün çalışıyor.
- GÜVENLİK: 5 adet npm recovery code sohbete yazıldı → 2FA ayarlarından recovery code'lar
  yeniden üretilmeli (eskiler geçersiz kılınmalı).

## Test komutları
```
npm test
npm pack --dry-run
```

## Kararlar
- npm publish public access, `latest` tag.
- Yayın sonrası README'deki "once published" notu güncellenecek.
- Yayın tekrar denenirken `--otp=<6 haneli TOTP>` kullanılacak (recovery code OTP yerine geçmez).
