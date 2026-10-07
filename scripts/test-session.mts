/**
 * 会话级共编验证：用假的 storage / BroadcastChannel / window 模拟两个标签页。
 */
import { CollabSession, bootstrap, simulateWriteFailure } from '../src/collab/session.ts';
import type { CollabEnvelope, ViewSnapshot } from '../src/collab/types.ts';

let failures = 0;

function assert(condition: boolean, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

// ————————————————— 假的浏览器环境 —————————————————

type StorageListener = (event: StorageEvent) => void;

class FakeStorageArea {
  // localStorage 跨标签页共享同一份键值；监听者则每个标签页各自一套
  private static shared = new Map<string, string>();
  private listeners = new Set<StorageListener>();
  failNext = 0;

  getItem(key: string): string | null {
    return FakeStorageArea.shared.has(key) ? FakeStorageArea.shared.get(key)! : null;
  }
  setItem(key: string, value: string) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('QuotaExceededError (fake)');
    }
    const oldValue = FakeStorageArea.shared.get(key) ?? null;
    FakeStorageArea.shared.set(key, value);
    const event = { key, oldValue, newValue: value } as StorageEvent;
    // storage 事件只派发给“别的标签页”
    FakeBrowser.dispatchStorage(this, event);
  }
  removeItem(key: string) {
    const oldValue = FakeStorageArea.shared.get(key) ?? null;
    FakeStorageArea.shared.delete(key);
    FakeBrowser.dispatchStorage(this, { key, oldValue, newValue: null } as StorageEvent);
  }
  addListener(fn: StorageListener) {
    this.listeners.add(fn);
  }
  removeListener(fn: StorageListener) {
    this.listeners.delete(fn);
  }
  get ownListeners() {
    return this.listeners;
  }
  static reset() {
    FakeStorageArea.shared.clear();
  }
}

interface FakeChannel {
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
}

class FakeBrowser {
  static instances: FakeBrowser[] = [];
  static channels = new Map<string, Set<FakeChannel>>();

  static dispatchStorage(source: FakeStorageArea, event: StorageEvent) {
    FakeBrowser.instances.forEach((browser) => {
      if (browser.local === source) return;
      browser.local.ownListeners.forEach((fn) => fn(event));
    });
  }

  local = new FakeStorageArea();
  session: Storage;
  private channel: FakeChannel | null = null;
  visibilityState: 'visible' | 'hidden' = 'visible';
  private storageListeners: StorageListener[] = [];
  private visListeners: Array<() => void> = [];
  private focusListeners: Array<() => void> = [];
  timers = new Map<number, () => void>();
  private timerSeq = 1;
  private intervals = new Map<number, () => void>();

  constructor(tabSeed: string) {
    this.session = makeSessionStorage(tabSeed);
    FakeBrowser.instances.push(this);
  }

  install() {
    const browser = this;
    const g = globalThis as unknown as Record<string, unknown>;
    g.localStorage = this.local;
    g.sessionStorage = this.session;
    g.BroadcastChannel = class {
      constructor(public name: string) {
        browser.channel = this as unknown as FakeChannel;
        const set = FakeBrowser.channels.get(name) ?? new Set<FakeChannel>();
        set.add(this as unknown as FakeChannel);
        FakeBrowser.channels.set(name, set);
      }
      onmessage: ((event: { data: unknown }) => void) | null = null;
      postMessage(data: unknown) {
        const set = FakeBrowser.channels.get(this.name);
        set?.forEach((other) => {
          if (other !== (this as unknown as FakeChannel)) {
            queueMicrotask(() => other.onmessage?.({ data }));
          }
        });
      }
      close() {
        FakeBrowser.channels.get(this.name)?.delete(this as unknown as FakeChannel);
      }
    };
    g.window = {
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'storage') this.storageListeners.push(fn as unknown as StorageListener);
        if (type === 'focus') this.focusListeners.push(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        if (type === 'storage') {
          this.storageListeners = this.storageListeners.filter((item) => item !== fn);
        }
      },
      setTimeout: (fn: () => void) => {
        const id = this.timerSeq++;
        this.timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => {
        this.timers.delete(id);
      },
      setInterval: (fn: () => void) => {
        const id = this.timerSeq++;
        this.intervals.set(id, fn);
        return id;
      },
      clearInterval: (id: number) => {
        this.intervals.delete(id);
      },
    };
    g.document = {
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'visibilitychange') this.visListeners.push(fn);
      },
      removeEventListener: () => undefined,
    };
    // storage area 的监听直接挂到 window 监听列表
    this.local.addListener((event) => this.storageListeners.forEach((fn) => fn(event)));
  }

  /** 立即跑掉所有挂起的 setTimeout 回调 */
  async flushTimers() {
    while (this.timers.size) {
      const [id, fn] = [...this.timers.entries()][0];
      this.timers.delete(id);
      await fn();
    }
    await Promise.resolve();
  }

  simulateSleepAndResume() {
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    this.visibilityState = 'hidden';
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'visible';
    this.visibilityState = 'visible';
    this.visListeners.forEach((fn) => fn());
  }
}

