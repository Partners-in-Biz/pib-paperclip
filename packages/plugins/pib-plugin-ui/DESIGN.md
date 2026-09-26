# PiB plugin design system

Everything here is exported from `@partnersinbiz/pib-plugin-ui`. It keeps the
Paperclip look: Inter/system type, 1px `--border` borders, 12–14px radii and
`--card` surfaces. On top of that it adds colour, hierarchy and charts.

Reference pages: **Cockpit** (`plugin-cockpit/src/ui`) and **Setup**
(`plugin-setup/src/ui`). Copy their patterns.

## Rules

1. **Status colour is `tone()`, never `--chart-*`.** In Paperclip the host's
   `--chart-1..5` are greys, so they cannot show status. Never hard-code hex
   colours either.
2. **Every page gets its module accent.** Use `<Page accent="billing">`, or
   `<PageFrame accent="billing">` with your own header. The accent tints the
   header icon, the active tab, single-series charts, the progress bars and
   `tone("accent")`.
3. **Colour means something.**
   - ok = done or healthy.
   - warn = needs watching.
   - bad = broken, overdue, or money at risk.
   - info = running or informational.
   - accent = this module.
   - neutral = no status.
   Do not use colour for decoration.
4. **Mobile first.** Nothing may have a fixed width.
   - Use `fluidColumns(min)` or `repeat(auto-fill, minmax(min(Npx, 100%), 1fr))`.
   - Charts stretch to their container.
   - Tables go inside `ScrollX` on a phone, or switch to cards (see Cockpit
     `AgentCard`).
   - Check pages at 375px, in light and dark.
5. **Name icons one at a time**, e.g. `import { Receipt } from "@partnersinbiz/pib-plugin-ui"`
   (or from `lucide-react`). Then the bundler keeps only the icons a page uses.

## Palette

### Tones

`tone(name)` returns four colours:

| Colour | Use |
|---|---|
| `solid` | dots, bars, icons |
| `soft` | tinted backgrounds |
| `border` | borders on tinted surfaces |
| `fg` | text on a tinted surface |

`tokens.tones` holds the same values.

