---
name: pib-drive-saving
description: Where and how to save, name and share files on Google Drive for Partners in Biz (folder layout, Higgsfield output, no root saves, no public links, human-readable names, rclone upload by folder ID). Use before saving, uploading or sharing anything on Drive.
---

# Drive saving rules (Partners in Biz) — agreed with Peet, 10 Oct 2026

Read this before you save, upload or share anything on Google Drive.
The full folder map with IDs is FILEMAP.md (Drive: PIB Shared Drive › 02 Partners in Biz › FILEMAP.md; box: /workspace/drive/FILEMAP.md).

## 1. Where things go
Business work lives in the **PIB Shared Drive** (`0AMIddYkNl52sUk9PVA`). Peet's personal files live in his My Drive.

```
My Drive
  01 Personal/                         Peet only. Agents never write, move or open anything here.

PIB Shared Drive
  02 Partners in Biz/
    Admin & Finance/                   Company registration, Tax forms, Old PiB platform archive (SARS and bank statements joins here once Peet drags it in)
    Clients/<Company> (<Contact>)/     e.g. "Hunt and Gun (Christo Barnard)"
      Assets/Images | Assets/Video | Assets/Brand | Assets/Social
      Deliverables/                    finished work for the client
      Contracts & Quotes/
      Meetings & Notes/
      Shared with client/              the ONLY folder you share with the client
    Products/<Product>/                our own products, e.g. Athleet, Lumen
      Brand | Design | Marketing assets/Images | Marketing assets/Video | App store | Shared externally
    Marketing & Sales/                 Website mockups for leads, Lead research, Jagter lead batches, Prospect audits, PiB brand and marketing assets
    Internal/                          agent workspaces
    Archive/                           finished or old things (Completed clients, Server backups, Agent test files)
  03 Press (KDP)/Morgan Hale/<Book>/
  04 Channels/<Channel>/<YYYY-MM-DD>/  daily clips (AI Daily Clips, Capital Gains)
```

## 2. Rules
1. **Never save to the Drive root** (My Drive root or Shared Drive root). Always save into the right folder above.
2. **Higgsfield output** (images and video) goes to the client's or product's `Assets/Images` or `Assets/Video` (products: `Marketing assets/Images` or `Marketing assets/Video`). Never the root, never a loose folder.
3. **Human-readable names only.** Company, product and contact names, dates and plain descriptions.
   - Files: `YYYY-MM-DD <Client or product> <what it is> v01.ext`, e.g. `2026-10-10 Athleet athlete profile mock v01.png`.
   - Folders: plain words, e.g. `Clients/Gundemy (Pieter Goosen)/Assets/Images`.
   - Never IDs as names: no Paperclip issue keys (PAR-1234), UUIDs, Drive IDs or invoice codes as the only label. IDs belong in FILEMAP.md, not in names.
4. **No public links.** Never set "Anyone with the link". To share with a client, put the file in `Shared with client` and ask Peet to share it with the client's named email. Never change existing sharing (for example Chantelle, Peet's accountant, keeps edit access on SARS and bank statements).
5. **Client folders:** create one only when a client needs it, with the standard subfolders above. Name it `<Company> (<Contact>)`. Don't invent a contact name; use just the company if you don't know it.
6. **Large files with rclone:** upload INTO a folder by ID with
   `rclone copy /path/file.mp4 gdrive: --drive-root-folder-id <FOLDER_ID>`
   For a Shared Drive folder add `--drive-team-drive 0AMIddYkNl52sUk9PVA`.
   Never write `gdrive:<ID>` or `gdrive:{<ID>}` — that creates a new folder literally named after the ID at the root.
7. **Don't touch** Peet's `01 Personal`, `Motor`, or the folders Stean owns (his "Clients" folder with Velox and Elemental). Don't delete anything; if something looks like junk, list it for Peet.
8. If you're not sure where something goes, ask Peet. Don't guess and don't park it in the root.
