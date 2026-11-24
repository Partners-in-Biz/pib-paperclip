import type { PersonalNoteColor } from "@paperclipai/shared";

export interface NoteColorStyle {
  label: string;
  dot: string;
  bar: string;
  tint: string;
  ring: string;
}

export const NOTE_COLOR_STYLES: Record<PersonalNoteColor, NoteColorStyle> = {
  default: {
    label: "Neutral",
    dot: "bg-muted-foreground/45",
    bar: "bg-border",
    tint: "bg-card",
    ring: "ring-border",
  },
  amber: {
    label: "Amber",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
    tint: "bg-amber-500/[0.06]",
    ring: "ring-amber-500/40",
  },
  blue: {
    label: "Blue",
    dot: "bg-blue-500",
    bar: "bg-blue-500",
    tint: "bg-blue-500/[0.06]",
    ring: "ring-blue-500/40",
  },
  emerald: {
    label: "Emerald",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
    tint: "bg-emerald-500/[0.06]",
    ring: "ring-emerald-500/40",
  },
  rose: {
    label: "Rose",
    dot: "bg-rose-500",
    bar: "bg-rose-500",
    tint: "bg-rose-500/[0.06]",
    ring: "ring-rose-500/40",
  },
  violet: {
    label: "Violet",
    dot: "bg-violet-500",
    bar: "bg-violet-500",
    tint: "bg-violet-500/[0.06]",
    ring: "ring-violet-500/40",
  },
};