| Tone | Aliases | Taken from the host |
|---|---|---|
| `ok` | success, done, good | `--status-task-icon-done` (the Run Activity chart's "Succeeded" green) |
| `warn` | warning, pending | `--status-task-todo` (amber) |
| `bad` | error, danger, destructive, blocked, failed | `--status-task-icon-blocked` (red) |
| `info` | running | `--status-task-icon-in_progress` (blue) |
| `neutral` | muted, default | `--muted-foreground` |
| `accent` | primary | the page's module accent |

- The values are CSS custom properties (`--pib-ok`, `--pib-ok-soft`, …).
- `usePibBaseStyles()` injects them on `:root`.
- Dark values sit under the host's `.dark` class on `<html>`.
- Every `tone()` value has a hex fallback, so components also render before the
  styles load (tests, server render).
- Categorical series, for categories rather than statuses: `tokens.series` or
  `seriesColor(i)`, eight colours.
- Empty track of a bar or ring: `tokens.track`.

### Module accents

Get them with `moduleAccent(key)`. You can pass the module key or the plugin
key (`"partnersinbiz.crm"`). It returns `{ solid, soft, border, fg, icon, label }`.

| Module | Accent | Icon |
|---|---|---|
| crm | blue | Users |
| social | rose | Share2 |
| seo | green | Search |
| campaigns | violet | Send |
| billing | emerald | Receipt |
| accounting | teal | Calculator |
| payroll | amber | Wallet |
| mailbox | orange | Inbox |
| partners | cyan | Handshake |
| cockpit | indigo | Gauge |
| setup | sky | ListChecks |

Other theme APIs:

- `PluginThemeProvider accent="…"` gives a subtree an accent. It uses a
  `display: contents` wrapper, so layout does not change.
- `useAccent()` reads the accent in your own components.
- `accentVars(accent)` returns the CSS variables for an accent.

## Components

| Component | Use it for | Notes |
|---|---|---|
| `Page` / `PageFrame` / `PageHeader` | every page | `accent`, `icon`. The header shows the module icon in a tinted badge. `Page messageTone="bad"` shows an error line. |
| `Tabs` | tabs on a page | Tabs can take `icon`, `count` and `countTone`. The active underline uses the accent. |
| `SectionCard` | each block on an overview | `title`, `subtitle`, `icon`, `tone` or `accent`, `strip` (3px top line for attention), `actions`, `footer`. The title is 14px and semibold. |
| `Section` | dense forms and lists | Small uppercase title. It is the older style and is still fine. |
| `KpiCard` | one number | `label`, `value`, `tone`, `delta` (number, or text like `"+12% vs last week"`, shown as ▲/▼), `invert` (lower is better), `deltaTone`, `hint`, `icon` + `iconAccent`, `sparkline`, `link={linkProps(href)}`, `size="sm"`. Lay them out in `fluidColumns(150)`. |
| `StatusDot` | status beside a name | `tone`, `pulse` (live or running), `halo` (traffic-light look), `label` when the dot stands alone. |
| `Pill` / `Badge` | status, kind, counts | `tone`, `variant` (soft, solid or outline), `icon`, `dot`, `size`. |
| `IconBadge` / `Icon` | icons | An icon in a tinted rounded square (`tone` or `accent`), or a bare icon. |
| `ProgressBar` | done/total, budget used | `value` (0–1) or `done`/`total`. `tone="budget"` is ok up to 80%, warn up to 100%, then bad. `budgetTone()` gives the same result. The bar is green when complete. |
| `ProgressRing` | overall completion | `done`/`total` or `value`, a required `label`. You can put content in the middle. |
| `BarChart` with `data` | a series over time, e.g. runs per day | Vertical bars, stacked by `series` (`{ key, label, tone }`). Has tooltips on hover, tap and arrow keys, a legend, and first/middle/last date labels. It works like the host's Run Activity chart. |
| `BarChart` with `items` / `BarList` | ranking categories | The original horizontal bars (API unchanged), now in series colours. |
| `StackedBar` | shares of a whole: tasks by status, AR ageing, health counts | One bar with a legend showing value and %. |
| `DonutChart` | shares with a headline number | `centerValue`, `centerLabel`, legend beside it. |
| `TrendChart` | continuous trends: revenue, clicks, followers | Area with a gradient fill. Multiple `series` (can be `dashed`), hover guide and tooltip. |
| `Sparkline` | the trend inside a KpiCard | Pass `sparkline` to `KpiCard`, or use it on its own. |
| `Timeline` | activity feeds | Items are `{ at, title, detail, meta, tone, icon, link }`. Shows relative times. `limit` adds an "And N more." line. |
| `ChartLegend` | custom charts | |
| `EmptyState` | nothing yet | `icon`, `tone`, `compact`. Tinted with the accent by default. |

Helpers:

- `relativeTime(at, now)`
- `formatDelta`
- `deltaDirection`
- `formatCompact`
- `toneName`
- `moduleKeyOf`

### Accessibility

- Every chart is `role="img"` with a text summary. You can override it with
  `title`, `ariaLabel` or `unit`.
- Bar and trend charts can be focused, and arrow keys move the tooltip.
- A dot or icon that means something needs a `label`. A decorative one stays
  `aria-hidden`.
- Pulses stop when the user has turned on reduced motion.

## Examples

```tsx
import { Page, SectionCard, KpiCard, BarChart, StackedBar, Pill, Receipt, fluidColumns, moduleAccent } from "@partnersinbiz/pib-plugin-ui";

<Page title="Billing" description="…" accent="billing">
  <SectionCard title="Money" icon={Receipt} subtitle="This month">
    <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
      <KpiCard label="Overdue" value="R 12,400" tone="bad" delta="+R 3,100 this week" deltaTone="bad" link={linkProps("/billing?tab=invoices")} />
      <KpiCard label="Collected" value="R 48,900" delta="+6%" sparkline={last8Weeks} />
    </div>
    <StackedBar title="AR ageing" segments={[
      { label: "Current", value: 41000, tone: "ok" },
      { label: "30+", value: 6200, tone: "warn" },
      { label: "90+", value: 2100, tone: "bad" },
    ]} formatValue={(v) => formatMinor(v * 100, "ZAR")} />
  </SectionCard>
</Page>

// Stacked runs per day (see plugin-cockpit/src/ui/series.ts)
<BarChart data={columns} series={[
  { key: "succeeded", label: "Succeeded", tone: "ok" },
  { key: "failed", label: "Failed", tone: "bad" },
  { key: "other", label: "Other", tone: "neutral" },
]} unit="runs" title="Agent runs per day" />

// Status pill for a record
<Pill tone={invoice.status === "overdue" ? "bad" : invoice.status === "paid" ? "ok" : "neutral"} dot>{invoice.status}</Pill>
```

### Per module

- **Social**: posts by status as a `StackedBar`. Engagement as `TrendChart`.
  Account health as `StatusDot`s. A `Timeline` for what was published.
- **SEO**: sprint progress as a `ProgressRing`. Clicks and impressions as a
  `TrendChart` with two series. Keyword movement as `KpiCard` deltas.
- **CRM**: pipeline value by stage as `BarChart items`. Deal-stage `Pill`s. A
  `Timeline` for contact activity.
- **Campaigns**: open and click rates as `KpiCard`s with sparklines. Sends per
  day as a `BarChart data`.
- **Billing and Accounting**: AR ageing as a `StackedBar`. Revenue as a
  `TrendChart`. Invoice status `Pill`s. VAT due as a `KpiCard` with
  `tone="warn"`.
- **Payroll**: the next run as a `KpiCard`. Headcount cost as a `DonutChart`.
- **Mailbox**: triage counts as `Pill`s. Connection status as a `StatusDot`
  with `pulse` while syncing.
- **Partners**: shared records per partner as `BarChart items`.
