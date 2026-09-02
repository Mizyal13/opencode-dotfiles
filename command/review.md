---
description: Review menyeluruh terhadap perubahan kode di project ini menggunakan agent reviewer. Tanpa edit.
agent: reviewer
---

Lakukan review menyeluruh terhadap perubahan kode di repo ini.

Prosedur:
1. Periksa `git status` dan `git diff` (lihat uncommitted + perubahan terakhir).
2. Baca perubahan dengan cara `git diff` per file; untuk file baru atau perubahan besar, baca file utuhnya.
3. Tinjau sesuai fokus umum: kebenaran logika, keamanan, konkurensi/atomisitas, kelengkapan test, dan gaya/konsistensi. Ikuti invariant bisnis yang berlaku di project ini bila ada.
4. Jangan mengubah file apa pun — hanya laporkan temuan.

$ARGUMENTS

Format hasil: daftar temuan `file:line` dengan tingkat keparahan (blokir/mayor/minor/nit) dan alasan singkat, diakhiri ringkasan 3 kalimat.