function makeSessionStorage(seed: string): Storage {
  const map = new Map<string, string>([['pair-wise-yy-07-tab-id', seed]]);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: map.size,
  };
}

const SEED = {
  title: '种子文档',
  nodes: [
    { id: 'n1', kind: 'rectangle' as const, x: 0, y: 0, width: 100, height: 60, text: 'N1', color: '#fff', locked: false, groupId: null, zIndex: 1, fields: [] },
    { id: 'n2', kind: 'rectangle' as const, x: 300, y: 0, width: 100, height: 60, text: 'N2', color: '#fff', locked: false, groupId: null, zIndex: 2, fields: [] },
  ],
  connectors: [
    { id: 'c1', fromId: 'n1', toId: 'n2', fromAnchor: 'right' as const, toAnchor: 'left' as const, label: 'C1', color: '#666', dashed: false, locked: false, zIndex: 1 },
  ],
};

function startSession(browser: FakeBrowser, tabSeed: string) {
  browser.install();
  const booted = bootstrap(SEED);
  const views: ViewSnapshot[] = [];
  const notices: string[] = [];
  const session = new CollabSession(booted.envelope, booted.recoveredPending, {
    onView: (view) => views.push(view),
    onNotice: (notice) => notices.push(notice.kind),
  });
  return { session, views, notices, booted };
}

