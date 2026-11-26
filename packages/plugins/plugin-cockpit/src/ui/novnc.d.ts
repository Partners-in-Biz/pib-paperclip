/** `@novnc/novnc` 1.7 ships no types. Only what the Watch live / Take over drawer uses; the package exports only `.`. */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string, options?: Record<string, unknown>);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    disconnect(): void;
    /** Keyboard focus to the remote screen (take over). */
    focus(): void;
  }
}
