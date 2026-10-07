import type { DiagramConnector, DiagramNode } from '../types/diagram';
import {
  applyOp,
  buildView,
  createEnvelope,
  isEnvelope,
  makeOpId,
  MAX_RETAINED_OPS,
} from './engine';
import type {
  CollabEnvelope,
  CollabNotice,
  CollabOp,
  OpSpec,
  SaveState,
  ViewSnapshot,
} from './types';

const ENVELOPE_KEY = 'pair-wise-yy-07-collab';
const LEGACY_KEY = 'pair-wise-yy-07-diagram';
const TAB_KEY = 'pair-wise-yy-07-tab-id';
const DRAFT_PREFIX = 'pair-wise-yy-07-draft:';
const CHANNEL_NAME = 'pair-wise-yy-07-collab';
const PRESENCE_TTL = 8000;
const HEARTBEAT_INTERVAL = 3000;
const FLUSH_DEBOUNCE = 240;

type ChannelMessage =
  | { kind: 'committed'; rev: number; docId: string; tab: string }
  | { kind: 'presence'; tab: string; at: number };

/** 下次落盘强制失败的次数，供演示与测试“写入失败后恢复” */
let failNextWrites = 0;

/** 测试辅助：让接下来的 n 次写盘抛错 */
export function simulateWriteFailure(n = 1): void {
  failNextWrites += n;
}

export interface LegacySeed {
  title: string;
  nodes: DiagramNode[];
  connectors: DiagramConnector[];
}

function makeTabId(): string {
  const existing = sessionStorage.getItem(TAB_KEY);
  if (existing) return existing;
  const id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  sessionStorage.setItem(TAB_KEY, id);
  return id;
}

function makeDocId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function readEnvelope(): CollabEnvelope | null {
  try {
    const raw = localStorage.getItem(ENVELOPE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface BootResult {
  envelope: CollabEnvelope;
  migrated: boolean;
  recoveredPending: CollabOp[];
}

/**
 * 打开时：优先读修订信封；没有就读旧版无修订号文档升级成共同起点；
 * 同时恢复本标签页上次没写成功的本地草稿。
 */
export function bootstrap(seed: LegacySeed): BootResult {
  let envelope = readEnvelope();
  let migrated = false;
  if (!envelope) {
    const legacy = readLegacy();
    const source = legacy ?? seed;
    envelope = createEnvelope({
      docId: makeDocId(),
      title: source.title,
      nodes: source.nodes,
      connectors: source.connectors,
    });
    migrated = Boolean(legacy);
    try {
      localStorage.setItem(ENVELOPE_KEY, JSON.stringify(envelope));
      if (legacy) localStorage.removeItem(LEGACY_KEY);
    } catch {
      // 首次落盘就失败：留在内存里，稍后按普通写失败重试
    }
  }
  const recoveredPending = readDraft(envelope.docId);
  return { envelope, migrated, recoveredPending };
}

function readLegacy(): LegacySeed | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const document = JSON.parse(raw) as {
      version?: number;
      title?: string;
      nodes?: DiagramNode[];
      connectors?: DiagramConnector[];
    };
    if (
      document.version === 1 &&
      typeof document.title === 'string' &&
      Array.isArray(document.nodes) &&
      Array.isArray(document.connectors)
    ) {
      return {
        title: document.title,
        nodes: document.nodes,
        connectors: document.connectors,
      };
    }
  } catch {
    // 旧数据损坏则忽略
  }
  return null;
}

function readDraft(docId: string): CollabOp[] {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + docId);
    if (!raw) return [];
    const ops = JSON.parse(raw) as CollabOp[];
    return Array.isArray(ops) ? ops : [];
  } catch {
    return [];
  }
}

export interface CollabSessionCallbacks {
  onView: (view: ViewSnapshot) => void;
  onNotice: (notice: CollabNotice) => void;
}

