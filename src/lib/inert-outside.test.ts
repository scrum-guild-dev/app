import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { inertOutside } from './inert-outside.ts';

// node の環境に DOM が無いので、inertOutside が使う分だけの要素と MutationObserver の偽物を置く
class FakeElement {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly #attributes = new Map<string, string>();
  constructor(readonly name: string) {}
  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }
  setAttribute(key: string, value: string): void {
    this.#attributes.set(key, value);
  }
  removeAttribute(key: string): void {
    this.#attributes.delete(key);
  }
  hasAttribute(key: string): boolean {
    return this.#attributes.has(key);
  }
}

type Callback = (records: { target: FakeElement; addedNodes: FakeElement[] }[]) => void;
const observers: { callback: Callback; targets: FakeElement[]; connected: boolean }[] = [];

class FakeObserver {
  readonly #entry: { callback: Callback; targets: FakeElement[]; connected: boolean };
  constructor(callback: Callback) {
    this.#entry = { callback, targets: [], connected: true };
    observers.push(this.#entry);
  }
  observe(target: FakeElement): void {
    this.#entry.targets.push(target);
  }
  disconnect(): void {
    this.#entry.connected = false;
  }
}

// 監視している親に子を足し、つながっている監視へ知らせる（本物の MutationObserver の childList と同じ形）
function insert(parent: FakeElement, child: FakeElement): void {
  parent.append(child);
  for (const entry of observers) {
    if (entry.connected && entry.targets.includes(parent)) entry.callback([{ target: parent, addedNodes: [child] }]);
  }
}

let body: FakeElement;
let shell: FakeElement;
let drawer: FakeElement;
let list: FakeElement;
let toasts: FakeElement;
const keep = (sibling: Element) => (sibling as unknown as FakeElement).name === 'toasts';

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('MutationObserver', FakeObserver);
  vi.stubGlobal('Element', FakeElement);
  body = new FakeElement('body');
  vi.stubGlobal('document', { body });
  shell = new FakeElement('shell');
  drawer = new FakeElement('drawer');
  list = new FakeElement('list');
  toasts = new FakeElement('toasts');
  body.append(shell, toasts);
  shell.append(list, drawer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const run = () => inertOutside(drawer as unknown as Element, keep);

describe('inertOutside', () => {
  test('開いた時点の各階層の兄弟に付け、keep の兄弟には付けない。返した関数で外す', () => {
    const undo = run();
    expect(list.hasAttribute('inert')).toBe(true);
    expect(toasts.hasAttribute('inert')).toBe(false);
    expect(drawer.hasAttribute('inert')).toBe(false);
    undo();
    expect(list.hasAttribute('inert')).toBe(false);
  });

  test('開いている間に差し込まれた兄弟（作り直した一覧）にも付け、閉じると外す', () => {
    const undo = run();
    const rebuilt = new FakeElement('rebuilt');
    insert(shell, rebuilt);
    expect(rebuilt.hasAttribute('inert')).toBe(true);
    // 上の階層に差し込まれた要素にも付ける。keep の要素には付けない
    const banner = new FakeElement('banner');
    const lateToasts = new FakeElement('toasts');
    insert(body, banner);
    insert(body, lateToasts);
    expect(banner.hasAttribute('inert')).toBe(true);
    expect(lateToasts.hasAttribute('inert')).toBe(false);
    undo();
    expect(rebuilt.hasAttribute('inert')).toBe(false);
    expect(banner.hasAttribute('inert')).toBe(false);
  });

  test('閉じた後に差し込まれた要素には付けない（監視を止める）', () => {
    run()();
    const later = new FakeElement('later');
    insert(shell, later);
    expect(later.hasAttribute('inert')).toBe(false);
  });

  test('すでに inert の要素は触らず、閉じても外さない（ほかの引き出しや画面が付けたもの）', () => {
    list.setAttribute('inert', '');
    run()();
    expect(list.hasAttribute('inert')).toBe(true);
  });

  test('引き出しの中（監視していない階層）に差し込まれた要素には付けない', () => {
    run();
    const field = new FakeElement('field');
    insert(drawer, field);
    expect(field.hasAttribute('inert')).toBe(false);
  });
});
