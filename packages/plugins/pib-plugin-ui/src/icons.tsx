/**
 * Icons: lucide-react (the same set and major version as the Paperclip host).
 * Import named icons only, so the bundle keeps just the ones a page uses.
 */
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Calculator,
  Gauge,
  Handshake,
  Inbox,
  ListChecks,
  Receipt,
  Search,
  Send,
  Share2,
  Users,
  Wallet,
} from "lucide-react";
import { usePibBaseStyles } from "./base.js";
import { tone, type AccentColors, type ModuleKey, type ToneColors, type ToneInput } from "./tokens.js";

export type { LucideIcon, LucideProps } from "lucide-react";

// A curated set, re-exported so plugins do not need their own lucide-react dependency.
// Unused ones are dropped by the bundler (named ESM exports, `sideEffects: false`).
export {
  Activity,
  ArrowDown,
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Banknote,
  Blocks,
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  Calculator,
  Calendar,
  CalendarCheck,
  ChartColumn,
  ChartLine,
  ChartPie,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
  CircleX,
  Clock,
  Coins,
  Contact,
  CreditCard,
  Database,
  DollarSign,
  ExternalLink,
  Eye,
  FileText,
  Flame,
  Funnel,
  Gauge,
  Gavel,
  HandCoins,
  Handshake,
  HeartPulse,
  Hourglass,
  Link,
  Trophy,
  FlaskConical,
  Inbox,
  Info,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Mail,
  MailCheck,
  Megaphone,
  MessageCircleQuestionMark,
  MessageSquare,
  Minus,
  Newspaper,
  Package,
  PackageCheck,
  PiggyBank,
  Plug,
  Radio,
  Receipt,
  RefreshCw,
  Rocket,
  Scale,
  Search,
  Send,
  Server,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Stamp,
  Sun,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Truck,
  UserRound,
  Users,
  Wallet,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";

/** The icon each module uses for its page header, sidebar and badges. */
export const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  crm: Users,
  social: Share2,
  seo: Search,
  campaigns: Send,
  billing: Receipt,
  accounting: Calculator,
  payroll: Wallet,
  mailbox: Inbox,
  partners: Handshake,
  cockpit: Gauge,
  setup: ListChecks,
};

/** Fallback for anything without a module (e.g. a generic "Guide"). */
export const DEFAULT_ICON: LucideIcon = BookOpen;

/**
 * A lucide icon at a given size and colour. Decorative (hidden from screen
 * readers) unless you give it a `label`.
 */
export function Icon({ icon: Glyph, size = 16, tone: t, color, label, strokeWidth = 2, style }: {
  icon: LucideIcon;
  size?: number;
  tone?: ToneInput;
  /** Any CSS colour; wins over `tone`. */
  color?: string;
  label?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  const stroke = color ?? (t ? tone(t).solid : "currentColor");
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      color={stroke}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
      style={{ flexShrink: 0, display: "block", ...style }}
    />
  );
}

const BADGE_SIZE = { xs: [22, 12, 6], sm: [28, 15, 8], md: [36, 18, 10], lg: [44, 22, 12] } as const;

/**
 * An icon in a soft-tinted rounded square — the page header, section cards,
 * KPI cards and empty states use it. Tint it with a status `tone` or a module
 * `accent` (from `moduleAccent()` / `useAccent()`).
 */
export function IconBadge({ icon, tone: t, accent, size = "md", label, style }: {
  icon: LucideIcon;
  tone?: ToneInput;
  accent?: AccentColors | ToneColors | null;
  size?: keyof typeof BADGE_SIZE;
  label?: string;
  style?: CSSProperties;
}) {
  usePibBaseStyles();
  const colors = accent ?? tone(t ?? "neutral");
  const [box, glyph, radius] = BADGE_SIZE[size];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        width: box,
        height: box,
        borderRadius: radius,
        display: "inline-grid",
        placeItems: "center",
        flexShrink: 0,
        background: colors.soft,
        color: colors.fg,
        boxShadow: `inset 0 0 0 1px ${colors.border}`,
        ...style,
      }}
    >
      <Icon icon={icon} size={glyph} color={colors.solid} />
    </span>
  );
}
