# Preview service

Public page for client sign-off links (`https://preview.partnersinbiz.online/p/<token>`; Caddy also still answers `preview.65.108.146.144.sslip.io`). Built by the SEO plugin's `create-preview` tool.

- Code: `server.mjs`, unit `pib-preview.service`, installed at `/home/paperclip/pib-preview/` on the VPS, port 3031 behind Caddy.
- Database role `pib_preview` (SELECT on `previews`, UPDATE of the answer columns only). Its URL is in `/root/pib-ops/preview.env`.
- Caddy block for `preview.partnersinbiz.online` reverse-proxies to 127.0.0.1:3031.
- A client's answer is posted on the task issue by the plugin job `seo-previews` (every 5 minutes).
- Links expire after 30 days.
