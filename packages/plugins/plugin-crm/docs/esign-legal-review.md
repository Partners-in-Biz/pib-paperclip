# E-sign acceptance: what a lawyer should review

Template version: **2026-10-v1** (`src/esign-templates.ts`; the version is in every document made from a template).

This is a checklist for a South African lawyer, written by the people who built the feature. **It is not legal advice, and nothing in the product claims the templates or the signature have been legally checked.** Until a lawyer has read these, e-sign stays off for every client except the canary, and a person turns it on per client (the Agreements card on the client page; the person says whether the templates were reviewed).

## What the product does (so you review the right thing)

A client is sent a private link in an email that a person approved. The page shows the document text, its SHA-256 fingerprint and a consent box. The client types their full name, ticks the box and presses Sign. The system records: the typed name, the time, a keyed (not reversible) hash of the network address, the browser identification, the SHA-256 of the exact text, and the SHA-256 of the exact consent wording. Every step (created, sent, opened, consent, signed, reminders, expiry) is a row in a hash-chained audit trail; the hash of the signature row is printed on the signed copy. The signed copy (the text, then the evidence) goes to the client by an approved email and is kept on our side.

The signature is **a basic electronic signature: a typed name given with explicit consent. It is not an advanced electronic signature**, and the product says so on the page and on the copy.

## Please review

### 1. The three templates
Read the text of each (`sign-templates` with `includeText true`, or `src/esign-templates.ts`).
- **Proposal:** does accepting it create a binding offer-and-acceptance, and is the wording about price, assumptions and acceptance adequate? Is "signing below means ... asks us to start" the right trigger?
- **Quote:** the totals, the VAT line (we are not VAT registered; the template only adds VAT when a VAT percentage is given), validity, payment terms.
- **Simple service agreement:** services, fees and payment, month-to-month term with notice, confidentiality, the POPIA operator clause, ownership and licensing, the liability cap (three months of fees), governing law and the electronic-signature sentence. Is each clause enforceable as written and fair to a small-business client (consumer-protection and unfair-terms rules)? What is missing for the services we sell (SEO, social media, websites, bookkeeping, payroll)?

### 2. The consent wording
"I have read "<title>" from <company> and I agree to it. I understand that typing my name below is my electronic signature." Is this enough to show informed consent to sign electronically? Should it also record consent to do business by electronic means?

### 3. Which documents this must NOT be used for
List the kinds of document that need an ink signature, a witness, a notary or an advanced electronic signature (for example sales of land, long leases, wills, suretyships, anything the law says must be signed in a particular way). The product cannot tell; the owner will tell the agents.

### 4. Evidence and retention
- Is the record sufficient to prove who signed and what was signed if a client disputes it? Is a keyed hash of the address enough, or should the address itself be kept (the product deliberately does not)?
- How long must signed agreements, and the audit trail, be kept? Our default: kept until the client's records are deleted by a person; a signed agreement stays even when a person asks to be erased (it is the evidence of the agreement), and the erasure says so.
- Is the typed name plus an emailed private link adequate identification for the kinds of agreement we use it for, or do some need a second factor (a code by SMS, for instance)?

### 5. POPIA for the signer
The signer's name, a hash of their address and their browser identification are personal information. Is the lawful basis (contract) right? What should the privacy notice for signers say? Is a "Privacy policy" link needed on the signing page? Two more places hold some of it, and the notice should not deny them: the hosting server's own request log keeps every signing-page request (the signer's real IP address, browser, and the private token) for up to 3 days before ops purge it, and the signing email (which carries the private link) stays in the Mailbox's own record of what it sent.

### 6. The emails
The signing email, the reminders (at most two, three days apart) and the signed-copy email: wording, tone, anything that would be a problem (for example a reminder that reads as pressure).

### 7. What we say in the product
The page, the signed copy and the tools use the phrases "basic electronic signature" and "not an advanced electronic signature". Are they accurate, and is there anything we say that we should not?

## After the review
- Change the wording only together with `TEMPLATE_VERSION` (a document keeps the version it was made from; documents already sent never change).
- The owner then presses **Turn on e-sign** on a client's page and says the templates were reviewed (stored with who and when). The owner can also turn it on without a review: that is the owner's decision, recorded as such, and the documents say nothing about it to the client.
