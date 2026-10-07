import type {
  DiagramConnector,
  DiagramDocument,
  DiagramNode,
  FieldConflict,
} from '../types/diagram';

export const STORAGE_KEY = 'pair-wise-yy-07-diagram';
export const CHANNEL_NAME = 'pair-wise-yy-07-diagram-collab';
const TAB_ID_KEY = 'pair-wise-yy-07-tab-id';

export function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 每个标签页会话一个稳定 id，用于回显抑制和冲突标注。 */
export function getOrCreateTabId(): string {
  try {
    let id = sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
  } catch {
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** 深比较，字段值都是可 JSON 序列化的。 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 读取本地草稿；旧数据没有修订号时升级为共同起点 1。 */
export function readStoredDocument(): DiagramDocument | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw) as DiagramDocument;
    if (doc.version !== 1 || !Array.isArray(doc.nodes) || !Array.isArray(doc.connectors)) {
      return null;
    }
    if (typeof doc.revision !== 'number' || doc.revision < 1) {
      doc.revision = 1;
    }
    return doc;
  } catch {
    return null;
  }
}

/** 事务性写入：成功返回 true，失败返回 false（调用方负责回滚）。 */
export function writeDocumentToStorage(doc: DiagramDocument): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

/** 合并后清理指向已不存在图元的连接线，避免悬空引用。 */
export function pruneOrphanConnectors(doc: DiagramDocument): DiagramDocument {
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  const connectors = doc.connectors.filter(
    (connector) => nodeIds.has(connector.fromId) && nodeIds.has(connector.toId),
  );
  if (connectors.length === doc.connectors.length) return doc;
  return { ...doc, connectors };
}

export interface MergeResult {
  document: DiagramDocument;
  conflicts: FieldConflict[];
}

const NODE_FIELDS = [
  { key: 'text' as const, label: '名称 / 标题' },
  { key: 'color' as const, label: '填充颜色' },
  { key: 'x' as const, label: 'X 坐标' },
  { key: 'y' as const, label: 'Y 坐标' },
  { key: 'width' as const, label: '宽度' },
  { key: 'height' as const, label: '高度' },
  { key: 'fields' as const, label: '表字段' },
  { key: 'locked' as const, label: '锁定' },
  { key: 'groupId' as const, label: '分组' },
  { key: 'zIndex' as const, label: '层级' },
];

const CONNECTOR_FIELDS = [
  { key: 'label' as const, label: '标签' },
  { key: 'color' as const, label: '颜色' },
  { key: 'dashed' as const, label: '虚线' },
  { key: 'fromAnchor' as const, label: '起点锚点' },
  { key: 'toAnchor' as const, label: '终点锚点' },
  { key: 'locked' as const, label: '锁定' },
  { key: 'zIndex' as const, label: '层级' },
];

