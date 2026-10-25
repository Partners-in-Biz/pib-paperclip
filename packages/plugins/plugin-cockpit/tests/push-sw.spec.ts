import { createContext, Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(__dir);

describe('Push service worker', () => {
  it('push: parses JSON with all fields and shows notification', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const pushEvent = {
      data: { json: () => ({ title: 'Alert', body: 'Important', url: 'https://app.example.test/home', tag: 'alert-1' }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0]).toMatchObject({
      title: 'Alert',
      options: { body: 'Important', data: { url: 'https://app.example.test/home' }, tag: 'alert-1' },
    });
  });

  it('push: uses fallback title "Partners in Biz" when payload missing title', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const pushEvent = {
      data: { json: () => ({ body: 'No title here' }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].title).toBe('Partners in Biz');
  });

  it('push: truncates title to 120 chars and body to 300 chars', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const longTitle = 'x'.repeat(150);
    const longBody = 'y'.repeat(350);
    const pushEvent = {
      data: { json: () => ({ title: longTitle, body: longBody }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].title).toBe('x'.repeat(120));
    expect(calls[0].options.body).toBe('y'.repeat(300));
  });

  it('push: validates and stores same-origin URLs only', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };

    // Valid same-origin URL
    const pushEvent = {
      data: { json: () => ({ url: 'https://app.example.test/page' }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].options.data.url).toBe('https://app.example.test/page');
  });

  it('push: rejects cross-origin URLs and stores undefined', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const pushEvent = {
      data: { json: () => ({ url: 'https://evil.example.com/steal' }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].options.data.url).toBeUndefined();
  });

  it('push: rejects javascript: URLs', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const pushEvent = {
      data: { json: () => ({ url: 'javascript:alert("xss")' }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].options.data.url).toBeUndefined();
  });

  it('push: passes tag through to notification options', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const pushEvent = {
      data: { json: () => ({ tag: 'my-notification-tag' }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].options.tag).toBe('my-notification-tag');
  });

  it('push: handles malformed JSON with fallback title', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const pushEvent = {
      data: { json: () => { throw new Error('Not JSON'); }, text: () => 'Plain text' },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].title).toBe('Partners in Biz');
    expect(calls[0].options.body).toBe('Plain text');
  });

  it('push: handles empty payload with fallback title', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { push: null };
    const fakeRegistration = { showNotification: (title: string, options?: any) => Promise.resolve() };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'push') handlers.push = handler; },
      registration: fakeRegistration,
      location: { origin: 'https://app.example.test' },
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const calls: any[] = [];
    (fakeRegistration.showNotification as any) = (title: string, options?: any) => {
      calls.push({ title, options });
      return Promise.resolve();
    };
    const pushEvent = {
      data: { json: () => { throw new Error('No data'); } },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0].title).toBe('Partners in Biz');
    expect(calls[0].options.body).toBe('Notification received');
  });

  it('notificationclick: finds and navigates same-origin window', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { notificationclick: null };
    const fakeClients = { matchAll: () => Promise.resolve([]) };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'notificationclick') handlers.notificationclick = handler; },
      location: { origin: 'https://app.example.test' },
      clients: fakeClients,
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    let focusedWindow: any = null;
    const window1 = { url: 'https://app.example.test/page1', navigate: (url: string) => Promise.resolve(window1), focus: () => { focusedWindow = window1; } };
    (fakeClients.matchAll as any) = () => Promise.resolve([window1]);

    let waitUntilPromise: Promise<any> | null = null;
    const clickEvent = {
      notification: { data: { url: 'https://app.example.test/home' }, close: () => {} },
      waitUntil: (p: Promise<any>) => { waitUntilPromise = p; return Promise.resolve(); },
    };
    handlers.notificationclick!(clickEvent);
    if (waitUntilPromise) await waitUntilPromise;
    expect(focusedWindow).toBe(window1);
  });

  it('notificationclick: prioritizes same-origin window over cross-origin', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { notificationclick: null };
    const fakeClients = { matchAll: () => Promise.resolve([]) };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'notificationclick') handlers.notificationclick = handler; },
      location: { origin: 'https://app.example.test' },
      clients: fakeClients,
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    let focusedWindow: any = null;
    const evil_window = { url: 'https://evil.example.com/page', navigate: () => Promise.resolve(evil_window), focus: () => { focusedWindow = evil_window; } };
    const good_window = { url: 'https://app.example.test/page', navigate: (url: string) => Promise.resolve(good_window), focus: () => { focusedWindow = good_window; } };
    (fakeClients.matchAll as any) = () => Promise.resolve([evil_window, good_window]);

    let waitUntilPromise: Promise<any> | null = null;
    const clickEvent = {
      notification: { data: { url: 'https://app.example.test/home' }, close: () => {} },
      waitUntil: (p: Promise<any>) => { waitUntilPromise = p; return Promise.resolve(); },
    };
    handlers.notificationclick!(clickEvent);
    if (waitUntilPromise) await waitUntilPromise;
    expect(focusedWindow).toBe(good_window);
  });

  it('notificationclick: opens new window when no same-origin clients exist', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { notificationclick: null };
    const fakeClients = { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve(null) };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'notificationclick') handlers.notificationclick = handler; },
      location: { origin: 'https://app.example.test' },
      clients: fakeClients,
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const opens: string[] = [];
    (fakeClients.openWindow as any) = (url: string) => { opens.push(url); return Promise.resolve(null); };
    const clickEvent = {
      notification: { data: { url: 'https://app.example.test/home' }, close: () => {} },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.notificationclick!(clickEvent);
    expect(opens[0]).toBe('https://app.example.test/home');
  });

  it('notificationclick: opens app root when notification has no URL', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { notificationclick: null };
    const fakeClients = { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve(null) };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'notificationclick') handlers.notificationclick = handler; },
      location: { origin: 'https://app.example.test' },
      clients: fakeClients,
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const opens: string[] = [];
    (fakeClients.openWindow as any) = (url: string) => { opens.push(url); return Promise.resolve(null); };
    const clickEvent = {
      notification: { data: {}, close: () => {} },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.notificationclick!(clickEvent);
    expect(opens[0]).toBe('https://app.example.test/');
  });

  it('notificationclick: handles missing notification data gracefully', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { notificationclick: null };
    const fakeClients = { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve(null) };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'notificationclick') handlers.notificationclick = handler; },
      location: { origin: 'https://app.example.test' },
      clients: fakeClients,
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    const opens: string[] = [];
    (fakeClients.openWindow as any) = (url: string) => { opens.push(url); return Promise.resolve(null); };
    const clickEvent = {
      notification: { data: null, close: () => {} },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.notificationclick!(clickEvent);
    expect(opens[0]).toBe('https://app.example.test/');
  });

  it('notificationclick: calls navigate when available, otherwise just returns client', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { notificationclick: null };
    const fakeClients = { matchAll: () => Promise.resolve([]) };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'notificationclick') handlers.notificationclick = handler; },
      location: { origin: 'https://app.example.test' },
      clients: fakeClients,
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    let navigateCalled = false;
    let focusedWindow: any = null;
    const window_no_nav = {
      url: 'https://app.example.test/page',
      focus: () => { focusedWindow = window_no_nav; },
      navigate: undefined,
    };
    (fakeClients.matchAll as any) = () => Promise.resolve([window_no_nav]);

    let waitUntilPromise: Promise<any> | null = null;
    const clickEvent = {
      notification: { data: { url: 'https://app.example.test/home' }, close: () => {} },
      waitUntil: (p: Promise<any>) => { waitUntilPromise = p; return Promise.resolve(); },
    };
    handlers.notificationclick!(clickEvent);
    if (waitUntilPromise) await waitUntilPromise;
    expect(focusedWindow).toBe(window_no_nav);
  });

  it('notificationclick: closes notification', async () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    const handlers: Record<string, Function | null> = { notificationclick: null };
    const fakeClients = { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve(null) };
    const fakeSelf = {
      addEventListener: (type: string, handler: Function) => { if (type === 'notificationclick') handlers.notificationclick = handler; },
      location: { origin: 'https://app.example.test' },
      clients: fakeClients,
    };
    const context = createContext({ self: fakeSelf, URL });
    new Script(source, { filename: 'push-sw.js' }).runInContext(context);

    let closeCalled = false;
    const clickEvent = {
      notification: { data: {}, close: () => { closeCalled = true; } },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    handlers.notificationclick!(clickEvent);
    expect(closeCalled).toBe(true);
  });
});
