/**
 * Resend's REST API as documented, in memory: domains (add, get, list, verify), emails and batches with idempotency keys, the error
 * answers the adapter has to understand, and the domain a message is sent from having to be verified. Used behind the host's
 * `ctx.http.fetch` so the worker, the adapter and the sender are tested together without a network.
 */
import { API_KEY } from "./esp.js";

interface Domain {
  id: string;
  name: string;
  status: string;
  region: string;
  records: Array<Record<string, unknown>>;
}

export interface SentEmail {
  id: string;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
  batch: boolean;
}

export class FakeResend {
  domains = new Map<string, Domain>();
  emails: SentEmail[] = [];
  requests: Array<{ method: string; path: string }> = [];
  /** The owner has added the DNS records: a verify makes domains verified. */
  dnsAdded = false;
  /** Answers handed out to the next requests instead of the real answer, oldest first. */
  errors: Array<{ status: number; body: unknown; headers?: Record<string, string>; accepted?: boolean }> = [];
  private byKey = new Map<string, string>();
  private seq = 0;

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private recordsFor(_name: string, status: string): Array<Record<string, unknown>> {
    return [
      { record: "SPF", name: "send", value: "feedback-smtp.eu-west-1.amazonses.com", type: "MX", ttl: "Auto", status, priority: 10 },
      { record: "SPF", name: "send", value: '"v=spf1 include:amazonses.com ~all"', type: "TXT", ttl: "Auto", status },
      { record: "DKIM", name: "resend._domainkey", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmql4cTGP5v9DJUqAC1HXLqqxXVXyOZhbLzoPFOSTqiSnSmprmP0fpv2Ql5oR3BG9zMDW+pNKQKZZYZP0V7p8ATEeB3Bp3MvvQ4vzpnB+RUCTMHNHdlSLAw/b5GZrRLwwIDAQAB", type: "TXT", ttl: "Auto", status },
    ];
  }

  /** The domain's DNS is in place at the provider. */
  verify(name: string): void {
    const domain = this.domains.get(name);
    if (!domain) return;
    domain.status = "verified";
    domain.records = domain.records.map((record) => ({ ...record, status: "verified" }));
  }

  handle = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const target = new URL(url);
    const method = init?.method ?? "GET";
    const path = target.pathname;
    this.requests.push({ method, path });
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (headers.authorization !== `Bearer ${API_KEY}`) return this.json(401, { statusCode: 401, name: "missing_api_key", message: "Missing API key in the authorization header." });
    const scripted = this.errors.shift();
    if (scripted && !scripted.accepted) return this.json(scripted.status, scripted.body, scripted.headers);
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;

    if (method === "POST" && path === "/domains") {
      const name = String((body as { name: string }).name).toLowerCase();
      if (this.domains.has(name)) return this.json(403, { statusCode: 403, name: "validation_error", message: `The ${name} domain has been registered already.` });
      this.seq += 1;
      const domain: Domain = { id: `d0000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`, name, status: "not_started", region: (body as { region?: string }).region ?? "us-east-1", records: this.recordsFor(name, "not_started") };
      this.domains.set(name, domain);
      return this.json(201, { object: "domain", ...domain });
    }
    if (method === "GET" && path === "/domains") {
      return this.json(200, { object: "list", has_more: false, data: [...this.domains.values()].map(({ records: _records, ...rest }) => rest) });
    }
    const domainMatch = /^\/domains\/([^/]+)(\/verify)?$/.exec(path);
    if (domainMatch) {
      const domain = [...this.domains.values()].find((d) => d.id === decodeURIComponent(domainMatch[1]!));
      if (!domain) return this.json(404, { statusCode: 404, name: "not_found", message: "Domain not found" });
      if (method === "POST" && domainMatch[2]) {
        if (this.dnsAdded) this.verify(domain.name);
        else {
          domain.status = "pending";
          domain.records = domain.records.map((record) => ({ ...record, status: "pending" }));
        }
        return this.json(200, { object: "domain", id: domain.id });
      }
      if (method === "GET") {
        // Resend also looks at a pending domain's DNS by itself.
        if (this.dnsAdded && domain.status === "pending") this.verify(domain.name);
        return this.json(200, { object: "domain", ...domain });
      }
    }
    if (method === "POST" && (path === "/emails" || path === "/emails/batch")) {
      const batch = path === "/emails/batch";
      const items = (batch ? body : [body]) as Array<Record<string, unknown>>;
      const key = headers["idempotency-key"] ?? null;
      // A repeat of the same key gets the first answer, never a second message.
      if (key && this.byKey.has(key)) {
        const first = this.byKey.get(key)!;
        return this.json(200, batch ? { data: first.split(",").map((id) => ({ id })) } : { id: first });
      }
      for (const item of items) {
        const from = String(item.from ?? "");
        const domain = (/<([^<>]+)>/.exec(from)?.[1] ?? from).split("@")[1]?.toLowerCase() ?? "";
        const known = this.domains.get(domain);
        if (!known || known.status !== "verified") return this.json(403, { statusCode: 403, name: "validation_error", message: `The ${domain} domain is not verified. Please, add and verify your domain.` });
      }
      const ids = items.map((item) => {
        this.seq += 1;
        const id = `email-${String(this.seq).padStart(4, "0")}`;
        this.emails.push({ id, body: item, idempotencyKey: key, batch });
        return id;
      });
      if (key) this.byKey.set(key, ids.join(","));
      // The provider kept the message(s) but the answer is lost.
      if (scripted?.accepted) return this.json(scripted.status, scripted.body, scripted.headers);
      return this.json(200, batch ? { data: ids.map((id) => ({ id })) } : { id: ids[0] });
    }
    return this.json(404, { statusCode: 404, name: "not_found", message: "The requested endpoint does not exist." });
  };
}
