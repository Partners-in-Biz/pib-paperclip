/**
 * Signal → hypothesis → proposed tasks. Each signal type has one or more
 * candidate hypotheses; the one with the best win rate on this site (the
 * sprint scoreboard) is proposed. Tasks are created for the CURRENT week when
 * the proposal is approved (the old system used week 99, which hid them).
 */
import type { TaskOwner } from "../templates/outrank-90.js";
import { hypothesisScore, type Scoreboard } from "../engine/measure.js";
import type { HealthSignal, Severity } from "./detectors.js";

export interface ProposedTaskSpec {
  title: string;
  taskType: string;
  owner: TaskOwner;
  autopilotEligible: boolean;
  playbook: string;
}

export interface Proposal {
  signal: HealthSignal;
  hypothesis: string;
  hypothesisType: string;
  proposedAction: string;
  tasks: ProposedTaskSpec[];
  targetKeywordIds: string[];
  targetUrl: string | null;
}

type Candidate = Omit<Proposal, "signal" | "targetKeywordIds" | "targetUrl">;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function agentTask(title: string, taskType: string, playbook: string, autopilotEligible = true): ProposedTaskSpec {
  return { title, taskType, owner: "agent", autopilotEligible, playbook };
}

function humanTask(title: string, taskType: string, playbook: string): ProposedTaskSpec {
  return { title, taskType, owner: "human", autopilotEligible: false, playbook };
}

const CANDIDATES: Record<HealthSignal["type"], (s: HealthSignal) => Candidate[]> = {
  stuck_page: (s) => {
    const kw = str(s.evidence.keyword, "the keyword");
    const url = str(s.evidence.url, `the page for "${kw}"`);
    return [
      {
        hypothesis: `The page for "${kw}" lacks depth and FAQ coverage`,
        hypothesisType: "stuck_page:depth-faq",
        proposedAction: `Rewrite ${url} with deeper coverage of "${kw}" and add FAQ schema`,
        tasks: [agentTask(`Rewrite stuck page for "${kw}" — add depth + FAQ`, "page-rewrite", "opt:page-rewrite")],
      },
      {
        hypothesis: `The page for "${kw}" lacks internal authority`,
        hypothesisType: "stuck_page:internal-links",
        proposedAction: `Add 3+ contextual internal links to ${url} from strong pages`,
        tasks: [agentTask(`Add 3 internal links to the "${kw}" page`, "internal-link-add", "opt:internal-link-add")],
      },
    ];
  },
  lost_keyword: (s) => {
    const kw = str(s.evidence.keyword, "the keyword");
    return [
      {
        hypothesis: `The page for "${kw}" lost relevance or links`,
        hypothesisType: "lost_keyword:rebuild",
        proposedAction: `Refresh the "${kw}" page content and add internal links to it`,
        tasks: [
          agentTask(`Refresh the page for "${kw}"`, "page-rewrite", "opt:page-rewrite"),
          agentTask(`Add 3 internal links to the "${kw}" page`, "internal-link-add", "opt:internal-link-add"),
        ],
      },
    ];
  },
  zero_impression_content: (s) => {
    const title = str(s.evidence.title, "the post");
    return [
      {
        hypothesis: `"${title}" is not indexed or targets the wrong keyword`,
        hypothesisType: "zero_impression:relaunch",
        proposedAction: `Diagnose indexing for "${title}", fix it, and request indexing`,
        tasks: [
          agentTask(`Diagnose indexing for "${title}"`, "index-diagnose", "opt:index-diagnose"),
          humanTask(`Request indexing for "${title}" in Search Console`, "gsc-request-index", "opt:gsc-request-index"),
        ],
      },
    ];
  },
  unindexed_page: (s) => {
    const url = str(s.evidence.url, "the page");
    return [
      {
        hypothesis: `${url} is not crawled or not indexable`,
        hypothesisType: "unindexed:fix",
        proposedAction: `Audit crawler access for ${url}, fix it, and request indexing`,
        tasks: [
          agentTask(`Crawler and index check for ${url}`, "index-diagnose", "opt:index-diagnose"),
          humanTask(`Request indexing for ${url}`, "gsc-request-index", "opt:gsc-request-index"),
        ],
      },
    ];
  },
  directory_silence: (s) => {
    const source = str(s.evidence.source, "the directory");
    return [
      {
        hypothesis: `The ${source} submission was lost or silently rejected`,
        hypothesisType: "directory:reattempt",
        proposedAction: `Check ${source} for the listing; follow up or replace it with an alternative directory`,
        tasks: [agentTask(`Follow up on the ${source} listing`, "directory-followup", "opt:directory-followup")],
      },
    ];
  },
  cwv_regression: (s) => {
    const url = str(s.evidence.url, "the page");
    return [
      {
        hypothesis: `Core Web Vitals on ${url} hold the page back`,
        hypothesisType: "cwv:fix",
        proposedAction: `Fix LCP/CLS on ${url} (LCP ${s.evidence.lcpMs ?? "?"} ms, CLS ${s.evidence.cls ?? "?"})`,
        tasks: [agentTask(`Fix Core Web Vitals on ${url}`, "cwv-audit", "opt:cwv-audit", false)],
      },
    ];
  },
  keyword_misalignment: (s) => {
    const kw = str(s.evidence.keyword, "the keyword");
    const url = str(s.evidence.url, `the "${kw}" page`);
    return [
      {
        hypothesis: `${url} shows for "${kw}" but the snippet does not match intent`,
        hypothesisType: "misalignment:retarget",
        proposedAction: `Rewrite the title, H1 and meta description of ${url} around the queries it gets`,
        tasks: [agentTask(`Retarget the title and meta of ${url}`, "page-rewrite", "opt:retarget")],
      },
    ];
  },
  pillar_orphan: (s) => {
    const title = str(s.evidence.title, "the pillar");
    return [
      {
        hypothesis: `Pillar "${title}" lacks supporting links`,
        hypothesisType: "orphan:cluster",
        proposedAction: `Add inbound links to "${title}" from at least 3 related posts`,
        tasks: [agentTask(`Add inbound links to pillar "${title}"`, "internal-link-add", "opt:internal-link-add")],
      },
    ];
  },
  compound_stagnation: () => [
    {
      hypothesis: "Growth has flattened and needs fresh content",
      hypothesisType: "stagnation:refresh",
      proposedAction: "Plan a new pillar and 3 cluster posts on a new keyword theme",
      tasks: [agentTask("Pick a new keyword cluster theme and plan a pillar + 3 posts", "cluster-pick", "opt:cluster-pick")],
    },
  ],
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function proposeHypotheses(signals: HealthSignal[], scoreboard?: Scoreboard | null): Proposal[] {
  const sorted = [...signals].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const out: Proposal[] = [];
  for (const signal of sorted) {
    const candidates = CANDIDATES[signal.type]?.(signal) ?? [];
    if (candidates.length === 0) continue;
    let pick = candidates[0]!;
    let best = hypothesisScore(scoreboard?.[pick.hypothesisType]);
    for (const candidate of candidates.slice(1)) {
      const score = hypothesisScore(scoreboard?.[candidate.hypothesisType]);
      if (score > best) {
        best = score;
        pick = candidate;
      }
    }
    const keywordId = typeof signal.evidence.keywordId === "string" ? signal.evidence.keywordId : null;
    const url = typeof signal.evidence.url === "string" && signal.evidence.url ? signal.evidence.url : null;
    out.push({ ...pick, signal, targetKeywordIds: keywordId ? [keywordId] : [], targetUrl: url });
  }
  return out;
}
