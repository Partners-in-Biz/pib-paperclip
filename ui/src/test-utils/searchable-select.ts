import { act } from "react";

/** jsdom lacks these; cmdk and Radix popovers need them. Call from beforeEach. */
export function stubSearchableSelectDom() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
}

/** Opens the SearchableSelect trigger carrying `ariaLabel`. */
export async function openSearchableSelect(root: ParentNode, ariaLabel: string) {
  const trigger = root.querySelector<HTMLElement>(`[role="combobox"][aria-label="${ariaLabel}"]`);
  if (!trigger) throw new Error(`No searchable select labelled ${ariaLabel}`);
  await act(async () => {
    // A dialog may already have auto-focused the trigger, which opens it.
    if (trigger.getAttribute("aria-expanded") === "true") return;
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  return trigger;
}

/** Opens the select, then clicks the option whose text contains `optionText`. */
export async function pickSearchableOption(root: ParentNode, ariaLabel: string, optionText: string) {
  await openSearchableSelect(root, ariaLabel);
  const item = [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].find((el) =>
    el.textContent?.includes(optionText),
  );
  if (!item) {
    const have = [...document.body.querySelectorAll("[cmdk-item]")].map((el) => el.textContent).join(" | ");
    throw new Error(`No option containing "${optionText}"; open options: ${have}`);
  }
  await act(async () => {
    item.click();
  });
}

/** Opens the SearchableSelect trigger matching `selector` (e.g. "#some-id"), then clicks the option containing `optionText`. */
export async function pickSearchableOptionBySelector(root: ParentNode, selector: string, optionText: string) {
  const trigger = root.querySelector<HTMLElement>(`${selector}[role="combobox"]`);
  if (!trigger) throw new Error(`No searchable select matching ${selector}`);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    // A dialog may already have auto-focused the trigger, which opens it.
    if (trigger.getAttribute("aria-expanded") === "true") return;
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const items = [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")];
  const item = items.find((el) => el.textContent?.includes(optionText));
  if (!item) throw new Error(`No option containing "${optionText}"; open options: ${items.map((el) => el.textContent).join(" | ")}`);
  await act(async () => {
    item.click();
  });
}

/** Opens the SearchableSelect trigger matching `selector` and returns the visible option texts. */
export async function listSearchableOptionsBySelector(root: ParentNode, selector: string) {
  const trigger = root.querySelector<HTMLElement>(`${selector}[role="combobox"]`);
  if (!trigger) throw new Error(`No searchable select matching ${selector}`);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    // A dialog may already have auto-focused the trigger, which opens it.
    if (trigger.getAttribute("aria-expanded") === "true") return;
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].map((el) => el.textContent?.trim());
}

/** Opens a SearchableSelect given its trigger element (found by id, label, etc.). */
export async function openSearchableTrigger(trigger: HTMLElement) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    // A dialog may already have auto-focused the trigger, which opens it.
    if (trigger.getAttribute("aria-expanded") === "true") return;
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Text of every cmdk option currently rendered in document.body (empty when closed). */
export function searchableOptionTexts(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].map((el) => el.textContent ?? "");
}

/** Opens `trigger` and clicks the option whose text equals (or, failing that, contains) `optionText`. */
export async function pickSearchableOptionFromTrigger(trigger: HTMLElement, optionText: string) {
  if (trigger.getAttribute("aria-expanded") !== "true") await openSearchableTrigger(trigger);
  const items = [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")];
  const item = items.find((el) => el.textContent?.trim() === optionText) ?? items.find((el) => el.textContent?.includes(optionText));
  if (!item) throw new Error(`No option "${optionText}" among: ${items.map((el) => el.textContent).join(" | ")}`);
  await act(async () => {
    item.click();
  });
}

/** Opens the select labelled `ariaLabel`, reads its items (data-value + selected check), then closes it. */
export async function readSearchableByLabel(root: ParentNode, ariaLabel: string) {
  const trigger = await openSearchableSelect(root, ariaLabel);
  const items = [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].map((el) => ({
    value: el.getAttribute("data-value") ?? "",
    text: el.textContent ?? "",
    selected: Boolean(el.querySelector("svg.opacity-100")),
  }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return { trigger, items, value: items.find((item) => item.selected)?.value ?? "" };
}

/** Opens the select labelled `ariaLabel` and clicks the item whose data-value equals `value`. */
export async function pickSearchableValue(root: ParentNode, ariaLabel: string, value: string) {
  await openSearchableSelect(root, ariaLabel);
  const item = [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (el) => el.getAttribute("data-value") === value,
  );
  if (!item) throw new Error(`No option with value "${value}"`);
  await act(async () => {
    item.click();
  });
}