function makeConflict(
  entityKind: FieldConflict['entityKind'],
  entityId: string,
  field: string,
  fieldLabel: string,
  localValue: unknown,
  remoteValue: unknown,
  localTab: string,
  remoteTab: string,
): FieldConflict {
  return {
    id: `conflict-${entityKind}-${entityId}-${field}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    entityKind,
    entityId,
    field,
    fieldLabel,
    localValue,
    remoteValue,
    localTab,
    remoteTab,
  };
}

/** 三处都存在的实体：逐字段三方合并。 */
function mergeFields<T extends { id: string }>(
  base: T,
  local: T,
  remote: T,
  fields: ReadonlyArray<{ key: keyof T; label: string }>,
  entityKind: 'node' | 'connector',
  conflicts: FieldConflict[],
  localTab: string,
  remoteTab: string,
): T {
  const result = clonePlain(local);
  for (const { key, label } of fields) {
    const b = (base as Record<string, unknown>)[key as string];
    const l = (local as Record<string, unknown>)[key as string];
    const r = (remote as Record<string, unknown>)[key as string];
    if (valuesEqual(l, r)) {
      (result as Record<string, unknown>)[key as string] = l;
    } else if (valuesEqual(l, b)) {
      (result as Record<string, unknown>)[key as string] = r;
    } else if (valuesEqual(r, b)) {
      (result as Record<string, unknown>)[key as string] = l;
    } else {
      (result as Record<string, unknown>)[key as string] = l;
      conflicts.push(
        makeConflict(entityKind, base.id, String(key), label, l, r, localTab, remoteTab),
      );
    }
  }
  return result;
}

/**
 * 实体级三方合并。
 * - 双方都新增（id 相同，极罕见）：LWW 取对方。
 * - 一方删除、另一方未改：删除。
 * - 一方删除、另一方修改：修改优先（保留实体），记一条删除冲突。
 */
function mergeEntity<T extends { id: string }>(
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  fields: ReadonlyArray<{ key: keyof T; label: string }>,
  entityKind: 'node' | 'connector',
  conflicts: FieldConflict[],
  localTab: string,
  remoteTab: string,
): T | undefined {
  if (!base) {
    if (local && remote) return clonePlain(remote);
    if (local) return clonePlain(local);
    if (remote) return clonePlain(remote);
    return undefined;
  }
  if (!local && !remote) return undefined;
  if (!local) {
    if (valuesEqual(base, remote)) return undefined;
    conflicts.push(
      makeConflict(
        entityKind,
        base.id,
        '__delete__',
        '删除状态',
        '删除（本标签页已删）',
        '保留（其他标签页有修改）',
        localTab,
        remoteTab,
      ),
    );
    return clonePlain(remote);
  }
  if (!remote) {
    if (valuesEqual(base, local)) return undefined;
    conflicts.push(
      makeConflict(
        entityKind,
        base.id,
        '__delete__',
        '删除状态',
        '保留（本标签页有修改）',
        '删除（其他标签页已删）',
        localTab,
        remoteTab,
      ),
    );
    return clonePlain(local);
  }
  return mergeFields(base, local, remote, fields, entityKind, conflicts, localTab, remoteTab);
}

function mergeTitle(
  base: string,
  local: string,
  remote: string,
  conflicts: FieldConflict[],
  localTab: string,
  remoteTab: string,
): string {
  if (valuesEqual(local, remote)) return local;
  if (valuesEqual(local, base)) return remote;
  if (valuesEqual(remote, base)) return local;
  conflicts.push(
    makeConflict('title', 'document', 'title', '图表标题', local, remote, localTab, remoteTab),
  );
  return local;
}

/**
 * 三方合并：base = 上次共编起点，local = 本标签页当前，remote = 其他标签页来的文档。
 * 逐字段判断：双方一致取同；仅一方改取改方；双方都改且不同 → 冲突，两边取值都留下。
 */
export function mergeDocuments(
  base: DiagramDocument,
  local: DiagramDocument,
  remote: DiagramDocument,
  localTab: string,
  remoteTab: string,
): MergeResult {
  const conflicts: FieldConflict[] = [];
  const title = mergeTitle(base.title, local.title, remote.title, conflicts, localTab, remoteTab);

  const nodeIds = new Set([
    ...base.nodes.map((node) => node.id),
    ...local.nodes.map((node) => node.id),
    ...remote.nodes.map((node) => node.id),
  ]);
  const nodes: DiagramNode[] = [];
  nodeIds.forEach((id) => {
    const b = base.nodes.find((node) => node.id === id);
    const l = local.nodes.find((node) => node.id === id);
    const r = remote.nodes.find((node) => node.id === id);
    const merged = mergeEntity(b, l, r, NODE_FIELDS, 'node', conflicts, localTab, remoteTab);
    if (merged) nodes.push(merged);
  });
  nodes.sort((a, b) => a.zIndex - b.zIndex);

  const connectorIds = new Set([
    ...base.connectors.map((connector) => connector.id),
    ...local.connectors.map((connector) => connector.id),
    ...remote.connectors.map((connector) => connector.id),
  ]);
  let connectors: DiagramConnector[] = [];
  connectorIds.forEach((id) => {
    const b = base.connectors.find((connector) => connector.id === id);
    const l = local.connectors.find((connector) => connector.id === id);
    const r = remote.connectors.find((connector) => connector.id === id);
    const merged = mergeEntity(b, l, r, CONNECTOR_FIELDS, 'connector', conflicts, localTab, remoteTab);
    if (merged) connectors.push(merged);
  });
  connectors.sort((a, b) => a.zIndex - b.zIndex);

  // 图元改动后，牵连的连接线失效重算：清理指向已不存在图元的连接线。
  const nodeIdSet = new Set(nodes.map((node) => node.id));
  connectors = connectors.filter(
    (connector) => nodeIdSet.has(connector.fromId) && nodeIdSet.has(connector.toId),
  );

  const revision = Math.max(local.revision, remote.revision) + 1;

  return {
    document: {
      version: 1,
      revision,
      title,
      nodes,
      connectors,
      updatedAt: Date.now(),
    },
    conflicts,
  };
}

// ---- 跨标签页传输 ----

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null;
    }
  }
  return channel;
}

export function broadcastDocument(doc: DiagramDocument, tabId: string): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: 'document-update', tabId, document: doc });
  } catch {
    // 通道不可用时静默，storage 事件会兜底。
  }
}

export function subscribeToBroadcast(
  handler: (doc: DiagramDocument, tabId: string) => void,
): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const listener = (event: MessageEvent) => {
    const message = event.data as
      | { type?: string; tabId?: string; document?: DiagramDocument }
      | undefined;
    if (message?.type === 'document-update' && message.document && message.tabId) {
      handler(message.document, message.tabId);
    }
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

/** storage 事件兜底：其他标签页写入 localStorage 时触发。 */
export function subscribeToStorage(handler: (doc: DiagramDocument) => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const doc = JSON.parse(event.newValue) as DiagramDocument;
      if (doc.version !== 1 || !Array.isArray(doc.nodes) || !Array.isArray(doc.connectors)) return;
      if (typeof doc.revision !== 'number' || doc.revision < 1) doc.revision = 1;
      handler(doc);
    } catch {
      // 忽略损坏的草稿。
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
