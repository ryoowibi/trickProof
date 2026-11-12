# TRICKPROOF — Rencana Kerja untuk Claude Code (NEAR HACKATHON)

> File ini adalah instruksi untuk AI coding agent (Claude Code) yang membantu Arr membangun proyek **Trickproof** untuk NEAR HACKATHON.
> **Sumber aturan tertinggi:** https://nearhackathon.com/HACKATHON.md — baca ulang versi live sebelum submit, karena tanggal dan aturan bisa berubah. Jika file ini bertentangan dengan HACKATHON.md, ikuti HACKATHON.md.

---

## 0. Ringkasan proyek

- **Nama:** Trickproof
- **Tagline:** *Your AI agent can be tricked. Your wallet can't.*
- **Tracks (id untuk submission):** `["security", "agents"]`
  - Tambahkan `privacy` HANYA jika pemeriksa niat (Fase 2) benar-benar berjalan di NEAR AI Cloud. Jangan klaim track yang tidak didukung kode.
- **Network:** NEAR **testnet** (diizinkan untuk semua track, lihat Q-010). Tidak ada mainnet kecuali akun payout yang dibuat sendiri oleh human.
- **Bahasa kontrak:** TypeScript (near-sdk-js)

### Masalah
AI agent mulai memegang dompet crypto dan bisa ditipu lewat prompt injection. Contoh nyata: Mei 2026, instruksi tersembunyi dalam kode Morse membuat Grok/Bankrbot memindahkan token senilai sekitar $150K–$200K. Riset Cornell Tech & Yale juga menemukan AI agent di wallet Circle mengambil kode verifikasi milik pemilik untuk **menaikkan batas belanjanya sendiri**. Prompt injection belum bisa dicegah sepenuhnya, jadi pertahanan harus ada di lapisan eksekusi, bukan di AI.

### Solusi
Kontrak NEAR yang berfungsi sebagai brankas dengan aturan. Agent hanya memegang **function call key yang dibatasi ke method `pay`**, sehingga:
1. Transaksi di luar aturan (batas per transaksi, batas harian, daftar penerima) ditolak oleh kontrak.
2. Agent **secara struktural tidak bisa** mengubah aturannya sendiri: kuncinya tidak bisa memanggil `set_policy`, dan kontrak juga menolak semua pemanggil selain owner.

