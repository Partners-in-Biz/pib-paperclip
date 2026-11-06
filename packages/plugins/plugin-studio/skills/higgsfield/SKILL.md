---
name: higgsfield
description: Generate images and short videos (Higgsfield models) through the Studio plugin's tools (partnersinbiz.studio). Use for any visual for social posts, ads, store screenshots, hero images or B-roll. Never call the Higgsfield API, a key or a script yourself.
---

# Higgsfield (image and video generation, through Studio)

## The one rule: use the Studio tools

- Every generation goes through the `partnersinbiz.studio` tools. Studio holds the Higgsfield account, prices each job, checks it against the company's monthly cap, saves the result as a Studio asset (private R2) and links it to your issue.
- Do not call the Higgsfield REST API, an API key from your environment or any script of your own. Do not use the Higgsfield MCP connector or `higgsfield-mcp-unified`. A key in your environment is not for you to use.
- Never print, log, comment or commit a key, and never paste a Studio file path outside the company.

## Tools

- `studio-usage`: credits used this month, the cap and what is left. Read-only.
- `studio-estimate`: free. The price of a job and what is left under the cap. Always run it before `studio-generate`.
- `studio-generate`: queue the job. Pass `model`, `prompt`, the model's own fields flat in `params` (e.g. `{"aspect_ratio":"9:16"}`), a `name`, and `batchSize` only for planned variants (each one is charged). `preset` picks a Photo Studio style that builds the prompt for you.
- `studio-generation-status`: where a job is (queued, submitted, storing, succeeded, failed), its cost and asset id.
- `studio-list-assets`, `studio-get-asset`: find assets and open one. `studio-get-asset` gives a local file path to look at; it is not a link and expires after a day (ask again).
- `studio-import-from-attachment`: save a file you made yourself (HTML slide render, ffmpeg cut) as a Studio asset: attach it to the issue, then pass its attachment id and `altText`.
- `studio-link-asset`: record where an asset is used (post, campaign, page, ...).
- `canvas-create-from-brief`: free. Lay out a Studio canvas board from a brief (title, prompts, optional library asset ids) for a person to open and press Generate. It never generates or spends.
- `studio-review-asset`: `approved` sends the asset to Social's media library for its client (or own work), where `list-media-assets` shows it for a post. `rejected` keeps it out. This files the asset; it does not approve or publish a post.

Scope: pass the same `client` (`company:<id>` or `contact:<id>`) on every call, or leave it out to use the client of the issue's project (own work when it has none). Never use another scope's brand or media.

## How to generate

1. `studio-estimate` with the model, prompt and params you mean to use. Too expensive or over the cap: change the request (cheaper model, shorter video, fewer variants), do not loop.
2. `studio-generate`. It returns a generation id (and a group id for a batch). Do not poll or sit waiting: Studio comments on your issue and wakes you when the file is saved. Before you end the run, set an issue monitor as a fallback (kind `external_service`, service "Studio", about 15 minutes), as for any wait on a machine.
3. When woken, `studio-get-asset` and look at the file. Check for artifacts (hands, text, logos, warped products). Keep the strongest, note why, and reject the rest with `studio-review-asset`.
4. Hand the keeper on: `studio-review-asset` `approved` for social work (then `list-media-assets` in Social for its media id), or `studio-link-asset` to where it is used. Record the model, prompt and asset ids on the issue so the result can be reproduced.

Models: `higgsfield-ai/soul/v2/standard` is the cheapest image; `recraft/v4.1/text-to-image` and `bytedance/seedance/v2/text-to-video` have worked. For another model, try it with `studio-estimate` first: an unknown model or bad field fails there for free.

## When it fails

- `studio-estimate` or `studio-generate` refuses because the cap is reached, or no cap is set (generation is off): stop. Comment the exact message and ask your manager (PiB for own work); only a company owner can change a cap, on the Studio page. Do not look for another way to generate.
- A generation ends `failed`: read the reason in `studio-generation-status`, fix the request, estimate again. One retry, then report.
- The Studio tools are missing from your session: comment that and set the issue blocked naming PiB. Do not fall back to the API or a key.

## Where to save (Drive rules, agreed with Peet 10 Oct 2026)

- The Studio asset is the master copy. For a person to find it, also save finished files in Google Drive, PIB Shared Drive:
  - client work: `02 Partners in Biz / Clients / <Company> (<Contact>) / Assets / Images` or `Assets / Video`
  - our own products: `02 Partners in Biz / Products / <Product> / Marketing assets / Images` or `Video`
- Never save to the Drive root, never into Peet's `01 Personal`, never turn on "Anyone with the link".
- Human-readable file names only: `YYYY-MM-DD <Client or product> <what it is> v01.png`. No issue keys, UUIDs or Drive IDs in names.
- If the client folder doesn't exist, create it with the standard subfolders (see `pib-drive-saving`). If you can't reach Drive, say so; the Studio asset stays.

## Social content quality bar

- Follow the brand guidelines and voice for the product (company wiki / task context, `get-client-profile`). If none exist, ask rather than invent a style.
- Match the platform: 9:16 Reels/TikTok/Shorts/Stories, 4:5 or 1:1 feed, 16:9 YouTube/LinkedIn. Keep the subject inside safe margins.
- Generate 2-3 candidates only when the task needs a choice; each costs credits. AI text is unreliable: add copy, logos and UI afterwards, not in the prompt.
- Show real products, people and logos accurately. No likenesses of real people without consent. Disclose AI media where required.
- Nothing is published without the normal review path; generating an asset is not approval to post it (`pib-creative-studio`, `pib-social-content`, `pib-social-publish`).
