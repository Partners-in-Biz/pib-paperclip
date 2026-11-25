// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, Sheet } from "../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Modal and Sheet host-dialog layering", () => {
  it("layers Modal and Sheet below host z-50 dialogs so host popups like NewIssueDialog appear on top", () => {
    act(() => {
      root.render(
        <>
          <Sheet open title="Drawer" onClose={() => undefined}>
            <p>Sheet content</p>
          </Sheet>
          <Modal open title="Email" onClose={() => undefined}>
            <p>Email content</p>
          </Modal>
        </>,
      );
    });

    const overlays = Array.from(container.querySelectorAll<HTMLDivElement>('[role="presentation"]'));
    expect(overlays).toHaveLength(2);
    const sheetZ = Number(overlays[0]!.style.zIndex);
    const modalZ = Number(overlays[1]!.style.zIndex);

    expect(sheetZ).toBeGreaterThan(40);
    expect(sheetZ).toBeLessThan(modalZ);
    expect(modalZ).toBeLessThan(50);
  });

  it("ignores Escape already handled (defaultPrevented) by an overlying host dialog", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <Modal open title="Email" onClose={onClose}>
          <p>Email content</p>
        </Modal>,
      );
    });

    const prevented = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    prevented.preventDefault();
    act(() => {
      window.dispatchEvent(prevented);
    });
    expect(onClose).not.toHaveBeenCalled();

    const normal = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    act(() => {
      window.dispatchEvent(normal);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
