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

## Efisiensi request (hindari rate-limit/lambat)

- Gabungkan tool-call independen dalam **satu giliran/paralel**, jangan satu per satu.
- `grep`/`glob` dulu; jangan baca ulang file yang sama atau file besar tanpa perlu.
- Jangan churn `todowrite`; tulis sekali, update hanya saat status berubah.
- Untuk task besar: rencanakan dulu, kerjakan bertahap, `/compact` sebelum lanjut.
- Verifikasi (lint/typecheck/test) sebelum menyatakan selesai.

Catatan: memori khusus project ada di `AGENTS.md` masing-masing project, bukan di global.