/**
 * Agent tools of the Daily Paper (exposed as `partnersinbiz.cockpit:<name>`):
 * read what an edition must hold, publish it, and change the owner's section
 * list when the owner asks for something new in their report.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { PAPER_LIMITS } from "./paper-model.js";

export const PAPER_TOOL_NAMES = {
  assignment: "paper-assignment",
  publish: "paper-publish",
  settings: "paper-settings",
} as const;

const EDITION: JsonSchema = { type: "string", enum: ["morning", "evening"], description: "Which edition: morning, or evening (the end-of-day report)." };

export const PAPER_TOOLS: PluginToolDeclaration[] = [
  {
    name: PAPER_TOOL_NAMES.assignment,
    displayName: "Paper: what to write",
    description:
      "What the owner wants in one edition of the Daily Paper (their morning or end-of-day report, read on Cockpit → Paper): the sections in order, each with the owner's instruction and its source (company: facts from company-brief and the other tools; web: search the web or X for it), the owner's standing note, the writing rules, the link prefix, and the last two editions so you say what changed and do not repeat them. Call it before you write an edition; the owner edits the list at any time, so never write from memory.",
    parametersSchema: { type: "object", required: [], additionalProperties: false, properties: { edition: { ...EDITION, description: "Which edition: morning, or evening (the end-of-day report). Left out: morning before noon SAST, evening after." } } },
  },
  {
    name: PAPER_TOOL_NAMES.publish,
    displayName: "Paper: publish an edition",
    description:
      "Publishes one edition of the Daily Paper. It shows at once on Cockpit → Paper as a newspaper and stays in the archive, a markdown copy is posted on this week's Daily brief issue (so do not also call post-daily-brief for it), the owner gets one push, and the edition's writing task is closed. Publishing the same day and edition again replaces it. Follow paper-assignment: one section per entry it lists, same ids, same order.",
    parametersSchema: {
      type: "object",
      required: ["edition", "headline", "standfirst", "sections"],
      additionalProperties: false,
      properties: {
        edition: EDITION,
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The day it is for, YYYY-MM-DD in SAST. Leave it out for today." },
        headline: { type: "string", maxLength: PAPER_LIMITS.headline, description: "The one thing the owner must know, 12 words at most." },
        standfirst: { type: "string", maxLength: PAPER_LIMITS.standfirst, description: "Two or three sentences on where the company stands." },
        figures: {
          type: "array",
          maxItems: PAPER_LIMITS.figures,
          description: "The day in numbers: up to 6 the owner tracks.",
          items: {
            type: "object",
            required: ["label", "value"],
            additionalProperties: false,
            properties: {
              label: { type: "string", maxLength: PAPER_LIMITS.figureLabel, description: "e.g. Cash" },
              value: { type: "string", maxLength: PAPER_LIMITS.figureValue, description: "e.g. R33,313" },
              note: { type: "string", maxLength: PAPER_LIMITS.figureNote, description: "A few words of context, e.g. \"oldest 12 days\"." },
              tone: { type: "string", enum: ["ok", "warn", "bad", "neutral"], description: "Only when the number is clearly good or bad." },
            },
          },
        },
        sections: {
          type: "array",
          description: "One entry per section paper-assignment lists, in that order. Leave out a section that has nothing to say.",
          minItems: 1,
          maxItems: PAPER_LIMITS.sections,
          items: {
            type: "object",
            required: ["title", "body"],
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "The section id from paper-assignment." },
              title: { type: "string", maxLength: PAPER_LIMITS.sectionTitle, description: "The section title, as paper-assignment gives it." },
              body: { type: "string", maxLength: PAPER_LIMITS.sectionBody, description: "Markdown: short paragraphs, - lists, **bold**, [links](/PREFIX/issues/PREFIX-12), ### for a sub-head." },
            },
          },
        },
      },
    },
  },
  {
    name: PAPER_TOOL_NAMES.settings,
    displayName: "Paper: sections and editions",
    description:
      "Reads or changes what the Daily Paper holds, when the owner asks for something new in their morning or end-of-day report (\"add tech news to the morning paper\", \"follow @someone on X in the evening one\", \"drop the client desk\"). action get (default) lists both editions with their sections and the ready-made presets. add puts a section at the end (title and instruction in the owner's own words, source web for news or an X account, or a preset id); update changes one by id (title, instruction, source, enabled); remove and move (position, 1 is the top) do what they say; set changes the edition's standing note, its on/off switch, the evening edition's time (HH:MM, SAST) or days (every, weekdays). Only change it on the owner's word, and say what you changed. The change shows from the next edition.",
    parametersSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["get", "add", "update", "remove", "move", "set"], description: "What to do. Left out: get." },
        edition: EDITION,
        id: { type: "string", description: "The section id (update, remove, move)." },
        preset: { type: "string", description: "A preset id from get (add)." },
        title: { type: "string", maxLength: PAPER_LIMITS.sectionTitle, description: "The section title (add, update)." },
        instruction: { type: "string", maxLength: PAPER_LIMITS.instruction, description: "What the owner wants in the section, in their words." },
        source: { type: "string", enum: ["company", "web"], description: "company: facts from the company's own records. web: the writer searches the web or X." },
        enabled: { type: "boolean", description: "update: whether the section is in the paper. set: whether the edition is written at all." },
        position: { type: "integer", minimum: 1, description: "Where to move the section to; 1 is the top (move)." },
        note: { type: "string", maxLength: PAPER_LIMITS.note, description: "The owner's standing note for the edition (set)." },
        time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "When the evening edition is asked for, HH:MM in SAST (set)." },
        days: { type: "string", enum: ["every", "weekdays"], description: "Every day, or Monday to Friday (set)." },
      },
    },
  },
];

export const PAPER_TOOL_NAME_SET: ReadonlySet<string> = new Set(Object.values(PAPER_TOOL_NAMES));
