# PAR-1353 — Home page around the main product range (Agri Auctions SA)

Sprint: Agri Auctions SA — ecommerce plan, changePolicy pr_only, no SEO plugin (theme renders its own meta/og/H1/body via [home_page_content_unifomr] shortcode), no SFTP, file editors locked.

## Primary keyword
"farm machinery auctions" (priority #1; GSC pos 3, DR 35 — fastest win). Target: the home page (https://agriauctionssa.co.za/).

## Current live state (check-meta + crawler-sim 2026-10-05)
- title: "Agri Auctions SA | Buy & Sell Farm Equipment Online" (51 chars, no keyword)
- meta description (live): 317-char hashtagged string — FAILS length rule (max ~160); live value differs from wp-seo stored value => theme overrides meta
- h1: 2 tags — "Agri Auctions SA" + "Partner websites to check out"
- og:image empty on live (wp-seo has logo set); ogTitle all-caps theme default
- canonical OK, indexable, robots fine, images 18 / 0 missing alt
- Body rendered by shortcode: hero, WHEN/WHERE auction, FAQ, "How Agri Auctions..." sections, marketplace section

## Definition of done
Home page has primary keyword in title AND H1, passes check-meta. Requires BOTH a wp-seo field edit AND a theme-template build (H1/intro/2nd-H1 fix + og output). pr_only + locked editors => change set handed to a person/developer.

## Draft change set (copy-ready)

### A. SEO fields — wp-seo, postId 396710 (home), reason required
- title: "Agri Auctions SA | Buy & Sell Farm Equipment Online" => "Farm Machinery Auctions South Africa | Agri Auctions SA"
- description (live overridden by theme, fix in template too): => "Bid on farm machinery auctions in South Africa — tractors, implements, livestock, trucks, trailers and farm spares. Secure online bidding that protects both buyers and sellers."
- ogTitle: => "Farm Machinery Auctions South Africa | Agri Auctions SA"
- ogDescription: => same as description
- ogImage: "https://agriauctionssa.co.za/wp-content/uploads/2026/01/agri-veilings-sa-logo-1-4.png" (already set; only effective if theme reads it)

### B. Theme template — shortcode [home_page_content_unifomr] (Gum and Hunt) hero, HEAD change
- H1 "Agri Auctions SA" => "Farm Machinery Auctions in South Africa"
- Hero intro paragraph (replaces "Secure trading platform that protects buyers and sellers for anything related to agriculture."):
  "Bid on farm machinery auctions in South Africa. Agri Auctions SA is a secure online platform for buying and selling farm machinery, implements, livestock, vehicles, trailers and farm spares nationwide. Auctions take place entirely online and we act as a middleman, releasing payment to the seller only once the buyer has received the item."
  (facts from client sheet: "Auctions take place entirely online at https://agriauctionssa.co.za", "We act as a middleman...")
- Add CTA links in hero: View Auctions => /auctions/, List Your Lot => /auctions/listyourlot/, Join The Auction => /join-the-auction/
- Demote second H1 "Partner websites to check out" => H2 (leave a single H1)

### C. Internal links (goal requires links to core pages)
Confirm hero/first-paragraph links to /auctions/, /about-us/, /services/, /contact-us/, /join-the-auction/.

## Verification after applied
check-meta, crawler-sim on https://agriauctionssa.co.za/ => 1 H1 containing "farm machinery auctions", title/desc <= lengths, og:image present.