async function run() {
  console.log('A) 旧数据迁移：只有 legacy 文档时，启动升级为 rev 1 共同起点');
  {
    const browser = new FakeBrowser('tab-legacy');
    browser.install();
    browser.local.setItem('pair-wise-yy-07-diagram', JSON.stringify({
      version: 1,
      title: '老画布',
      nodes: [SEED.nodes[0]],
      connectors: [],
      updatedAt: 1,
    }));
    const booted = bootstrap(SEED);
    assert(booted.migrated, '识别到无修订号旧文档并标记迁移');
    const envelope = JSON.parse(browser.local.getItem('pair-wise-yy-07-collab')!) as CollabEnvelope;
    assert(envelope.format === 'frameflow-collab' && envelope.rev === 1, '已写入 rev 1 修订信封');
    assert(envelope.title === '老画布', '旧文档内容成为共同起点');
    assert(browser.local.getItem('pair-wise-yy-07-diagram') === null, '迁移后旧键被清除');
  }

  console.log('B) 标签页1提交修改，标签页2立刻看到');
  {
    FakeBrowser.channels.clear();
    FakeStorageArea.reset();
    FakeBrowser.instances = [];
    const browserA = new FakeBrowser('tab-a');
    const a = startSession(browserA, 'tab-a');
    const browserB = new FakeBrowser('tab-b');
    const b = startSession(browserB, 'tab-b');

    a.session.dispatch({ type: 'node-update', targetId: 'n1', changes: { text: '标签页1改的' } });
    await a.session.flushNow();
    await Promise.resolve(); // BroadcastChannel 微任务
    const bView = b.views.at(-1)!;
    assert(bView.nodes.find((n) => n.id === 'n1')!.text === '标签页1改的', '标签页2通过共编看到新文本');
    assert(bView.revision === 2, '标签页2修订号推进到 2');
    assert(a.views.at(-1)!.revision === 2, '标签页1修订号为 2');
    a.session.dispose();
    b.session.dispose();
  }

  console.log('C) 两个标签页同时编辑同一图元：产生冲突且双方取值都在');
  {
    FakeBrowser.channels.clear();
    FakeStorageArea.reset();
    FakeBrowser.instances = [];
    const browserA = new FakeBrowser('tab-a2');
    const a = startSession(browserA, 'tab-a2');
    const browserB = new FakeBrowser('tab-b2');
    const b = startSession(browserB, 'tab-b2');

    a.session.dispatch({ type: 'node-update', targetId: 'n2', changes: { color: '#ff0000' } });
    await a.session.flushNow();
    await Promise.resolve();

    b.session.dispatch({ type: 'node-update', targetId: 'n2', changes: { color: '#00ff00' } });
    await b.session.flushNow();
    await Promise.resolve();

    const viewA = a.views.at(-1)!;
    const viewB = b.views.at(-1)!;
    assert(viewA.conflicts.length === 1 && viewB.conflicts.length === 1, '两个标签页都看到 1 个冲突');
    const conflict = viewB.conflicts[0];
    assert(conflict.first.value === '#ff0000', '先到取值=红');
    assert(conflict.other.value === '#00ff00', '后到取值=绿（只留在冲突面板）');
    assert(viewB.nodes.find((n) => n.id === 'n2')!.color === '#ff0000', '标签页2画布仍显示先到的红色');

    // 标签页1在冲突面板选定绿色
    a.session.resolveConflict(conflict.key, '#00ff00');
    await a.session.flushNow();
    await Promise.resolve();
    assert(b.views.at(-1)!.nodes.find((n) => n.id === 'n2')!.color === '#00ff00', '裁定后标签页2画布变绿');
    assert(b.views.at(-1)!.conflicts.length === 0, '裁定同步后冲突在所有标签页消失');
    a.session.dispose();
    b.session.dispose();
  }

  console.log('D) 标签页1删图元，标签页2的牵连连接线被剪除');
  {
    FakeBrowser.channels.clear();
    FakeStorageArea.reset();
    FakeBrowser.instances = [];
    const browserA = new FakeBrowser('tab-a3');
    const a = startSession(browserA, 'tab-a3');
    const browserB = new FakeBrowser('tab-b3');
    const b = startSession(browserB, 'tab-b3');

    a.session.dispatch({ type: 'node-delete', ids: ['n2'] });
    await a.session.flushNow();
    await Promise.resolve();

    const viewB = b.views.at(-1)!;
    assert(!viewB.connectors.some((c) => c.id === 'c1'), '标签页2的连接线 c1 已失效移除');
    assert(viewB.nodes.every((n) => n.id !== 'n2'), '标签页2的图元 n2 已删除');
    a.session.dispose();
    b.session.dispose();
  }

  console.log('E) 写入失败：信封停留在上次成功文档，本地改动进草稿，重试后提交成功');
  {
    FakeBrowser.channels.clear();
    FakeStorageArea.reset();
    FakeBrowser.instances = [];
    const browser = new FakeBrowser('tab-fail');
    const ctx = startSession(browser, 'tab-fail');

    simulateWriteFailure(1);
    ctx.session.dispatch({ type: 'node-update', targetId: 'n1', changes: { text: '写失败的改动' } });
    await ctx.session.flushNow();

    const failedView = ctx.views.at(-1)!;
    assert(failedView.saveState === 'error', '失败后保存状态为 error');
    assert(failedView.nodes.find((n) => n.id === 'n1')!.text === '写失败的改动', '画布仍乐观显示本地修改（草稿）');
    const envelopeOnDisk = JSON.parse(browser.local.getItem('pair-wise-yy-07-collab')!) as CollabEnvelope;
    assert(envelopeOnDisk.nodes.find((n) => n.id === 'n1')!.text === 'N1', '磁盘仍是上次成功文档，没有半成品');
    const draft = JSON.parse(browser.local.getItem('pair-wise-yy-07-draft:' + envelopeOnDisk.docId)!);
    assert(Array.isArray(draft) && draft.length === 1, '未提交修改已写入本标签页草稿');
    assert(ctx.notices.includes('save-error'), '发出写失败通知');

    // 放弃本地修改 → 回到上次成功文档
    ctx.session.discardPending();
    assert(ctx.views.at(-1)!.nodes.find((n) => n.id === 'n1')!.text === 'N1', '放弃后画布恢复到上次成功文档');
    assert(ctx.views.at(-1)!.saveState === 'synced', '放弃后状态恢复 synced');
    assert(browser.local.getItem('pair-wise-yy-07-draft:' + envelopeOnDisk.docId) === null, '草稿已清除');
    ctx.session.dispose();
  }

  console.log('F) 休眠后恢复：先合并离开期间的改动，再继续本地编辑');
  {
    FakeBrowser.channels.clear();
    FakeStorageArea.reset();
    FakeBrowser.instances = [];
    const browserA = new FakeBrowser('tab-a4');
    const a = startSession(browserA, 'tab-a4');
    const browserB = new FakeBrowser('tab-b4');
    const b = startSession(browserB, 'tab-b4');

    // B 休眠期间，A 连续做两个修改
    a.session.dispatch({ type: 'node-update', targetId: 'n1', changes: { text: '休眠期间改名' } });
    await a.session.flushNow();
    a.session.dispatch({
      type: 'node-add',
      node: { id: 'n3', kind: 'rectangle', x: 0, y: 0, width: 90, height: 50, text: '新图元', color: '#fff', locked: false, groupId: null, zIndex: 3, fields: [] },
    });
    await a.session.flushNow();
    await Promise.resolve();

    // B 带着一个本地草稿休眠后回来
    b.session.dispatch({ type: 'node-update', targetId: 'n2', changes: { text: 'B本地草稿' } });
    browserB.simulateSleepAndResume();

    const view = b.views.at(-1)!;
    assert(view.nodes.find((n) => n.id === 'n1')!.text === '休眠期间改名', '休眠回来后先合并了远端改名');
    assert(view.nodes.some((n) => n.id === 'n3'), '休眠回来后看到远端新增图元');
    assert(view.nodes.find((n) => n.id === 'n2')!.text === 'B本地草稿', '本地草稿在合并后继续保留');
    assert(view.conflicts.length === 0, '两边改不同对象不冲突');

    // 恢复后提交本地草稿能正常落盘
    await b.session.flushNow();
    const disk = JSON.parse(browserA.local.getItem('pair-wise-yy-07-collab')!) as CollabEnvelope;
    assert(disk.nodes.find((n) => n.id === 'n2')!.text === 'B本地草稿', '恢复后草稿成功提交到共享信封');
    assert(disk.rev === 4, `修订号连续（期望 4，实际 ${disk.rev}）`);
    a.session.dispose();
    b.session.dispose();
  }

  console.log('G) 重新打开标签页：未提交草稿被恢复，已提交的不重复');
  {
    FakeBrowser.channels.clear();
    FakeStorageArea.reset();
    FakeBrowser.instances = [];
    const browser = new FakeBrowser('tab-reopen');
    const ctx = startSession(browser, 'tab-reopen');
    ctx.session.dispatch({ type: 'node-update', targetId: 'n1', changes: { text: '崩溃前的草稿' } });
    // 不 flush，模拟标签页崩溃
    ctx.session.dispose();

    // 重新启动新会话（同一 tab 身份、同一磁盘）
    const again = startSession(browser, 'tab-reopen');
    assert(again.views.at(-1)!.nodes.find((n) => n.id === 'n1')!.text === '崩溃前的草稿', '重启后未提交草稿恢复到画布');
    assert(again.booted.recoveredPending.length === 1, '恢复了 1 条草稿操作');
    await again.session.flushNow();
    const disk = JSON.parse(browser.local.getItem('pair-wise-yy-07-collab')!) as CollabEnvelope;
    assert(disk.rev === 2 && disk.nodes.find((n) => n.id === 'n1')!.text === '崩溃前的草稿', '草稿成功补提交，修订号 2');
    again.session.dispose();
  }

  console.log('H) 并发提交竞态：两个标签页同时 flush，两边修改都不丢');
  {
    FakeBrowser.channels.clear();
    FakeStorageArea.reset();
    FakeBrowser.instances = [];
    const browserA = new FakeBrowser('tab-a5');
    const a = startSession(browserA, 'tab-a5');
    const browserB = new FakeBrowser('tab-b5');
    const b = startSession(browserB, 'tab-b5');

    // 两边都基于 rev 1 产生草稿后“同时”提交
    a.session.dispatch({ type: 'node-update', targetId: 'n1', changes: { text: 'A的并发改动' } });
    b.session.dispatch({ type: 'node-update', targetId: 'n2', changes: { text: 'B的并发改动' } });
    await Promise.all([a.session.flushNow(), b.session.flushNow()]);
    await Promise.resolve();

    const disk = JSON.parse(browserA.local.getItem('pair-wise-yy-07-collab')!) as CollabEnvelope;
    assert(disk.nodes.find((n) => n.id === 'n1')!.text === 'A的并发改动', 'A 的修改落盘');
    assert(disk.nodes.find((n) => n.id === 'n2')!.text === 'B的并发改动', 'B 的修改也落盘，没有被 A 盖掉');
    assert(disk.rev === 3, `两次提交产生 rev 3（实际 ${disk.rev}）`);
    a.session.dispose();
    b.session.dispose();
  }

  if (failures > 0) {
    console.error(`\n${failures} 项会话验证失败`);
    process.exit(1);
  }
  console.log('\n全部会话级共编验证通过');
}

void run();
