---
name: ai-nota-architecture
description: Cheat-sheet arsitektur project AI Nota (FastAPI + Telegram fleet + Flutter). Gunakan saat user bertanya tentang arsitektur, alur bisnis, stacking, komponen, atau infrastruktur project.
---

# Arsitektur AI Nota

Kasir/nota SAAS multi-tenant. Satu company = satu Telegram bot. **Backend = sumber kebenaran** untuk harga/stok/status; AI tidak pernah menentukan harga.

## Komponen
| Bagian | Lokasi | Teknologi |
|---|---|---|
| Backend monolith | `backend/` | FastAPI, SQLAlchemy 2 async, asyncpg, Alembic, Pydantic 2, Uvicorn, Jinja2 (dashboard) |
| Telegram bot | `telegram-bot/` | aiogram 3 polling, fleet mode, telethon (OTP provision), qrcode |
| Mobile "Nota Z" | `mobile/` | Flutter, Riverpod, go_router, dio, freezed, fl_chart, flutter_blue_plus |
| DB | — | PostgreSQL 16 (Docker volume) |
| Infra | — | Docker Compose: `postgres` + `backend` + `telegram-bot` |

## Alur end-to-end
Kasir chat → `telegram-bot` → `POST /api/v1/ai/process` → AI (Gemini round-robin / Langflow) mem-parsing ke `AICommand` **strict** (`extra=forbid`, price/total ditolak) → backend resolve ulang produk & harga dari DB → **draft** multi-turn (`invoice_sessions`, TTL 30m) → `CONFIRM_INVOICE` → transaksi atomik: stok dikurangi (`SELECT FOR UPDATE`), invoice `PAID`, `print_jobs` dibuat → `PrintWorker` mencetak ESC/POS ke HTTP bridge.

## Prinsip kunci
- **Money = `Decimal`** (`ROUND_HALF_UP`), serialisasi string.
- **Layering**: `domain/` → `services/` (UoW) → `repositories/` → `api/`.
- **Migrasi via Alembic** (22 migrasi, 001–022), auto-jalan saat start.
- **PrintWorker**: loop asyncio dalam proses backend, klaim `FOR UPDATE SKIP LOCKED`, hidup hanya saat `PRINTER_ENABLED=true`.
- **Fleet**: `telegram-bot/app/fleet.py` merekonsiliasi 1 worker polling per org dari `/api/v1/system/bot-registry`.
- **Error envelope**: `{"error":{"code","message"}}`.
- **Auth**: dashboard = cookie+CSRF; mobile = JWT; bot = `telegram_id` + `X-Org-ID`.
- `.env` tidak pernah di-commit.

## Perintah
`./dev.sh` (up/backend/bot/test/db/shell/logs/status) · `docker compose exec backend python -m pytest tests/ -v` · bot: `docker compose exec telegram-bot python -m pytest tests/ -v` · `ruff check .` (line-length 100).