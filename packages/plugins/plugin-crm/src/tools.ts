import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { SITE_ACCESS_KINDS, SITE_PLATFORMS, SITE_SEO_PLUGINS } from "@partnersinbiz/pib-plugin-kit/client-sites";
import { ACTIVITY_KINDS, COMPLETION_MODES, DEAL_STATUSES, FIELD_TYPES, FIND_KINDS, FIND_MAX, LIFECYCLES, NEXT_ACTIONS, RECORD_TYPES, SEQUENCE_DELIVERIES } from "./domain.js";
import { SOURCE_STATUSES } from "./lead-form.js";
import { CARE_TOOLS } from "./care-tools.js";
import { ESIGN_TOOLS } from "./esign-tools.js";
import { GROWTH_TOOLS } from "./growth-tools.js";
import { SERVICE_KEYS, SERVICES } from "./services.js";

/**
 * The CRM's agent tools. Every parameter has a description, and an enum where
 * the values are fixed. Results are JSON with ids, `company:<id>` /
 * `contact:<id>` refs and deep links.
 */

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    required,
    properties,
    additionalProperties: false,
  };
}

const text = (description: string): JsonSchema => ({ type: "string", description });
const textList = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const int = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "integer", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const bag = (description: string): JsonSchema => ({ type: "object", additionalProperties: true, description });

const P = {
  companyRecordId: text("CRM company id (from find-records or get-company). company:<id> also works."),
  contactId: text("CRM contact id (from find-records or get-contact). contact:<id> also works."),
  dealId: text("Deal id (from list-deals or get-company)."),
  sequenceId: text("Sequence id (from list-sequences)."),
  productId: text("Product id (from the create-product result)."),
  client: text("The client: company:<id> or contact:<id> (from find-records)."),
  name: text("Name as the client writes it."),
  domain: text("Website domain without https, e.g. acme.co.za. Email leads from this domain are linked to the company."),
  lifecycle: oneOf(LIFECYCLES, "lead: new, not qualified. prospect: qualified, talking about work. customer: has bought (set for you when a deal is won or an invoice is paid). churned: stopped buying, or a lead that is not a fit (stops their sequences)."),
  currency: text("3-letter currency code, e.g. ZAR (the default)."),
  billingEmail: text("Where the company's quotes and invoices are sent, e.g. accounts@acme.co.za. Must be a valid email address."),
  phone: text("The company's phone number as printed on invoices, e.g. +27 21 555 0100."),
  address: text("Multi-line postal address as printed on invoices (use line breaks between lines, max 500 characters)."),
  vatNumber: text("The company's VAT number as the client gives it. Never guess one."),
  registrationNumber: text("The company's registration number as the client gives it. Never guess one."),
  tagsNew: textList("Labels, e.g. retainer or priority."),
  tagsReplace: textList("The full tag list: it replaces the current tags."),
  custom: bag("Extra fields declared with define-field, as { fieldKey: value }."),
  emails: textList("Email addresses; the first one gets email."),
  phones: textList("Phone numbers with the country code, e.g. +27 82 123 4567."),
  nextActionKind: oneOf(NEXT_ACTIONS, "The next thing to do with this person."),
  nextActionDueAt: text("When the next action is due: ISO date or date-time, e.g. 2026-10-01."),
  recordType: oneOf(RECORD_TYPES, "The kind of record."),
  recordId: text("The record's id."),
  amountMinor: int("Value in minor units (cents): 150000 is R 1,500.00.", { minimum: 0 }),
};