export class CollabSession {
  readonly tabId = makeTabId();
  private envelope: CollabEnvelope;
  private pending: CollabOp[];
  private saveState: SaveState = 'synced';
  private peers = new Map<string, number>();
  private channel: BroadcastChannel | null = null;
  private flushTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private disposed = false;
  private callbacks: CollabSessionCallbacks;

  constructor(envelope: CollabEnvelope, recoveredPending: CollabOp[], callbacks: CollabSessionCallbacks) {
    this.envelope = envelope;
    // 草稿恢复：补全本标签页身份；已落盘过的陈旧草稿（上次崩溃在写盘之后）直接丢弃
    const knownIds = new Set(envelope.ops.map((op) => op.id));
    this.pending = recoveredPending
      .filter((op) => !knownIds.has(op.id))
      .map((op) => (op.tab === this.tabId ? op : { ...op, tab: this.tabId }));
    this.callbacks = callbacks;

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
        const message = event.data;
        if (!message || message.tab === this.tabId) return;
        if (message.kind === 'committed') {
          this.ingestRemote();
        } else if (message.kind === 'presence') {
          this.peers.set(message.tab, Date.now());
          this.emitView();
        }
      };
    }
    window.addEventListener('storage', this.handleStorage);
    document.addEventListener('visibilitychange', this.handleResume);
    window.addEventListener('pageshow', this.handleResume);
    window.addEventListener('focus', this.handleResume);

    this.heartbeatTimer = window.setInterval(() => {
      this.postMessage({ kind: 'presence', tab: this.tabId, at: Date.now() });
      this.pruneStalePeers();
    }, HEARTBEAT_INTERVAL);
    this.postMessage({ kind: 'presence', tab: this.tabId, at: Date.now() });

    // 启动即下发当前视图（含恢复的草稿）；有未提交草稿时安排自动补提交
    this.saveState = this.pending.length ? 'saving' : 'synced';
    this.emitView();
    if (this.pending.length) this.scheduleFlush();
  }

  get revision(): number {
    return this.envelope.rev;
  }

  get docId(): string {
    return this.envelope.docId;
  }

  /** 本标签页提交一个编辑动作：立即乐观体现在本地，并安排落盘 */
  dispatch(spec: OpSpec): CollabOp {
    const op: CollabOp = {
      ...spec,
      id: makeOpId(),
      rev: 0,
      tab: this.tabId,
      at: Date.now(),
    } as CollabOp;
    this.pending.push(op);
    this.persistDraft();
    this.scheduleFlush();
    this.emitView();
    return op;
  }

  /** 用户在属性面板上对一个冲突字段做出选择 */
  resolveConflict(key: string, value: unknown) {
    this.dispatch({ type: 'resolve', key, value } as OpSpec);
  }

  /** 手动点保存 */
  flushNow(): Promise<void> {
    return this.flush();
  }

  /** 写失败后放弃未提交的本地修改，回到上次成功的文档 */
  discardPending() {
    this.pending = [];
    this.clearDraft();
    this.saveState = 'synced';
    this.emitView();
  }

  /** 休眠后回来：先把离开期间别标签页的修订合并进来，再继续本地草稿 */
  catchup() {
    this.ingestRemote(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.flushTimer);
    window.clearInterval(this.heartbeatTimer);
    window.removeEventListener('storage', this.handleStorage);
    document.removeEventListener('visibilitychange', this.handleResume);
    window.removeEventListener('pageshow', this.handleResume);
    window.removeEventListener('focus', this.handleResume);
    this.channel?.close();
    if (!this.pending.length) this.clearDraft();
  }

  private handleResume = () => {
    if (document.visibilityState === 'hidden') return;
    this.catchup();
    this.postMessage({ kind: 'presence', tab: this.tabId, at: Date.now() });
  };

  private handleStorage = (event: StorageEvent) => {
    if (event.key !== ENVELOPE_KEY) return;
    this.ingestRemote();
  };

  /** 读取磁盘信封，把离开期间的新修订并入当前信封 */
  private ingestRemote(notifyPruned = false) {
    const remote = readEnvelope();
    if (!remote || remote.docId !== this.envelope.docId) return;
    if (remote.rev <= this.envelope.rev) return;

    const previousConnectors = new Map(this.envelope.connectors.map((c) => [c.id, c]));

    // 以远端信封快照为权威底，重放本地尚未提交的草稿
    this.envelope = remote;
    this.pending.forEach((op) => applyOp(this.envelope, op));

    if (notifyPruned) {
      // 合并后消失、且不是本地草稿删的连接线：即远端操作导致的失效剪枝
      const locallyDeleted = new Set<string>();
      this.pending.forEach((op) => {
        if (op.type === 'connector-delete') op.ids.forEach((id) => locallyDeleted.add(id));
        if (op.type === 'node-delete') op.ids.forEach(() => undefined);
      });
      const labels: string[] = [];
      previousConnectors.forEach((connector, id) => {
        const stillExists = this.envelope.connectors.some((item) => item.id === id);
        if (!stillExists && !locallyDeleted.has(id)) {
          labels.push(connector.label || id);
        }
      });
      if (labels.length) this.callbacks.onNotice({ kind: 'pruned', labels: [...new Set(labels)] });
    }
    this.emitView();
  }

  private scheduleFlush() {
    this.saveState = this.pending.length ? 'saving' : 'synced';
    this.emitView();
    window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      void this.flush();
    }, FLUSH_DEBOUNCE);
  }

  /**
   * 落盘：读最新信封 → 分配修订号并入本地操作 → 整体原子写入。
   * 写失败时信封原样保留（即上次成功的文档），本地修改留在草稿队列等重试。
   */
  private async flush(): Promise<void> {
    if (!this.pending.length) {
      this.saveState = 'synced';
      this.emitView();
      return;
    }
    window.clearTimeout(this.flushTimer);

    const result = this.commitPending(0);
    if (result === 'retry') {
      // 恰好和别的标签页同时提交：让出事件循环后重试，对方的修订先落盘
      await new Promise((resolve) => window.setTimeout(resolve, 30 + Math.random() * 40));
      if (this.pending.length) this.commitPending(1);
    }
  }

  /**
   * 同步完成一次读-改-写临界区，避免跨标签页交叉写入。
   * 写后立刻重读校验：若我们的修订没全部在盘上（说明被并提交叉覆盖），
   * 返回 retry 由调用方基于最新信封重试，两次编辑都不会丢。
   */
  private commitPending(attempt: number): 'ok' | 'retry' {
    const base = readEnvelope();
    if (!base) {
      this.callbacks.onNotice({ kind: 'save-error', message: '共享修订数据缺失，无法写入' });
      this.saveState = 'error';
      this.emitView();
      return 'ok';
    }

    // 同步把本地草稿物化到以磁盘为底的下一信封
    const next: CollabEnvelope = {
      ...base,
      nodes: structuredClone(base.nodes),
      connectors: structuredClone(base.connectors),
      provenance: structuredClone(base.provenance),
      conflicts: structuredClone(base.conflicts),
      ops: [...base.ops],
    };

    const committed: CollabOp[] = [];
    const baseOpIds = new Set(base.ops.map((op) => op.id));
    const drafts = this.pending.filter((draft) => !baseOpIds.has(draft.id));
    let rev = next.rev;
    drafts.forEach((draft) => {
      rev += 1;
      const op: CollabOp = { ...draft, rev };
      const applied = applyOp(next, op);
      committed.push(op);
      if (applied.newConflicts.length) {
        this.callbacks.onNotice({ kind: 'conflict', entries: applied.newConflicts });
      }
      // 本标签页自己的删除引发的级联剪枝不提示（操作者知情）；
      // 远端删图元引发的剪枝在 ingestRemote 合并时提示。
    });
    next.ops = [...next.ops, ...committed].slice(-MAX_RETAINED_OPS);
    next.rev = rev;
    next.updatedAt = Date.now();
    if (!committed.length) {
      // 草稿全都已落盘，仅需对齐视图
      this.envelope = next;
      this.pending = [];
      this.clearDraft();
      this.saveState = 'synced';
      this.emitView();
      return 'ok';
    }

    try {
      if (failNextWrites > 0) {
        failNextWrites -= 1;
        throw new Error('模拟写入失败（磁盘暂不可用）');
      }
      localStorage.setItem(ENVELOPE_KEY, JSON.stringify(next));
    } catch (error) {
      // 写入失败：信封保持上次成功状态，本地改动继续留在草稿，画布不留半成品
      this.envelope = base.docId === this.envelope.docId && base.rev >= this.envelope.rev
        ? base
        : this.envelope;
      this.saveState = 'error';
      this.persistDraft();
      this.emitView();
      this.callbacks.onNotice({
        kind: 'save-error',
        message: error instanceof Error ? error.message : '写入失败',
      });
      return 'ok';
    }

    // 写后校验：重读磁盘确认我们的修订没有被并提交叉覆盖
    const onDisk = readEnvelope();
    const allOnDisk =
      onDisk !== null &&
      committed.every((op) => onDisk.ops.some((existing) => existing.id === op.id));
    if (!allOnDisk) {
      if (attempt === 0) {
        // 信封暂不推进，保持 pending，稍后基于最新磁盘重试
        return 'retry';
      }
      // 极端情况下仍冲突：放弃覆盖策略，把最新磁盘先合进来再由用户/定时器重试
      this.ingestRemote();
      this.saveState = 'error';
      this.emitView();
      this.callbacks.onNotice({ kind: 'save-error', message: '检测到并发写入冲突，稍后自动重试' });
      this.scheduleFlush();
      return 'ok';
    }

    this.envelope = next;
    // 只清掉本次提交或磁盘上已存在的草稿，防止极端交叉时误删新产生的本地操作
    const settledIds = new Set(committed.map((op) => op.id));
    baseOpIds.forEach((id) => settledIds.add(id));
    this.pending = this.pending.filter((draft) => !settledIds.has(draft.id));
    this.clearDraft();
    if (this.pending.length) this.persistDraft();
    this.saveState = this.pending.length ? 'saving' : 'synced';
    this.postMessage({ kind: 'committed', rev, docId: next.docId, tab: this.tabId });
    this.emitView();
    if (this.pending.length) this.scheduleFlush();
    return 'ok';
  }

  private persistDraft() {
    try {
      localStorage.setItem(DRAFT_PREFIX + this.envelope.docId, JSON.stringify(this.pending));
    } catch {
      // 草稿也写不下时至少内存里还在，稍后重试
    }
  }

  private clearDraft() {
    try {
      localStorage.removeItem(DRAFT_PREFIX + this.envelope.docId);
    } catch {
      // 忽略
    }
  }

  private postMessage(message: ChannelMessage) {
    try {
      this.channel?.postMessage(message);
    } catch {
      // BroadcastChannel 不可用时退化为仅靠 storage 事件
    }
  }

  private pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    this.peers.forEach((at, tab) => {
      if (now - at > PRESENCE_TTL) {
        this.peers.delete(tab);
        changed = true;
      }
    });
    if (changed) this.emitView();
  }

  /** 以信封快照叠加本地草稿，得到该标签页当前应显示的视图 */
  private emitView() {
    const state = buildView(this.envelope, this.pending);
    const view: ViewSnapshot = {
      title: state.title,
      nodes: state.nodes,
      connectors: state.connectors,
      conflicts: state.conflicts,
      revision: this.envelope.rev,
      docId: this.envelope.docId,
      saveState: this.saveState,
      peers: this.peers.size,
      tabId: this.tabId,
      pendingCount: this.pending.length,
    };
    this.callbacks.onView(view);
  }
}