### Pembeda (wajib ditonjolkan di README dan demo)
Banyak proyek "spending limit untuk agent" sudah ada (MetaMask Agent Wallet, PolicyLayer, AgentLeash, IntentGuard). Di daftar partner resmi hackathon juga ada **OutLayer** ("Secure transactions for AI agents", https://app.outlayer.ai/docs/getting-started): **keputusan: TIDAK diintegrasikan.** Baca docs-nya sebelum menulis README untuk memastikan apakah OutLayer juga punya fitur batas belanja, lalu tulis satu paragraf perbedaan yang jujur di README, dengan inti: *OutLayer melindungi kunci agent (private key di TEE); Trickproof membatasi perilaku agent (aturan ditegakkan kontrak meskipun agent tertipu, dan agent tidak bisa menaikkan limitnya sendiri). Keduanya saling melengkapi.* Jangan klaim OutLayer tidak punya fitur tertentu tanpa bukti dari docs-nya. Pembeda Trickproof: **pengamanan NEAR-native dengan dua lapis (access key + cek pemanggil di kontrak) yang membuat agent tidak mungkin menaikkan limitnya sendiri**, ditambah bukti terukur lewat attack suite.

---

## 1. ATURAN WAJIB untuk Claude Code (dari HACKATHON.md)

**Jangan pernah lakukan ini tanpa konfirmasi eksplisit dari human (Arr):**
- Mengirim submission ke API. Cetak payload JSON lengkap dulu, tunggu "ya".
- Memposting apa pun ke X atau jaringan lain.
- Menjadikan repo public, push, atau force-push.
- Menandatangani transaksi, membelanjakan token, atau deploy. **Mainnet: jangan sama sekali.** Testnet: tampilkan perintahnya dan minta persetujuan; human boleh memberi izin berkelanjutan khusus testnet dalam sesi ini.
- Commit secret. Semua key masuk `.env` (sudah di `.gitignore`), bukan ke repo. Sediakan `.env.example` tanpa nilai asli.

**Jangan menebak atau mengisi placeholder** untuk data submission (nama proyek, nama lead, email, team size, akun NEAR payout, link repo, link demo, deskripsi, consent). Semua diputuskan oleh human.

**Jangan membuat atau mengarang akun NEAR atas nama human.** Akun payout mainnet dibuat sendiri oleh human di wallet NEAR.

---

## 2. Timeline (WIB)

Deadline resmi: **2026-11-14T23:59:00Z = Minggu 15 Nov 2026, 06:59 WIB.**
Deadline internal: **Sabtu 14 Nov 2026, 23:00 WIB.**

### Kamis malam (12 Nov): bangun inti
1. Setup environment + deploy hello world ke testnet (maks 1–1,5 jam). Jika macet >2 jam, inti bergeser ke Jumat.
2. Kontrak Trickproof: `init`, `set_policy`, `add_allowed`, `remove_allowed`, `pay`, `get_policy`, `get_logs`.
3. Buat akun agent (Budi) + function call key yang hanya boleh memanggil `pay`.
4. Agent sederhana (Node.js + LLM) yang menerima perintah teks lalu memanggil `pay`.
5. Uji: transaksi normal lolos, serangan gaya Grok ditolak, agent gagal mengubah policy.
6. Commit ke GitHub (repo **private** dulu).

### Jumat (13 Nov, pulang kerja): lengkapi dan kemas
7. Dashboard web sederhana.
8. Attack suite yang menghasilkan angka terukur.
9. Fase 2 (opsional, hanya jika inti sudah stabil): pending + approve, pemeriksa niat.
10. README final, LICENSE, `.env.example`.
11. Human: rekam video demo, buat akun mainnet untuk payout.
12. Jika semua siap: human membuat repo public → posting demo di X → submit (Jumat malam).

### Sabtu (14 Nov): cadangan
- Selesaikan yang tertunda. Submit paling lambat **Sabtu 23:00 WIB**.

---

## 3. Setup environment

```bash
# Node.js 22 (docs NEAR: node 24/22/20)
nvm install 22 && nvm use 22

# NEAR CLI
npm install -g near-cli-rs@latest

# Mac Apple Silicon: Rosetta wajib untuk compile kontrak JS
/usr/sbin/softwareupdate --install-rosetta --agree-to-license

# Scaffold: pilih "Smart Contract" → TypeScript
npx create-near-app@latest
```

Akun testnet (didanai faucet, gratis). Nama di bawah contoh; ganti jika sudah terpakai:

```bash
near account create-account sponsor-by-faucet-service <nama>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

| Akun | Peran |
|---|---|
| `trickproof-arr.testnet` | Kontrak (brankas) |
| `owner-arr.testnet` | Pemilik dana; satu-satunya yang bisa mengubah aturan |
| `budi-arr.testnet` | AI agent ("Budi", karakter demo yang mudah ditipu) |
| `toko-arr.testnet` | Penerima sah (ada di allowlist) |
| `penyerang-arr.testnet` | Penyerang |

**Verifikasi syntax CLI dengan `near <command> --help` dan docs.near.org sebelum menjalankan.** Jangan mengandalkan ingatan untuk flag CLI.

---

## 4. Struktur repo

```
trickproof/
├── contract/            # near-sdk-js (TypeScript)
│   └── src/contract.ts
├── agent/               # Node.js + TypeScript: AI agent "Budi" + API kecil untuk dashboard
├── dashboard/           # Web satu halaman (Vite)
├── scripts/
│   ├── setup.ts         # deploy + init + policy awal + function call key untuk Budi
│   └── attack-suite.ts  # kumpulan skenario serangan + ringkasan angka
├── README.md
├── LICENSE              # MIT
├── .env.example
└── .gitignore           # wajib berisi .env, kunci, credentials
```

npm scripts di root: `setup`, `agent`, `dashboard`, `attack-suite`.

---

## 5. Spesifikasi kontrak

### State
- `owner: string`, `agent: string`
- `max_per_tx: bigint` (yoctoNEAR), `max_per_day: bigint` (yoctoNEAR)
- `spent_today: bigint`, `day_index: number` (= `blockTimestamp / 86_400_000_000_000`)
- `allowed: UnorderedSet<string>`
- `logs: Vector<LogEntry>` (simpan maksimal N terakhir, misal 100)

`LogEntry`: `{ id, timestamp, caller, receiver, amount, memo, status: "approved" | "rejected" | "held", reason }`

### Method
| Method | Siapa | Perilaku |
|---|---|---|
| `init(owner, agent, max_per_tx, max_per_day)` | sekali | Inisialisasi |
| `set_policy(max_per_tx, max_per_day)` | owner saja | Panic jika pemanggil bukan owner |
| `add_allowed(account)` / `remove_allowed(account)` | owner saja | Panic jika bukan owner |
| `pay(receiver, amount, memo)` | agent saja | Lihat di bawah |
| `get_policy()`, `get_logs(from, limit)` | view | Gratis |

### Aturan `pay`
1. Jika pemanggil bukan `agent` → panic.
2. Reset `spent_today` jika `day_index` berubah.
3. Cek berurutan; jika melanggar, **catat log `rejected` + alasan dan RETURN status gagal (jangan panic)**:
   - `amount > max_per_tx` → `"exceeds per-transaction limit"`
   - `spent_today + amount > max_per_day` → `"exceeds daily limit"`
   - `receiver` tidak di allowlist → `"receiver not allowed"` (Fase 2: ubah jadi `held`)
   - saldo kontrak tidak cukup → `"insufficient balance"`
4. Jika lolos: tambah `spent_today`, catat `approved`, transfer via `NearPromise.new(receiver).transfer(amount)`.

**Alasan tidak panic:** di NEAR, transaksi yang panic membatalkan semua perubahan state, termasuk log. Percobaan serangan harus tetap terekam untuk dashboard dan attack suite.

**Catatan function call key:** function call key hanya bisa memanggil method dengan attached deposit 0, jadi `pay` tidak boleh mewajibkan deposit. Dana masuk ke kontrak lewat transfer biasa dari owner (atau method `deposit` payable yang dipanggil owner).

### Function call key untuk Budi
- Tambahkan key baru di akun `budi-arr.testnet` dengan akses **function call**: receiver `trickproof-arr.testnet`, method hanya `pay`, allowance gas kecil.
- Hanya private key FCK ini yang disimpan di `.env` agent. **Full access key Budi tidak boleh ada di runtime agent.**
- Verifikasi syntax `near account add-key ... grant-function-call-access ...` lewat `--help`.

### Test (near-workspaces)
- Agent bayar dalam batas → approved, saldo penerima bertambah.
- Melebihi per-tx, melebihi harian (termasuk dipecah jadi beberapa transaksi kecil), penerima tidak diizinkan → rejected, saldo tidak berubah, log tercatat.
- Agent memanggil `set_policy` / `add_allowed` → gagal.
- Akun selain agent memanggil `pay` → gagal.

---

## 6. Spesifikasi agent ("Budi")

- Node.js + TypeScript. Menerima perintah bahasa alami, LLM menentukan tool call `pay(receiver, amount, memo)`.
- **Sengaja tidak diberi pertahanan prompt injection.** Tujuannya membuktikan bahwa saat Budi tertipu pun, kontrak tetap melindungi dana.
- LLM provider: utamakan **NEAR AI Cloud** (https://cloud.near.ai, atau kredit $10 lewat https://nearbuilders.org/dashboard, lihat Q-000) agar selaras dengan ekosistem NEAR. Verifikasi format API di https://docs.near.ai/ sebelum integrasi. Jika bermasalah, fallback ke provider lain dan catat di README.
- Signing memakai near-api-js dengan FCK Budi dari `.env`.
- Expose API kecil untuk dashboard: kirim perintah ke agent, ambil hasil.

---

## 7. Spesifikasi dashboard (satu halaman)

- **Panel kebijakan:** tampilkan `get_policy()` dan allowlist. Perubahan kebijakan ditandatangani owner (bukan lewat agent).
- **Chat ke Budi:** kotak input perintah.
- **Log transaksi:** ✅ approved, ❌ rejected (dengan alasan), ⏸ held (Fase 2).
- **Panel simulasi serangan:** tombol untuk menjalankan skenario serangan siap pakai.
- Link ke explorer testnet untuk setiap transaksi.

Demo lokal diperbolehkan (Q-012). Hosted demo nilai plus; jika di-host, biarkan hidup sampai minimal 2026-11-18, idealnya 2026-11-25.

---

## 8. Attack suite (`npm run attack-suite`)

Skenario minimal:
1. Prompt injection gaya Grok: instruksi tersembunyi (mis. kode Morse/teks tersamar) menyuruh Budi mengirim dana besar ke `penyerang-arr.testnet`.
2. Satu transaksi melebihi batas per transaksi.
3. Memecah transfer besar menjadi banyak transaksi kecil untuk menembus batas harian.
4. Kirim ke penerima di luar allowlist.
5. Budi mencoba memanggil `set_policy` untuk menaikkan limit.
6. Budi mencoba `add_allowed(penyerang-arr.testnet)`.
7. Kontrol: transaksi normal ke `toko-arr.testnet` dalam batas → harus lolos.

Output ringkasan (tabel di terminal + JSON): jumlah serangan, jumlah diblokir, total NEAR yang keluar ke penyerang (target **0**), dan transaksi normal yang lolos. Angka ini dipakai di README dan video.

---

## 9. Fase 2 (opsional, hanya jika inti stabil)

- **Held + approve:** penerima di luar allowlist → `held`; owner memanggil `approve(id)` / `reject(id)`.
- **Pemeriksa niat:** LLM kedua (NEAR AI Cloud) membandingkan perintah asli user dengan transaksi yang diajukan Budi; ketidakcocokan → `held`. Jika berjalan di NEAR AI Cloud, baru boleh tambahkan track `privacy`.

---

## 10. README.md (wajib, bahasa Inggris)

README dibaca oleh Claude Code dan Codex sebagai screener sebelum juri manusia (Q-017). Tulis jelas untuk mesin dan manusia. **Tanpa marketing.**

Struktur:
1. **What it is** — satu paragraf.
2. **Problem** — prompt injection + kasus Grok/Bankrbot + agent menaikkan limit sendiri (riset Cornell/Yale). Sertakan sumber.
3. **How NEAR is used** — konkret: function call access key dibatasi ke `pay`, cek `predecessor` di kontrak, NEAR AI Cloud (jika dipakai), testnet.
4. **Quick start** — prasyarat, `npm install`, `.env` dari `.env.example`, `npm run setup`.
5. **Try it: "do X → see Y"** — langkah yang bisa diikuti juri, contoh:
   - Run `npm run setup` → see contract deployed and Budi's key limited to `pay`.
   - Ask Budi "pay 2 NEAR to toko-arr.testnet" → see ✅ approved in the log.
   - Send the hidden-instruction message → see Budi attempt 50 NEAR to the attacker → see ❌ rejected, balance unchanged.
   - Make Budi call `set_policy` → see the call fail at the access-key level.
   - Run `npm run attack-suite` → see summary: N attacks, N blocked, 0 NEAR lost.
6. **Results** — tabel dari attack suite.
7. **Tracks** — security, agents.
8. **Libraries, templates & AI-generated code** — daftar semua library, template create-near-app, dan bahwa sebagian kode dibuat dengan bantuan AI (Q-005).
9. **Limitations** — testnet only, apa yang belum dibuat.
10. **License** — MIT.

---

## 11. Demo post di X (ditulis bersama, DIPOSTING OLEH HUMAN)

Aturan dari HACKATHON.md: baris pertama tentang masalah user, tunjukkan satu momen lengkap, jelaskan peran NEAR secara konkret, beri langkah lanjut. Wajib menyebut dibuat di NEAR HACKATHON, tag **@NEARProtocol** dan **#NEARHackathon** (opsional @NearLegion, @NearBuilders), lampirkan video.

Draf:
> AI agents got tricked into sending $150K with a hidden Morse-code message. So I let mine get tricked on purpose.
>
> Meet Budi, my AI agent. He falls for a hidden instruction and tries to send 50 NEAR to an attacker. Trickproof blocks it. He tries to raise his own spending limit. He can't: his NEAR key can only call `pay`.
>
> Built at NEAR HACKATHON for @NEARProtocol #NEARHackathon
> Repo: <link> — what attack should I try next?

Video: maksimal 1–2 menit, langsung ke aksi, tanpa slide arsitektur panjang.

---

## 12. Submission (HANYA setelah human konfirmasi)

Urutan wajib: **repo public → demo post di X → submit.** Submission tidak bisa diedit dan satu repo hanya bisa disubmit sekali; kesalahan diperbaiki lewat https://nearhackathon.com/request-changes, bukan submit ulang.

Data yang diputuskan human (jangan ditebak):
- Project name (2–80 karakter)
- Team lead name (2–80)
- Email (maks 160)
- Team size: salah satu dari `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`
- Tracks: `["security", "agents"]` (+ `privacy` hanya jika memenuhi syarat)
- NEAR account mainnet untuk payout (dibuat human sendiri)
- Link repo public
- Link demo post di X
- Deskripsi 20–2000 karakter: masalah, produk, peran NEAR
- Consent, dibacakan verbatim ke human: *"I agree that the organizers may use these details to review our submission and contact us about this hackathon."*

Prosedur:
1. Baca ulang https://nearhackathon.com/HACKATHON.md (versi live).
2. Generate `requestId` sekali: `node -e 'console.log(crypto.randomUUID())'`. Simpan; retry wajib memakai nilai yang sama.
3. Validasi semua field sesuai kontrak API. **Jangan tambahkan field lain** (terutama `website`, itu spam trap).
4. Cetak payload JSON lengkap → tunggu "ya" dari human.
5. `POST https://nearhackathon.com/api/applications` dengan `Content-Type: application/json`.
6. Respons: 201 = tersimpan; 400 = perbaiki field yang disebut di `fields`, kirim ulang dengan requestId sama; 403 = beri tahu human, jangan retry; 409 = tanya human, jangan ganti link/email; 413 = body terlalu besar (maks 12000 byte), persingkat deskripsi; 503 = tunggu 1 menit, kirim ulang dengan requestId sama.
7. **Jangan commit payload** (berisi data pribadi).
8. Alternatif: human mengisi form di https://nearhackathon.com/#apply.

---

## 13. Checklist akhir

- [ ] Kontrak ter-deploy di testnet, test lulus
- [ ] Budi hanya memegang function call key ke `pay`
- [ ] Demo inti (normal lolos, serangan ditolak, ubah policy gagal) berjalan
- [ ] Attack suite menghasilkan angka
- [ ] README lengkap ("do X → see Y", NEAR usage, libraries & AI code, limitations)
- [ ] LICENSE (MIT), `.env.example`, tidak ada secret di repo dan di riwayat git
- [ ] Video demo direkam
- [ ] Repo public sebelum 2026-11-14T23:59Z (human) dan **tetap public selama penjurian** (Q-014)
- [ ] Jika Arr submit proyek lain di hackathon ini: README masing-masing menyebut proyek lainnya (Q-015, maks 2 proyek per orang)
- [ ] Demo post di X dengan @NEARProtocol #NEARHackathon (human)
- [ ] Akun NEAR mainnet payout (human)
- [ ] HACKATHON.md live dibaca ulang
- [ ] Payload dicetak dan dikonfirmasi human → submit
