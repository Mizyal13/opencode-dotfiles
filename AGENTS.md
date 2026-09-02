# AGENTS.md — Instruksi global opencode

Aturan dasar berlaku untuk semua project. Setiap prompt dari user adalah instruksi; jangan menambah scope tanpa diminta. Setelah tugas selesai, berhenti — tanpa penjelasan berlebih.

## Aturan umum

- Jawab dalam bahasa yang dipakai user (Indonesia/Inggris), ringkas dan langsung.
- Perintah yang menimbulkan efek (install, build, deploy, git commit/push, docker, gestur sistem) **hanya** dijalankan jika diminta eksplisit.
- Jangan commit/push/mendekatkan git kecuali diminta. Saat diminta commit: periksa `git status` + `git diff` dulu, stage hanya yang relevan, pesan commit singkat sesuai gaya repo.
- Ikuti konvensi file yang diedit. JANGAN tambahkan komentar kode kecuali diminta.
- Baru edit/refactor setelah memahami konteks di sekitar (baris sebelumnya, imports, struktur).
- Tool baca-aman (read, glob, grep, git status/diff/log, ls) otomatis diizinkan. Aksi tanya-menanya sebelum dieksekusi.
- Keamanan: jangan pernah log/mendorong secret, API key, DATABASE_URL, token. `*.env` nyata dan file secret tidak pernah dikirim ke git.
- Setelah selesai tugas coding, jalankan lint/typecheck yang tersedia (mis. `ruff`, `flutter analyze`) dan test yang relevan sebelum menyatakan selesai.

## Memori proyek penting user

### AI Nota (`~/Documents/bisnis/ai-nota`)
Kasir/nota SAAS: backend FastAPI + Telegram bot + admin dashboard + mobile Flutter.

- **Backend adalah sumber kebenaran** untuk harga, stok, status. AI (Gemini/Langflow) hanya mengeluarkan `intent + product_query + qty` — **jangan biarkan AI menentukan harga/total**; seluruhnya di-resolve ulang dari DB.
- **Uang = `Decimal`** (`ROUND_HALF_UP`), diserialisasi sebagai string. Jangan pakai float.
- **Skema DB hanya bergerak lewat Alembic** (`backend/alembic/versions/`), jalan otomatis saat container start. 22 migrasi sudah ada (001–022).
- **Fleet bot**: satu company = satu bot Telegram; `telegram-bot/app/fleet.py` merekonsiliasi worker per org dari registry backend.
- **PrintWorker** (`backend/services/print_worker.py`) adalah loop asyncio di dalam proses backend (bukan service/Redis terpisah); klaim job via `FOR UPDATE SKIP LOCKED`; hidup hanya saat `PRINTER_ENABLED=true`.
- **Layering**: `domain/`(murni) → `services/`(unit of work) → `repositories/`(akses data) → `api/`(route+schema). Jangan bolak-balik arah.
- **Error envelope**: `{"error":{"code":...,"message":...}}`.

#### Perintah AI Nota
- Semantic semua kontainer: `./dev.sh` (up/backend/bot/stop/logs/status/db/test/shell) — lihat `docker.md`.
- Buat ulang + restart semua: `./dev.sh` (atau `docker compose up -d --build`).
- Rebuild backend / bot saja: `./dev.sh backend` / `./dev.sh bot`.
- Migrasi: `./dev.sh db` (`alembic upgrade head`) atau buat revisi `docker compose exec backend alembic revision -m "..."`.
- Test backend: `docker compose exec backend python -m pytest tests/ -v` (pakai DB `ai_nota_test`, dibuat otomatis).
- Test bot: `docker compose exec telegram-bot python -m pytest tests/ -v`.
- Lint backend & bot: `ruff check .` (line-length 100).
- Seed dev: `docker compose run --rm backend python -m database.seed`.