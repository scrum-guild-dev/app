import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  adjacentTaskIds,
  provideStoryOrder,
  provideTaskOrder,
  releaseStoryOrder,
  releaseTaskOrder,
  storyOrder,
  taskOrder,
} from './drawer.svelte.ts';
import { stepFocusTarget, trackStoryOrder, trackTaskOrder, visibleStoryIds, visibleTaskIds } from './task-order.ts';

type FakeRow = { id: string | null; hidden?: boolean };

// data-task-id を持つ要素の代わり。hidden は、畳んだ枝のように [hidden] の中にあること
function fakeRoot(rows: readonly FakeRow[]) {
  const elements = rows.map((row) => ({
    getAttribute: (name: string) => (name === 'data-task-id' ? row.id : null),
    closest: (selector: string) => (selector === '[hidden]' && row.hidden === true ? {} : null),
  }));
  return { querySelectorAll: () => elements };
}

// 順を空へ戻す（持ち主を問わず、置いてすぐ片付ける）
function clearOrder(): void {
  const owner = Symbol('clear');
  provideTaskOrder(owner, []);
  releaseTaskOrder(owner);
}

describe('visibleTaskIds', () => {
  test('描かれた順に、見えている行の ID を返す', () => {
    const root = fakeRoot([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(visibleTaskIds(root as unknown as ParentNode)).toEqual(['a', 'b', 'c']);
  });

  test('畳んだ枝（hidden の中）の行は飛ばす', () => {
    const root = fakeRoot([{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }]);
    expect(visibleTaskIds(root as unknown as ParentNode)).toEqual(['a', 'c']);
  });

  test('同じタスクの行が2つあれば先の1つだけ、ID の無い要素は数えない', () => {
    const root = fakeRoot([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: '' }, { id: null }]);
    expect(visibleTaskIds(root as unknown as ParentNode)).toEqual(['a', 'b']);
  });

  test('行が無ければ空', () => {
    expect(visibleTaskIds(fakeRoot([]) as unknown as ParentNode)).toEqual([]);
  });
});

describe('adjacentTaskIds', () => {
  const ids = ['a', 'b', 'c'];

  test('途中は前と次を返す', () => {
    expect(adjacentTaskIds(ids, 'b')).toEqual({ prev: 'a', next: 'c' });
  });

  test('先頭は前が、末尾は次が null で、そこで止まる', () => {
    expect(adjacentTaskIds(ids, 'a')).toEqual({ prev: null, next: 'b' });
    expect(adjacentTaskIds(ids, 'c')).toEqual({ prev: 'b', next: null });
  });

  test('1件だけなら前も次も無い', () => {
    expect(adjacentTaskIds(['a'], 'a')).toEqual({ prev: null, next: null });
  });

  test('順に無いタスク（完了して木から外れた）と空の順は、前後を決めない', () => {
    expect(adjacentTaskIds(ids, 'x')).toBeNull();
    expect(adjacentTaskIds([], 'a')).toBeNull();
  });
});

describe('stepFocusTarget（置き直した引き出しの最初のフォーカス）', () => {
  const both = { hasPrev: true, hasNext: true };

  test('ボタンで移ってきたなら、押した向きの、押せるボタンを返す', () => {
    expect(stepFocusTarget(1, both)).toBe(1);
    expect(stepFocusTarget(-1, both)).toBe(-1);
  });

  test('その向きのボタンが端で押せないなら、閉じるボタン（null）のまま', () => {
    expect(stepFocusTarget(1, { hasPrev: true, hasNext: false })).toBeNull();
    expect(stepFocusTarget(-1, { hasPrev: false, hasNext: true })).toBeNull();
  });

  test('向きが渡されていない（普通に開いた、キーで移った）か、前後のボタンが無いときは、閉じるボタン（null）', () => {
    expect(stepFocusTarget(null, both)).toBeNull();
    expect(stepFocusTarget(1, undefined)).toBeNull();
  });
});

describe('trackTaskOrder', () => {
  type Callback = () => void;
  const observers: { callback: Callback; disconnect: ReturnType<typeof vi.fn> }[] = [];

  class FakeObserver {
    disconnect = vi.fn();
    constructor(callback: Callback) {
      observers.push({ callback, disconnect: this.disconnect });
    }
    observe() {}
  }

  // 次のフレームで走る関数の列。フレームを手で進める
  let frames: (() => void)[] = [];
  const cancelled = new Set<number>();

  afterEach(() => {
    vi.unstubAllGlobals();
    observers.length = 0;
    frames = [];
    cancelled.clear();
    clearOrder();
  });

  function stubBrowser(): void {
    vi.stubGlobal('MutationObserver', FakeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => cancelled.add(handle));
  }

  // 溜まったフレームを1回進める（取り消したものは走らせない）
  function runFrame(): void {
    const pending = frames;
    frames = [];
    pending.forEach((callback, index) => {
      if (!cancelled.has(index + 1)) callback();
    });
  }

  function track(rows: FakeRow[]) {
    stubBrowser();
    const root = fakeRoot(rows);
    const cleanup = trackTaskOrder(root as unknown as HTMLElement);
    return { rows, cleanup };
  }

  test('付いた時点の順を置き、外れたら空へ戻す', () => {
    const { cleanup } = track([{ id: 'a' }, { id: 'b' }]);
    expect([...taskOrder.ids]).toEqual(['a', 'b']);
    cleanup();
    expect([...taskOrder.ids]).toEqual([]);
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  test('行の出入りと畳む／開くを見て、次のフレームで順を置き直す', () => {
    stubBrowser();
    // 行は参照で渡し、後から差し替える
    const elements = { current: fakeRoot([{ id: 'a' }, { id: 'b' }]) };
    const root = { querySelectorAll: () => elements.current.querySelectorAll() };
    trackTaskOrder(root as unknown as HTMLElement);
    expect([...taskOrder.ids]).toEqual(['a', 'b']);

    elements.current = fakeRoot([{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }]);
    observers[0]?.callback();
    runFrame();
    expect([...taskOrder.ids]).toEqual(['a', 'c']);
  });

  test('1フレームの間に何度変化しても、走査は1回だけ', () => {
    stubBrowser();
    let scans = 0;
    const root = {
      querySelectorAll: () => {
        scans++;
        return [];
      },
    };
    trackTaskOrder(root as unknown as HTMLElement);
    const initial = scans;
    observers[0]?.callback();
    observers[0]?.callback();
    observers[0]?.callback();
    expect(scans).toBe(initial);
    runFrame();
    expect(scans).toBe(initial + 1);
    // 次のフレームの変化は、また1回
    observers[0]?.callback();
    observers[0]?.callback();
    runFrame();
    expect(scans).toBe(initial + 2);
  });

  test('外れたら、待っているフレームの走査は取り消して、置き直さない', () => {
    stubBrowser();
    const elements = { current: fakeRoot([{ id: 'a' }]) };
    const root = { querySelectorAll: () => elements.current.querySelectorAll() };
    const cleanup = trackTaskOrder(root as unknown as HTMLElement);
    elements.current = fakeRoot([{ id: 'a' }, { id: 'b' }]);
    observers[0]?.callback();
    cleanup();
    runFrame();
    expect([...taskOrder.ids]).toEqual([]);
  });

  test('順が変わらなければ置き直さない', () => {
    stubBrowser();
    const root = fakeRoot([{ id: 'a' }, { id: 'b' }]);
    trackTaskOrder(root as unknown as HTMLElement);
    const before = taskOrder.ids;
    observers[0]?.callback();
    runFrame();
    expect(taskOrder.ids).toBe(before);
  });

  test('2つ重ねて付けても、先に付けた方の片付けが後から付けた方の順を消さない', () => {
    stubBrowser();
    const cleanupA = trackTaskOrder(fakeRoot([{ id: 'a1' }, { id: 'a2' }]) as unknown as HTMLElement);
    const cleanupB = trackTaskOrder(fakeRoot([{ id: 'b1' }, { id: 'b2' }]) as unknown as HTMLElement);
    expect([...taskOrder.ids]).toEqual(['b1', 'b2']);
    cleanupA();
    expect([...taskOrder.ids]).toEqual(['b1', 'b2']);
    cleanupB();
    expect([...taskOrder.ids]).toEqual([]);
  });
});

describe('持ち主つきの順', () => {
  afterEach(clearOrder);

  test('持ち主でない片付けは、あとから置かれた順を消さない', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    provideTaskOrder(first, ['a']);
    provideTaskOrder(second, ['b']);
    releaseTaskOrder(first);
    expect([...taskOrder.ids]).toEqual(['b']);
    releaseTaskOrder(second);
    expect([...taskOrder.ids]).toEqual([]);
  });
});

// data-story-id を持つ要素の代わり
function fakeStoryRoot(rows: readonly FakeRow[]) {
  const elements = rows.map((row) => ({
    getAttribute: (name: string) => (name === 'data-story-id' ? row.id : null),
    closest: (selector: string) => (selector === '[hidden]' && row.hidden === true ? {} : null),
  }));
  return { querySelectorAll: () => elements };
}

function clearStoryOrder(): void {
  const owner = Symbol('clear');
  provideStoryOrder(owner, []);
  releaseStoryOrder(owner);
}

describe('visibleStoryIds', () => {
  test('描かれた順に、見えているストーリーの行の ID を返し、畳んだ枝の行と重なりは数えない', () => {
    const root = fakeStoryRoot([{ id: 's1' }, { id: 's2', hidden: true }, { id: 's3' }, { id: 's1' }, { id: null }]);
    expect(visibleStoryIds(root as unknown as ParentNode)).toEqual(['s1', 's3']);
  });
});

describe('trackStoryOrder', () => {
  const callbacks: (() => void)[] = [];
  let frames: (() => void)[] = [];

  class FakeObserver {
    disconnect = vi.fn();
    constructor(callback: () => void) {
      callbacks.push(callback);
    }
    observe() {}
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    callbacks.length = 0;
    frames = [];
    clearStoryOrder();
    clearOrder();
  });

  function stubBrowser(): void {
    vi.stubGlobal('MutationObserver', FakeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  }

  test('付いた時点のストーリーの順を、タスクの順とは別に置き、外れたら空へ戻す', () => {
    stubBrowser();
    provideTaskOrder(Symbol('tasks'), ['t1']);
    const cleanup = trackStoryOrder(fakeStoryRoot([{ id: 's1' }, { id: 's2' }]) as unknown as HTMLElement);
    expect([...storyOrder.ids]).toEqual(['s1', 's2']);
    expect([...taskOrder.ids]).toEqual(['t1']);
    cleanup();
    expect([...storyOrder.ids]).toEqual([]);
    expect([...taskOrder.ids]).toEqual(['t1']);
  });

  test('行の出入りと畳む／開くを見て、次のフレームで置き直す', () => {
    stubBrowser();
    const rows = { current: fakeStoryRoot([{ id: 's1' }, { id: 's2' }]) };
    const root = { querySelectorAll: () => rows.current.querySelectorAll() };
    trackStoryOrder(root as unknown as HTMLElement);
    expect([...storyOrder.ids]).toEqual(['s1', 's2']);
    rows.current = fakeStoryRoot([{ id: 's1' }, { id: 's2', hidden: true }, { id: 's3' }]);
    callbacks[0]?.();
    frames.splice(0).forEach((frame) => frame());
    expect([...storyOrder.ids]).toEqual(['s1', 's3']);
  });
});

describe('adjacentTaskIds（ストーリーの順でも使う）', () => {
  test('ストーリーの順の中の前後を返す', () => {
    expect(adjacentTaskIds(['s1', 's2', 's3'], 's2')).toEqual({ prev: 's1', next: 's3' });
  });
});