export const CRM_TOOLS: PluginToolDeclaration[] = [
  // -------------------------------------------------------------------------
  // Find and read
  // -------------------------------------------------------------------------
  {
    name: "find-records",
    displayName: "Find companies and contacts",
    description:
      "Search the CRM by name, email, domain, phone or tag before you create anything. Returns each match's ref (company:<id> or contact:<id>), lifecycle and a link. Give a query, a lifecycle, or both.",
    parametersSchema: schema([], {
      query: text("Name, email, domain (acme.co.za), phone or tag. Case does not matter; partial names match."),
      kind: oneOf(FIND_KINDS, "Search companies, contacts, or both (any, the default)."),
      lifecycle: oneOf(LIFECYCLES, "Only records in this lifecycle, e.g. customer."),
      limit: int(`Most results to return, 1 to ${FIND_MAX} (default 10).`, { minimum: 1, maximum: FIND_MAX }),
    }),
  },
  {
    name: "get-company",
    displayName: "Get company",
    description:
      "A company client in one read: profile (brand voice, audience, services, links), people, open deals, the last 10 activities, lifecycle, tags, leads from their own channels and workspaceLinks to each module's client workspace.",
    parametersSchema: schema(["companyRecordId"], { companyRecordId: P.companyRecordId }),
  },
  {
    name: "get-contact",
    displayName: "Get contact",
    description:
      "A contact in one read: emails, phones, email status, lifecycle, companies, open deals, running sequences, the last 10 activities, lead score and workspaceLinks. A contact without a company is a client (sole trader) and has a profile.",
    parametersSchema: schema(["contactId"], { contactId: P.contactId }),
  },
  {
    name: "list-deals",
    displayName: "List deals",
    description: "Deals with their stage, status, value and client ref. Filter by status, stage or client.",
    parametersSchema: schema([], {
      status: oneOf(DEAL_STATUSES, "open, won or lost."),
      stage: text("Stage id or stage name, e.g. Proposal (see list-stages)."),
      client: text("Only this client's deals: company:<id> or contact:<id>. A company includes its people's deals."),
      limit: int("Most deals to return, 1 to 50 (default 25).", { minimum: 1, maximum: 50 }),
    }),
  },
  {
    name: "list-stages",
    displayName: "List pipeline stages",
    description: "The pipeline's stages in order, with each stage's id, kind (open, won, lost) and deal count. Use the id with move-deal.",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-sequences",
    displayName: "List sequences",
    description: "Sequences with their id, delivery (issue or email), whether email is approved, their steps and how many contacts are running.",
    parametersSchema: schema([], {}),
  },
  {
    name: "get-client-profile",
    displayName: "Get client profile",
    description:
      "How to talk for a client: brand voice, audience, services they buy from us (from a fixed list), website, booking link, banned words and tone notes, plus the brand kit (logo key, colours, fonts, tone examples) and the proposal references (scope template, standard terms), and which fields are still missing. Read it before you write anything for or to the client.",
    parametersSchema: schema(["client"], { client: P.client }),
  },
  {
    name: "update-client-profile",
    displayName: "Update client profile",
    description:
      "Fill in or change a client's profile (during onboarding and whenever you learn more). Only the fields you send change; send null or an empty value to clear one. A field a person set is kept: you may only fill it while it is empty. services take keys from a fixed list; other wording is mapped when it can be and kept as text otherwise. Adding a service for a customer opens that service's onboarding step. The brand kit (logo key, colours, fonts, tone examples) and the proposal references live here too.",
    parametersSchema: schema(["client"], {
      client: P.client,
      brandVoice: text("How the client sounds, in 1-3 sentences, e.g. warm, plain South African English, no jargon."),
      audience: text("Who they sell to: the people, where they are and what they care about."),
      services: {
        type: "array",
        items: { type: "string" },
        description: `What they buy from us. Use these keys: ${SERVICE_KEYS.join(", ")} (${SERVICES.map((service) => `${service.key} = ${service.label}`).join("; ")}). Send the whole list: it replaces the current one.`,
      } as JsonSchema,
      website: text("Their website, e.g. https://acme.co.za."),
      bookingLink: text("Where their customers book or enquire, e.g. a Calendly or contact page link."),
      bannedWords: textList("Words and phrases never to use for them."),
      toneNotes: text("Anything else about tone: emoji, formality, words they prefer, topics to avoid."),
      logoKey: text("Brand kit: the R2 object key of the client's logo, inside this company's folder, e.g. social/<company id>/acme-logo.png. The CRM keeps the key only."),
      primaryColor: text("Brand kit: the main brand colour as hex, e.g. #1A73E8."),
      secondaryColor: text("Brand kit: the second brand colour as hex."),
      accentColor: text("Brand kit: the accent colour as hex."),
      fonts: textList("Brand kit: font family names, headings first, e.g. Playfair Display, Inter (6 at most)."),
      toneExamples: textList("Brand kit: 2-8 short pieces written the way the client wants to sound (a caption, a greeting, a sign-off), each under 400 characters."),
      scopeTemplateRef: text("Proposals: a reference to the client's scope-of-work template (a document id, a repo path or a link)."),
      termsRef: text("Proposals: a reference to the client's standard terms (a document id, a repo path or a link)."),
    }),
  },
  // -------------------------------------------------------------------------
  // Lead forms (public lead capture)
  // -------------------------------------------------------------------------
  {
    name: "create-lead-endpoint",
    displayName: "Create a lead form",
    description:
      "Make a lead form that takes enquiries from a website: it returns the form's key, the snippet to install on the site and a curl test. A lead that arrives through a client's form is THE CLIENT'S lead: kept on their CRM page, handed to them through an issue in their project, never added to our contacts. With no client the form is ours and its leads follow the normal lead flow. Asking again with the same client and label returns the same form (no new key). Putting the snippet on a client's site is a change to that site: do it through the client's repo project, not by hand on the live site. A server-to-server signing secret (for the client's own server, e.g. WordPress PHP) is a credential: only a person makes it, on the client's Lead forms card, so put a Needs-you item on the client when one is needed.",
    parametersSchema: schema([], {
      client: text("The client the form belongs to: company:<id> or contact:<id>. Leave out for our own form."),
      label: text("A short name, e.g. Contact form or Quote request (the same label for the same client returns the same form)."),
      siteId: text("One of the client's registered websites (list-client-sites). Only with client."),
      siteUrl: text("The page address the form goes on, when the site is not registered."),
      consentText: text("The wording next to the marketing tick box. Default: the client (or we) may email news and offers, with an unsubscribe line. Must say who will email them."),
      privacyUrl: text("A link to the privacy policy shown under the form."),
      successMessage: text("What the visitor reads after sending (default: Thank you, we will be in touch)."),
    }),
  },
  {
    name: "rotate-lead-key",
    displayName: "Rotate a lead form key",
    description:
      "Give a lead form a new key. The old key keeps working for 7 days so the snippet on the site can be swapped without losing leads. Use it after a key leaked, or to turn on spam protection that was set up after the snippet was installed. It never makes a signing secret: only a person does that, on the client's Lead forms card.",
    parametersSchema: schema(["sourceId"], {
      sourceId: text("The form (from list-lead-sources)."),
    }),
  },
  {
    name: "list-lead-sources",
    displayName: "List lead forms",
    description:
      "Every lead form (or one client's), with its key, snippet, status, how many leads it took and the last one, and any warning (no lead yet, the old key about to stop). The signing secret is never shown.",
    parametersSchema: schema([], {
      client: text("Only this client's forms: company:<id> or contact:<id>."),
      ownOnly: bool("true: only our own forms."),
    }),
  },
  {
    name: "update-lead-source",
    displayName: "Update a lead form",
    description:
      "Change a lead form's wording, or pause it (status paused: it stops taking leads) and resume it (status active). Only a person can switch a form off for good (status revoked); put that on Needs you.",
    parametersSchema: schema(["sourceId"], {
      sourceId: text("The form (from list-lead-sources)."),
      label: text("A new short name."),
      consentText: text("The wording next to the marketing tick box."),
      privacyUrl: text("A link to the privacy policy."),
      successMessage: text("What the visitor reads after sending."),
      status: oneOf(SOURCE_STATUSES, "active: takes leads. paused: stops for now. revoked: off for good (a person only)."),
    }),
  },
  // -------------------------------------------------------------------------
  // New clients, and the canary client
  // -------------------------------------------------------------------------
  {
    name: "start-new-client",
    displayName: "Start a new client",
    description:
      "Start a new client or check where one stands. Links a Paperclip project to the client when you pass projectId, sets the services when you list them, and returns the checklist of what is still to do (project and git workspace, the development branch rule, the agent guide, website, lead form, brand kit, one step per service) with who does each. The project and its repo are created by the ops tool new-client-project.py, which then calls the board action crm.link-client-project; this tool shows what remains.",
    parametersSchema: schema(["client"], {
      client: P.client,
      projectId: text("A Paperclip project that belongs to this client (from list-client-projects): it is linked now."),
      services: { type: "array", items: { type: "string" }, description: `The services the client bought: ${SERVICE_KEYS.join(", ")}.` } as JsonSchema,
    }),
  },
  {
    name: "create-canary-client",
    displayName: "Create the canary client",
    description:
      "For the acceptance agent's test journeys (every agent with CRM tools can call it, so other agents leave it alone). Finds or creates the internal canary client (PiB Canary Co): a company, a contact whose address ends @canary.invalid (no mail system can deliver to it) and a canary lead form, all flagged. Use it to run lead, qualify, quote, invoice and payment proof without touching a real client. Everything outward for it is a draft or a dry run. Asking again returns the same client.",
    parametersSchema: schema([], { runRef: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Optional. Any reference of your own (the acceptance journeys pass their run id); it is echoed back as runRef so you can show the answer belongs to this call." } }),
  },
  {
    name: "cleanup-canary",
    displayName: "Clean up the canary client",
    description:
      "For the acceptance agent only after its test journey (needs confirm true). Remove the canary client's own records (company, flagged contacts, deals, leads, lead forms, notes). It never touches a record that is not flagged canary. Quotes and invoices other modules hold for it are theirs to remove.",
    parametersSchema: schema(["confirm"], { confirm: bool("Must be true: this deletes records.") }),
  },
  // -------------------------------------------------------------------------
  // Websites and projects
  // -------------------------------------------------------------------------
  {
    name: "list-client-sites",
    displayName: "List client websites",
    description:
      "A client's websites (a client can have several): address, platform (WordPress, Next.js …), SEO plugin, hosting, how agents reach it (repo project, PiB Connector, SFTP) and whether the Connector answers. Use the site id with the wp-* tools.",
    parametersSchema: schema(["client"], { client: P.client }),
  },
  {
    name: "save-client-site",
    displayName: "Save client website",
    description:
      "Add a website to a client, or change one (pass siteId). Only the fields you send change. repo and sftp access need the site's Paperclip project (projectId). You cannot connect the PiB Connector: a person does that on the CRM client page.",
    parametersSchema: schema([], {
      siteId: text("The site to change (from list-client-sites). Leave out to add a new site."),
      client: P.client,
      url: text("The site's address, e.g. https://www.acme.co.za (scheme and host; paths are dropped)."),
      label: text("Short name when a client has several sites, e.g. main site, shop, auctions."),
      platform: oneOf(SITE_PLATFORMS, "What the site is built on."),
      seoPlugin: oneOf(SITE_SEO_PLUGINS, "WordPress only: the SEO plugin on the site. The Connector's health check fills it in."),
      hosting: text("Where it is hosted, e.g. xneelo, vercel, afrihost."),
      access: { type: "array", items: { type: "string", enum: [...SITE_ACCESS_KINDS] }, description: "How agents reach it: repo (code in the project's workspace), connector (PiB Connector plugin), sftp (file access; the login is env on the project)." },
      projectId: text("The Paperclip project for this site's code and deploys (from list-client-projects)."),
      webRoot: text("SFTP only: the WordPress folder under the SFTP login, e.g. public_html."),
      notes: text("Anything an agent must know: staging URL, cache plugin, who deploys, rules like 'deactivate, never delete'."),
    }),
  },
  {
    name: "check-client-site",
    displayName: "Check client website",
    description: "Ping the site's PiB Connector and read its health (WordPress, PHP, theme, SEO plugin, sitemap, search engine visibility, plugins). Updates the site's status for every module.",
    parametersSchema: schema(["siteId"], { siteId: text("The site (from list-client-sites).") }),
  },
  {
    name: "connect-client-site",
    displayName: "Pair the Connector over SFTP",
    description:
      "Only for a WordPress site with sftp access and a project: makes a new Connector key and returns the steps to install and pair the plugin over SFTP (plugin folder, key file, mu-plugin loader). The old key stops working. Sites without SFTP are paired by a person on the CRM client page.",
    parametersSchema: schema(["siteId"], { siteId: text("The site (from list-client-sites).") }),
  },
  {
    name: "site-changes",
    displayName: "Website change log",
    description: "The changes Paperclip made to a site through the Connector (newest first), with who asked, why and the change ids wp-undo takes.",
    parametersSchema: schema(["siteId"], { siteId: text("The site (from list-client-sites)."), limit: int("How many (default 30, max 100).", { minimum: 1, maximum: 100 }) }),
  },
  {
    name: "wp-health",
    displayName: "WordPress: health",
    description: "Through the PiB Connector: WordPress and PHP versions, theme, SEO plugin, sitemap provider, whether search engines are allowed, redirects provider, plugins and waiting updates.",
    parametersSchema: schema(["siteId"], { siteId: text("A WordPress site with the Connector (from list-client-sites).") }),
  },
  {
    name: "wp-seo",
    displayName: "WordPress: page SEO",
    description:
      "Read (op get), list (op list) or change (op set) SEO for a page, post, category or tag (termId), or a post type archive such as the shop (postTypeArchive): title, meta description, canonical, noindex/nofollow, focus keyword, Open Graph title, description and image (ogImage). Writes go into the site's SEO plugin (Yoast or Rank Math) so wp-admin shows the same. Only the fields you send change; null or an empty string clears an override. op list audits many pages at once: use missing to find pages without a title, description or share image. ogImage must be an https URL of an image you have the right to use, ideally one you put in the Media Library with wp-media sideload. Check the live page afterwards with check-meta.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["get", "set", "list"], "get reads one target, set changes it, list audits many pages."),
      url: text("The page: full or site-relative URL (/about). The home page is /. A category or archive URL also works when it matches exactly."),
      postId: int("The WordPress post or page id, instead of url.", { minimum: 1 }),
      termId: int("A category, tag or product category id, instead of url. Use with taxonomy when the id could belong to more than one.", { minimum: 1 }),
      taxonomy: text("With termId: the taxonomy, e.g. category, post_tag, product_cat. Leave out to search public taxonomies."),
      postTypeArchive: text("The post type whose archive page to read or change, e.g. product (the shop). Yoast only for set."),
      title: { type: ["string", "null"], description: "SEO title (under ~60 characters)." } as JsonSchema,
      description: { type: ["string", "null"], description: "Meta description (under ~155 characters)." } as JsonSchema,
      canonical: { type: ["string", "null"], description: "Canonical URL, only when it must differ from the page. Not supported on archives." } as JsonSchema,
      noindex: { type: ["boolean", "null"], description: "true keeps the page out of search, false forces index, null uses the default." } as JsonSchema,
      nofollow: { type: ["boolean", "null"], description: "true adds nofollow, null uses the default. Not supported on archives." } as JsonSchema,
      focusKeyword: { type: ["string", "null"], description: "The page's main keyword." } as JsonSchema,
      ogTitle: { type: ["string", "null"], description: "Title for social shares." } as JsonSchema,
      ogDescription: { type: ["string", "null"], description: "Description for social shares." } as JsonSchema,
      ogImage: { type: ["string", "null"], description: "Image for social shares: an https URL (best: a Media Library URL from wp-media sideload) or a site-relative path. Never an image you have no rights to. null or an empty string clears it." } as JsonSchema,
      reason: text("Required for set: one line on why (kept in the site's log)."),
      postType: text("list: the post type to list, default page (e.g. page, post, product)."),
      status: oneOf(["publish", "draft", "pending", "private", "future"], "list: post status, default publish."),
      search: text("list: only pages whose title matches this text."),
      page: int("list: page number of results, from 1.", { minimum: 1 }),
      perPage: int("list: results per page (default 50, max 100).", { minimum: 1, maximum: 100 }),
      missing: { type: "array", items: { type: "string", enum: ["title", "description", "ogImage"] }, description: "list: keep only pages missing at least one of these." } as JsonSchema,
    }),
  },
  {
    name: "wp-media",
    displayName: "WordPress: media library",
    description:
      "Media Library through the Connector. op list: find images (missingAlt: true finds images with no alt text; postId lists a page's images). op sideload: add an image from an https URL you have the rights to use (brand kit, client Drive, our own generated image; never hotlink or copy an image you have no rights to); jpeg, png, webp, gif or avif, up to 10 MB; the same URL is reused, not duplicated; this cannot be undone. op set-featured: set a post or page's featured image (from attachmentId or imageUrl). op alt: set alt text on up to 50 library images at once. Alt text is plain, specific and under 300 characters. Featured images and alt text change live pages, so give a reason and check the live page afterwards with check-meta or crawler-sim. Nothing here deletes anything.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["list", "sideload", "set-featured", "alt"], "list finds images, sideload adds one from a URL, set-featured sets a post's featured image, alt sets alt text."),
      search: text("list: images whose title matches this text."),
      postId: int("list: only this post's images. sideload: attach the new image to this post (does not make it featured). set-featured: the post or page.", { minimum: 1 }),
      missingAlt: bool("list: true keeps only images whose alt text is empty."),
      mime: oneOf(["image"], "list: image keeps only images."),
      page: int("list: page number of results, from 1.", { minimum: 1 }),
      perPage: int("list: results per page (default 50, max 100).", { minimum: 1, maximum: 100 }),
      imageUrl: text("sideload, set-featured: https link to the image. Only an image you have the rights to use."),
      attachmentId: int("set-featured: an image already in the Media Library (from list), instead of imageUrl.", { minimum: 1 }),
      title: text("sideload, set-featured: the Media Library title for a new image."),
      alt: text("sideload, set-featured: alt text for the image (plain text, under 300 characters)."),
      filename: text("sideload: the file name to store it as, e.g. acme-plumber-durban.jpg."),
      items: {
        type: "array",
        description: "alt: 1 to 50 images to set alt text on. An empty alt clears it.",
        items: schema(["attachmentId", "alt"], {
          attachmentId: int("The Media Library image (from op list).", { minimum: 1 }),
          alt: text("Alt text: plain text under 300 characters; empty clears it."),
        }),
      } as JsonSchema,
      reason: text("Required for sideload, set-featured and alt: one line on why (kept in the site's log)."),
    }),
  },
  {
    name: "wp-content",
    displayName: "WordPress: page and post content",
    description:
      "Read and edit page copy through the Connector. op get: the post's raw content (block markup, up to 500 KB) and whether the Connector created it. op images: every image in the content with its alt text. op img-alt: change only the alt attribute of listed images by index (use this for in-content alt text; nothing else in the content changes). op update: change title, content, excerpt or slug of an existing post or page; send only what changes, always with a reason. The site keeps the last 5 versions and refuses scripts, iframes, forms and event handlers that are not already in the content. It cannot change status, author or password. op create: a new page or post as a DRAFT (never live). op publish: publishes a draft only if the Connector created it, and only when the task tells you to publish; anything else is refused. Limits: no deletes, ever; existing content is never published or unpublished by you; a changed slug on a page with traffic also needs a redirect (wp-redirects). After every change check the live page with check-meta or crawler-sim (a draft is checked at its previewUrl). Read with get before you update, and change the smallest thing that does the job.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["get", "images", "img-alt", "update", "create", "publish"], "get reads, images lists in-content images, img-alt sets alt on them, update edits, create makes a draft, publish publishes your own draft."),
      url: text("The page (full or site-relative URL). get, images, img-alt and update take url or postId."),
      postId: int("The WordPress post or page id, instead of url. publish needs postId.", { minimum: 1 }),
      alts: {
        type: "array",
        description: "img-alt: 1 to 100 images to change, by index from op images.",
        items: schema(["index", "alt"], {
          index: int("The image's index from op images (starts at 0).", { minimum: 0 }),
          alt: text("Alt text: plain text under 300 characters."),
        }),
      } as JsonSchema,
      title: text("update, create: the post title."),
      content: text("update, create: the full new post content (block markup). update replaces all of it, so start from op get and change only what the task needs."),
      excerpt: text("update, create: the excerpt."),
      slug: text("update, create: the URL slug. A changed slug on a page with traffic also needs wp-redirects set."),
      postType: oneOf(["page", "post"], "create: page (default) or post."),
      parentId: int("create: the parent page id.", { minimum: 1 }),
      reason: text("Required for img-alt, update, create and publish: one line on why (kept in the site's log)."),
    }),
  },
  {
    name: "wp-connector",
    displayName: "WordPress: update the Connector",
    description:
      "Update the PiB Connector plugin on a site to the build Paperclip ships. You give only siteId and a reason: the CRM sends the download address and checksum itself, you cannot pass either. It refuses when the site already runs the shipped version. Connector 1.0.x cannot update itself: a person uploads the new zip once in wp-admin (put it on Needs you with the download link from check-client-site), after that this tool works. Run this before parking a task on Needs you because the Connector lacks an ability. op rollback restores the Connector backup that update made (backupId is in the update result), if the site misbehaves. Check the live site afterwards with check-client-site and check-meta.",
    parametersSchema: schema(["siteId", "op", "reason"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["update", "rollback"], "update installs the shipped Connector version; rollback restores the backup an update made."),
      backupId: text("rollback: the backup to restore (from the update result or wp-log)."),
      reason: text("One line on why (kept in the site's log)."),
    }),
  },
  {
    name: "wp-schema",
    displayName: "WordPress: schema",
    description:
      "Read (op get) or add, replace or remove (op set) JSON-LD pieces on a page or the whole site. Pieces join the SEO plugin's schema graph, so there is one graph, not two. Use stable ids (localbusiness, faq-home). Validate the live page with validate-schema afterwards.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["get", "set"], "get reads, set changes."),
      url: text("The page (full or site-relative URL)."),
      postId: int("The WordPress post or page id, instead of url.", { minimum: 1 }),
      site: bool("true for site-wide pieces (Organization, LocalBusiness) instead of one page."),
      id: text("set: the piece's id, lowercase letters, digits and dashes."),
      piece: bag("set: one JSON-LD object with @type (no @context), under 20 KB."),
      remove: bool("set: true removes the piece with this id."),
      reason: text("Required for set: one line on why."),
    }),
  },
  {
    name: "wp-redirects",
    displayName: "WordPress: redirects",
    description: "List, add or change (op set) and remove (op delete) redirects on the site. 301 for moved pages, 410 for pages gone for good. Refuses loops. Never redirect a page with traffic without saying so in the reason.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["list", "set", "delete"], "list, set or delete."),
      from: text("The old path, e.g. /old-page."),
      to: text("Where it goes: a path or full URL (not needed for 410)."),
      code: { type: "integer", enum: [301, 302, 307, 308, 410], description: "HTTP code (301 by default on the site)." } as JsonSchema,
      reason: text("Required for set and delete."),
    }),
  },
  {
    name: "wp-robots",
    displayName: "WordPress: robots.txt",
    description: "Read (op get) robots.txt and whether search engines are allowed, or (op set) add extra robots.txt lines and switch search engines on. It never blocks the whole site and never switches search engines off.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["get", "set"], "get reads, set changes."),
      extraLines: text("set: the extra lines (they replace the previous extra lines), e.g. Sitemap: https://acme.co.za/sitemap_index.xml"),
      allowSearchEngines: bool("set: true switches search engines on (Settings → Reading)."),
      reason: text("Required for set."),
    }),
  },
  {
    name: "wp-sitemap",
    displayName: "WordPress: sitemap",
    description: "Read (op get) which sitemap the site serves, or (op set) switch the Yoast sitemap on or off and keep posts or pages out of it.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["get", "set"], "get reads, set changes."),
      seoPluginSitemap: bool("set: switch the SEO plugin's sitemap on (true) or off (Yoast only)."),
      excludePostIds: { type: "array", items: { type: "integer" }, description: "set: post and page ids to keep out of the sitemap (replaces the list)." } as JsonSchema,
      reason: text("Required for set."),
    }),
  },
  {
    name: "wp-verify",
    displayName: "WordPress: site verification",
    description:
      "Site verification for search engines, done by the Connector (1.2+): meta tags printed in <head> on every front-end page, and small files served at the site root. Nothing is written to disk, so a read-only web root does not matter and undo needs no cleanup. op get returns the current metaTags and files. op set REPLACES the whole list of each kind you send (metaTags, files): read with op get first and send the existing entries plus your addition; leave a key out to leave that list alone. Allowed meta names: google-site-verification, msvalidate.01, yandex-verification, p:domain_verify, facebook-domain-verification, norton-safeweb-site-verification, baidu-site-verification, naver-site-verification, alexaVerifyID (content 1 to 200 characters of A-Za-z0-9._:=+/-, up to 20 tags). Allowed files (up to 10): the IndexNow key file /<key>.txt (8 to 128 characters of A-Za-z0-9-; content is exactly the key), Google's /google<16 to 32 hex>.html (content: google-site-verification: <file name>) and /BingSiteAuth.xml (content: <?xml version=\"1.0\"?><users><user>HEX</user></users> with 16 to 64 uppercase hex characters). Anything else is refused. Needs a reason. Then verify on the live site: fetch the home page (check-meta) or the file URL and confirm the exact content and a 200, and only then run gsc-verify-site, bing-verify-site or request-indexing (partnersinbiz.seo). If the site answers rest_no_route, it runs a Connector older than 1.2: run wp-connector update first. A real file with the same name on disk wins over the Connector's copy (op get lists diskConflicts). Undo with wp-undo. This is agent work: do not put verification on Needs you.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["get", "set"], "get reads, set changes (replaces the lists you send)."),
      metaTags: {
        type: "array",
        maxItems: 20,
        items: { type: "object", properties: { name: { type: "string", description: "One of the allowed meta names." }, content: { type: "string", description: "The verification code." } }, required: ["name", "content"] },
        description: "set: the full list of verification meta tags, e.g. [{ name: \"msvalidate.01\", content: \"ABC123\" }]. Include the tags already there (from op get).",
      } as JsonSchema,
      files: {
        type: "array",
        maxItems: 10,
        items: { type: "object", properties: { path: { type: "string", description: "Site-root path, e.g. /<key>.txt." }, content: { type: "string", description: "The exact file content." } }, required: ["path", "content"] },
        description: "set: the full list of root files, e.g. [{ path: \"/<key>.txt\", content: \"<key>\" }]. Include the files already there (from op get).",
      } as JsonSchema,
      reason: text("Required for set: one line on why (kept in the site's log)."),
    }),
  },
  {
    name: "wp-plugins",
    displayName: "WordPress: plugins",
    description:
      "List plugins and backups. install and rollback are for people only (they deploy our own plugins with a backup first); you prepare them and put them on Needs you. Off on the site until a person switches it on.",
    parametersSchema: schema(["siteId", "op"], {
      siteId: text("A WordPress site with the Connector."),
      op: oneOf(["list", "backups", "install", "rollback"], "list, backups, install or rollback."),
      zipUrl: text("install: https link to the plugin zip."),
      sha256: text("install: the zip's sha256."),
      slug: text("install: the plugin folder name inside the zip."),
      backupId: text("rollback: the backup to restore (from op backups)."),
      reason: text("Required for install and rollback."),
    }),
  },
  {
    name: "wp-log",
    displayName: "WordPress: Connector log",
    description: "The site's own log of Connector changes (last 200), with before and after values and change ids for wp-undo.",
    parametersSchema: schema(["siteId"], { siteId: text("A WordPress site with the Connector."), limit: int("How many (default 50).", { minimum: 1, maximum: 200 }) }),
  },
  {
    name: "wp-undo",
    displayName: "WordPress: undo a change",
    description: "Revert one Connector change (SEO fields including terms, archives and share images, schema, redirects, robots, sitemap, verification tags and files, featured images, alt text, page copy edits, new drafts and publishes) to its before state. Not undoable: wp-media sideload (uploads stay), plugin installs (wp-plugins rollback) and Connector updates (wp-connector rollback).",
    parametersSchema: schema(["siteId", "changeId", "reason"], {
      siteId: text("A WordPress site with the Connector."),
      changeId: text("The change id (from the change's result, wp-log or site-changes)."),
      reason: text("Why it is reverted."),
    }),
  },
  {
    name: "list-client-projects",
    displayName: "List client projects",
    description: "The Paperclip projects (code folders) that belong to a client, and the company's projects that belong to no client yet (suggested ones match the client's name).",
    parametersSchema: schema(["client"], { client: P.client }),
  },
  {
    name: "link-client-project",
    displayName: "Link project to client",
    description: "Make a Paperclip project part of a client, so it shows on the client's CRM page. A project belongs to one client.",
    parametersSchema: schema(["client", "projectId"], { client: P.client, projectId: text("The project (from list-client-projects).") }),
  },
  {
    name: "contact-graph",
    displayName: "Contact graph",
    description: "A contact's companies, deals and recent activity in one small view. get-contact gives more.",
    parametersSchema: schema(["contactId"], { contactId: P.contactId }),
  },
  {
    name: "field-history",
    displayName: "Field history",
    description: "The recorded field changes and refused writes for a contact, company or deal. Use it to explain why a value is what it is.",
    parametersSchema: schema(["recordType", "recordId"], { recordType: P.recordType, recordId: P.recordId }),
  },
  {
    name: "pipeline-forecast",
    displayName: "Pipeline forecast",
    description: "Open pipeline value by stage with a weighted forecast (each stage's win chance). An estimate, not a promise.",
    parametersSchema: schema([], {}),
  },
  {
    name: "export-contacts",
    displayName: "Export contacts",
    description: "The contacts you can see as CSV: id, ref, name, emails, phones, lifecycle, email status, tags and company refs.",
    parametersSchema: schema([], {}),
  },

  // -------------------------------------------------------------------------
  // Companies and contacts
  // -------------------------------------------------------------------------
  {
    name: "create-company",
    displayName: "Create company",
    description:
      "Create a CRM company: a client account, not the Paperclip workspace. Search with find-records first. Returns its id, ref company:<id> and link. Then link its people with link-contact.",
    parametersSchema: schema(["name"], {
      name: P.name,
      domain: P.domain,
      billingEmail: P.billingEmail,
      phone: P.phone,
      address: P.address,
      vatNumber: P.vatNumber,
      registrationNumber: P.registrationNumber,
      lifecycle: P.lifecycle,
      currency: P.currency,
      tags: P.tagsNew,
      custom: P.custom,
    }),
  },
  {
    name: "update-company",
    displayName: "Update company",
    description:
      "Change a CRM company. Only the fields you send change. A field a person owns that already has a value is refused and noted. Setting lifecycle churned stops its people's sequences.",
    parametersSchema: schema(["companyRecordId"], {
      companyRecordId: P.companyRecordId,
      name: P.name,
      domain: P.domain,
      billingEmail: P.billingEmail,
      phone: P.phone,
      address: P.address,
      vatNumber: P.vatNumber,
      registrationNumber: P.registrationNumber,
      lifecycle: P.lifecycle,
      currency: P.currency,
      tags: P.tagsReplace,
      custom: P.custom,
    }),
  },
  {
    name: "create-contact",
    displayName: "Create contact",
    description: "Create a person. Search with find-records first. Returns its id, ref contact:<id> and link. Link them to their company with link-contact.",
    parametersSchema: schema(["name"], {
      name: text("Full name, e.g. Thandi Mokoena."),
      emails: P.emails,
      phones: P.phones,
      lifecycle: P.lifecycle,
      tags: P.tagsNew,
      nextActionKind: P.nextActionKind,
      nextActionDueAt: P.nextActionDueAt,
      custom: P.custom,
    }),
  },
  {
    name: "update-contact",
    displayName: "Update contact",
    description:
      "Change a contact. Only the fields you send change. A field a person owns that already has a value is refused and noted. Setting lifecycle churned stops their sequences. Opt-outs go through set-email-status.",
    parametersSchema: schema(["contactId"], {
      contactId: P.contactId,
      name: text("Full name."),
      emails: textList("The full email list: it replaces the current one."),
      phones: textList("The full phone list: it replaces the current one."),
      lifecycle: P.lifecycle,
      tags: P.tagsReplace,
      nextActionKind: P.nextActionKind,
      nextActionDueAt: P.nextActionDueAt,
      custom: P.custom,
    }),
  },
  {
    name: "link-contact",
    displayName: "Link contact to company",
    description: "Link a contact to a CRM company (the people at a client). A contact may work for several companies.",
    parametersSchema: schema(["contactId", "companyRecordId"], {
      contactId: P.contactId,
      companyRecordId: P.companyRecordId,
      roleLabel: text("Their role there, e.g. owner, buyer or staff (the default)."),
    }),
  },
  {
    name: "set-email-status",
    displayName: "Set email status",
    description:
      "Record that a contact must not get marketing email: they asked to stop (unsubscribed, by any channel) or the address bounced. Stops their sequences and tells Campaigns and the Mailbox. Only a person can allow email again.",
    parametersSchema: schema(["contactId", "status"], {
      contactId: P.contactId,
      status: oneOf(["unsubscribed", "bounced"], "unsubscribed: they asked to stop. bounced: the address does not work."),
      note: text("Why, in a few words, e.g. asked on a call on 3 Oct."),
    }),
  },
  {
    name: "log-activity",
    displayName: "Log activity",
    description: "Add an entry to the timeline of a contact, company or deal: calls, meetings, what the client said or decided.",
    parametersSchema: schema(["recordType", "recordId", "body"], {
      recordType: P.recordType,
      recordId: P.recordId,
      kind: oneOf(ACTIVITY_KINDS, "What it was (default note)."),
      body: text("What happened, in plain words. Facts only."),
      issueId: text("The Paperclip issue this belongs to, if any."),
    }),
  },
  {
    name: "share-record",
    displayName: "Share record",
    description: "Let one board user or agent see a record they cannot see yet. Partner companies get access through the Partners module, not this tool.",
    parametersSchema: schema(["recordType", "recordId", "principalType", "principalId"], {
      recordType: P.recordType,
      recordId: P.recordId,
      principalType: oneOf(["user", "agent"], "Who gets access: a board user or an agent."),
      principalId: text("That user's or agent's id."),
    }),
  },
  {
    name: "define-field",
    displayName: "Define field",
    description: "Declare an extra field for contacts, companies or deals. Its values then go in custom.",
    parametersSchema: schema(["recordType", "fieldKey", "label"], {
      recordType: P.recordType,
      fieldKey: text("Lowercase key: letters, digits and underscores, starting with a letter, e.g. vat_number."),
      label: text("The name people see, e.g. VAT number."),
      fieldType: oneOf(FIELD_TYPES, "Kind of value (default text)."),
    }),
  },
  {
    name: "score-contact",
    displayName: "Score contact",
    description:
      "A 0-100 rule score for a contact with a plain breakdown, plus (with smart sorting on) fit, intent and urgency levels 0-3 stored on the contact. A hint for who to follow up first, never a reason to change a person's fields.",
    parametersSchema: schema(["contactId"], { contactId: P.contactId }),
  },
  {
    name: "find-duplicates",
    displayName: "Find duplicate contacts",
    description: "Contacts that share an email address (exact duplicates): merge them with merge-contacts, keeping the oldest as the primary. Likely but uncertain duplicates (similar names) go to a person first.",
    parametersSchema: schema([], {}),
  },
  {
    name: "merge-contacts",
    displayName: "Merge contacts",
    description:
      "Fold a duplicate contact into the primary: links, deals, activities, facts and sequences move, then the duplicate is deleted. Use it for contacts that share an email; ask a person first when they only look alike.",
    parametersSchema: schema(["primaryContactId", "duplicateContactId"], {
      primaryContactId: text("The contact to keep."),
      duplicateContactId: text("The contact to fold in and delete."),
    }),
  },
  {
    name: "bulk-tag-contacts",
    displayName: "Bulk tag contacts",
    description: "Add or remove tags on many contacts at once.",
    parametersSchema: schema(["contactIds", "tags", "action"], {
      contactIds: textList("The contact ids."),
      tags: textList("The tags to add or remove."),
      action: oneOf(["add", "remove"], "add or remove the tags."),
    }),
  },
  {
    name: "import-contacts",
    displayName: "Import contacts",
    description: "Create contacts from CSV text. Only import people who agreed to hear from us or are existing clients (POPIA). Search first to avoid duplicates.",
    parametersSchema: schema(["csv"], {
      csv: text("CSV with a header row: name, emails, phones, lifecycle, tags (only name is required). Separate several values with ;."),
    }),
  },
  {
    name: "create-saved-view",
    displayName: "Create saved view",
    description: "Save a named filter view for contacts, companies or deals so a person can open it later.",
    parametersSchema: schema(["name", "recordType"], {
      name: text("The view's name, e.g. Hot leads."),
      recordType: P.recordType,
      filters: bag("The filter values to save, e.g. { lifecycle: customer, tag: retainer }."),
    }),
  },
  {
    name: "list-saved-views",
    displayName: "List saved views",
    description: "The saved filter views for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "delete-saved-view",
    displayName: "Delete saved view",
    description: "Delete a saved filter view.",
    parametersSchema: schema(["viewId"], { viewId: text("The view id (from list-saved-views).") }),
  },

  // -------------------------------------------------------------------------
  // Deals and products
  // -------------------------------------------------------------------------
  {
    name: "create-deal",
    displayName: "Create deal",
    description:
      "Create a deal (a sale in progress) in the first open stage for a client. Link it with companyRecordId and/or contactId. Returns its id. Put its id on the Billing quote so acceptance closes it.",
    parametersSchema: schema(["title"], {
      title: text("What is being sold, e.g. Website rebuild."),
      amountMinor: P.amountMinor,
      currency: P.currency,
      companyRecordId: P.companyRecordId,
      contactId: P.contactId,
      nextActionKind: P.nextActionKind,
      nextActionDueAt: P.nextActionDueAt,
    }),
  },
  {
    name: "move-deal",
    displayName: "Move deal",
    description:
      "Move a deal to another stage. Won makes the client a customer, logs the win and tells Billing and the Cockpit (a first win starts onboarding). Won or lost stops the contact's sequences.",
    parametersSchema: schema(["dealId", "stageId"], {
      dealId: P.dealId,
      stageId: text("Stage id from list-stages. A stage name (e.g. Proposal) or the word won or lost also works."),
      quoteId: text("Only with stageId won: the accepted quote this deal closes (from a pick-the-deal hand-off). The deal records it."),
    }),
  },
  {
    name: "update-deal",
    displayName: "Update deal",
    description:
      "Fix a deal: its title, value or currency, who it is for (companyRecordId and/or contactId; an empty string unlinks), or its stage (a move, like move-deal). Send only what changes. A field a person locked keeps its value. A deal needs its client before Billing can quote it.",
    parametersSchema: schema(["dealId"], {
      dealId: P.dealId,
      title: text("What is being sold, e.g. Website rebuild."),
      amountMinor: P.amountMinor,
      currency: P.currency,
      companyRecordId: text("The CRM company this deal is for (company:<id> also works). An empty string unlinks it."),
      contactId: text("The CRM contact this deal is with (contact:<id> also works). An empty string unlinks it."),
      stageId: text("Move to this stage: id from list-stages, a stage name, or won or lost. Won makes the client a customer and tells Billing."),
    }),
  },
  {
    name: "create-product",
    displayName: "Create product",
    description: "Add a product or service to the catalog, to itemise deals.",
    parametersSchema: schema(["name"], {
      name: text("Product or service name, e.g. SEO retainer."),
      description: text("One line on what it includes."),
      unitAmountMinor: int("Price per unit in minor units: 150000 is R 1,500.00.", { minimum: 0 }),
      currency: P.currency,
    }),
  },
  {
    name: "update-product",
    displayName: "Update product",
    description: "Change a product in the catalog. Only the fields you send change.",
    parametersSchema: schema(["productId"], {
      productId: P.productId,
      name: text("Product or service name."),
      description: text("One line on what it includes."),
      unitAmountMinor: int("Price per unit in minor units.", { minimum: 0 }),
      currency: P.currency,
      isActive: bool("false hides it from new deals."),
    }),
  },
  {
    name: "add-deal-product",
    displayName: "Add deal product",
    description: "Add a product line to a deal to itemise what it sells.",
    parametersSchema: schema(["dealId", "productId"], {
      dealId: P.dealId,
      productId: P.productId,
      quantity: int("Units, a whole number of at least 1 (default 1).", { minimum: 1 }),
      unitAmountMinor: int("Price per unit in minor units (default: the product's price).", { minimum: 0 }),
    }),
  },
  {
    name: "list-deal-products",
    displayName: "List deal products",
    description: "The product lines on a deal.",
    parametersSchema: schema(["dealId"], { dealId: P.dealId }),
  },

  // -------------------------------------------------------------------------
  // Sequences
  // -------------------------------------------------------------------------
  {
    name: "create-sequence",
    displayName: "Create sequence",
    description:
      "Create a follow-up sequence and its steps. delivery issue (default): each due step opens an issue to do by hand. delivery email: the Mailbox sends each step as marketing email once a person approved the sequence. Every email step must say who we are and how to opt out.",
    parametersSchema: schema(["name"], {
      name: text("The sequence name, e.g. New lead follow-up."),
      completionMode: oneOf(COMPLETION_MODES, "How a step issue completes: manual (mark it done when the step is done) or sent (mark it done only once the message really went out). Email delivery ignores it."),
      delivery: oneOf(SEQUENCE_DELIVERIES, "issue (default) or email (needs a person's approval once)."),
      steps: {
        type: "array",
        description: "The steps in order. Without steps the sequence gets one Reach out step.",
        items: {
          type: "object",
          properties: {
            position: int("Order, starting at 1 (default: the list order).", { minimum: 1 }),
            delayMinutes: int("Minutes to wait after the previous step (after enrolling, for step 1). 1440 is one day.", { minimum: 0 }),
            title: text("Step name; for email delivery the subject line. Tokens work here too."),
            body: text("What to do or say; for email the text. Tokens: {{first_name}}, {{last_name}}, {{name}}, {{company}}, {{email}}, with a fallback like {{first_name|there}}."),
          },
          required: ["title"],
        },
      },
    }),
  },
  {
    name: "set-sequence-delivery",
    displayName: "Set sequence delivery",
    description:
      "Choose how a sequence's due steps go out: issue (done by hand) or email (the Mailbox sends it). The first switch to email opens an approval issue for a person; nothing is emailed until they mark it done. You cannot approve it.",
    parametersSchema: schema(["sequenceId", "delivery"], {
      sequenceId: P.sequenceId,
      delivery: oneOf(SEQUENCE_DELIVERIES, "issue or email."),
    }),
  },
  {
    name: "enroll-contact",
    displayName: "Enroll contact",
    description:
      "Start a sequence for a contact. One running enrollment per contact per sequence. Email sequences refuse contacts who opted out or bounced. Never enroll a client's leads or people without consent.",
    parametersSchema: schema(["sequenceId", "contactId"], {
      sequenceId: P.sequenceId,
      contactId: P.contactId,
    }),
  },
  ...CARE_TOOLS,
  ...ESIGN_TOOLS,
  ...GROWTH_TOOLS,
];
