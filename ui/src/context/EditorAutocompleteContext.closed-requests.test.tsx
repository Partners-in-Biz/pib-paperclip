// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { EditorAutocompleteProvider, useEditorAutocomplete, type SlashCommandOption } from "./EditorAutocompleteContext";

// AC-G10 (PAR-13264): the `/` autocomplete sends no `skills` or `routines`
// request for a restricted member under `enforce`, and offers neither.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[],
  skills: vi.fn(async () => [{ id: "skill-1", key: "k", name: "Deploy", slug: "deploy", description: null }]),
  routines: vi.fn(async () => [{ id: "routine-1", title: "Nightly", status: "active" }]),
}));

vi.mock("./CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ session: { id: "s", userId: "u" }, user: null, memberRestrictions: api.restrictions }) } }));
vi.mock("../api/companySkills", () => ({ companySkillsApi: { list: api.skills } }));
vi.mock("../api/routines", () => ({ routinesApi: { list: api.routines } }));

const ENFORCED = { companyId: "company-1", restricted: true, mode: "enforce" as const };

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let options: SlashCommandOption[] = [];

function Probe() {
  options = useEditorAutocomplete().slashCommands;
  return null;
}

async function renderProvider(entry: SessionMemberRestriction | null) {
  api.restrictions = entry ? [entry] : [];
  await act(async () => {
    root.render(<QueryClientProvider client={client}><EditorAutocompleteProvider><Probe /></EditorAutocompleteProvider></QueryClientProvider>);
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  options = [];
  api.skills.mockClear();
  api.routines.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("EditorAutocompleteProvider", () => {
  it("R under enforce: no skills or routines request, no skill or routine option", async () => {
    await renderProvider(ENFORCED);
    expect(api.skills).not.toHaveBeenCalled();
    expect(api.routines).not.toHaveBeenCalled();
    expect(options).toEqual([]);
  });

  it.each([
    ["the owner", null],
    ["R under report", { ...ENFORCED, mode: "report" as const }],
  ])("%s: both lists are requested and offered", async (_who, entry) => {
    await renderProvider(entry);
    expect(api.skills).toHaveBeenCalledWith("company-1");
    expect(api.routines).toHaveBeenCalledWith("company-1");
    expect(options.map((option) => option.id)).toEqual(["skill:skill-1", "routine:routine-1"]);
  });
});
