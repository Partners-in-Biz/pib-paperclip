import { createContext, Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(__dir);

describe('Push service worker build', () => {
  it('copies push-sw.js to dist/ui/ byte-equal', async () => {
    execFileSync(process.execPath, ['esbuild.config.mjs'], {
      cwd: packageRoot,
      timeout: 120_000,
    });
    const srcFile = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'));
    const distFile = readFileSync(join(packageRoot, 'dist', 'ui', 'push-sw.js'));
    expect(srcFile).toEqual(distFile);
  });

  it('push handler parses JSON and shows notification with title/body/url', async () => {
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
      data: { json: () => ({ title: 'Test', body: 'Body', url: 'https://app.example.test/home', tag: 'test' }) },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.push!(pushEvent);
    expect(calls[0]).toMatchObject({ title: 'Test', options: { body: 'Body', data: { url: 'https://app.example.test/home' }, tag: 'test' } });
  });

  it('push handler falls back to text when JSON fails', async () => {
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
    expect((calls[0].options as any).body).toBe('Plain text');
  });

  it('notificationclick navigates existing window and focuses it', async () => {
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

    let focusedWindow: any = null;
    const window = { url: 'https://app.example.test/page', navigate: (url: string) => Promise.resolve(window), focus: () => { focusedWindow = window; } };
    (fakeClients.matchAll as any) = () => Promise.resolve([window]);

    let waitUntilPromise: Promise<any> | null = null;
    const clickEvent = {
      notification: { data: { url: 'https://app.example.test/home' }, close: () => {} },
      waitUntil: (p: Promise<any>) => { waitUntilPromise = p; return Promise.resolve(); },
    };
    handlers.notificationclick!(clickEvent);
    if (waitUntilPromise) await waitUntilPromise;
    expect(focusedWindow).toBe(window);
  });

  it('notificationclick opens new window when no windows exist', async () => {
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
      notification: { data: { url: 'https://app.example.test/report' }, close: () => {} },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.notificationclick!(clickEvent);
    expect(opens[0]).toBe('https://app.example.test/report');
  });

  it('rejects cross-origin URLs in notificationclick', async () => {
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
      notification: { data: { url: 'https://evil.example.com/steal' }, close: () => {} },
      waitUntil: (p: Promise<any>) => Promise.resolve(p),
    };
    await handlers.notificationclick!(clickEvent);
    expect(opens[0]).toBe('https://app.example.test/');
  });

  it('source has no console.* calls', () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    expect(source).not.toMatch(/console\./);
  });

  it('source has no importScripts calls', () => {
    const source = readFileSync(join(packageRoot, 'src', 'ui-static', 'push-sw.js'), 'utf-8');
    expect(source).not.toMatch(/importScripts/);
  });
});
