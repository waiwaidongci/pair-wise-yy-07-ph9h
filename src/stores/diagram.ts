import { defineStore } from 'pinia';
import type {
  DiagramConnector,
  DiagramDocument,
  DiagramNode,
  FieldConflict,
  NodeKind,
  SyncStatus,
  ToolMode,
} from '../types/diagram';
import { DEFAULT_NODE_SIZE } from '../utils/diagramGeometry';
import {
  STORAGE_KEY,
  broadcastDocument,
  clonePlain,
  getOrCreateTabId,
  mergeDocuments,
  readStoredDocument,
  subscribeToBroadcast,
  subscribeToStorage,
  valuesEqual,
  writeDocumentToStorage,
} from '../utils/collab';

let persistTimer: number | undefined;
let syncedBase: DiagramDocument | null = null;
let lastSuccessfulSnapshot: DiagramDocument | null = null;
let skipRevisionBump = false;
let unsubBroadcast: (() => void) | null = null;
let unsubStorage: (() => void) | null = null;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function initialNodes(): DiagramNode[] {
  return [
    {
      id: 'table-customers',
      kind: 'table',
      x: 90,
      y: 110,
      width: 210,
      height: 170,
      text: 'customers',
      color: '#ffffff',
      locked: false,
      groupId: null,
      zIndex: 1,
      fields: ['id  BIGINT PK', 'name  VARCHAR(80)', 'region  VARCHAR(20)', 'credit_limit DECIMAL'],
    },
    {
      id: 'table-orders',
      kind: 'table',
      x: 470,
      y: 90,
      width: 220,
      height: 190,
      text: 'orders',
      color: '#ffffff',
      locked: false,
      groupId: null,
      zIndex: 2,
      fields: ['id  BIGINT PK', 'customer_id  BIGINT FK', 'amount  DECIMAL', 'status VARCHAR(20)'],
    },
    {
      id: 'node-review',
      kind: 'diamond',
      x: 470,
      y: 370,
      width: 180,
      height: 120,
      text: '风控审核通过？',
      color: '#fff7e8',
      locked: false,
      groupId: null,
      zIndex: 3,
      fields: [],
    },
    {
      id: 'node-fulfill',
      kind: 'rectangle',
      x: 820,
      y: 385,
      width: 180,
      height: 76,
      text: '进入履约流程',
      color: '#eaf7f0',
      locked: false,
      groupId: null,
      zIndex: 4,
      fields: [],
    },
    {
      id: 'node-close',
      kind: 'circle',
      x: 845,
      y: 130,
      width: 112,
      height: 112,
      text: '订单完成',
      color: '#eef4ff',
      locked: false,
      groupId: null,
      zIndex: 5,
      fields: [],
    },
  ];
}

function initialConnectors(): DiagramConnector[] {
  return [
    {
      id: 'connector-customer-orders',
      fromId: 'table-customers',
      toId: 'table-orders',
      fromAnchor: 'right',
      toAnchor: 'left',
      label: '1 : N',
      color: '#1f6feb',
      dashed: false,
      locked: false,
      zIndex: 1,
    },
    {
      id: 'connector-orders-review',
      fromId: 'table-orders',
      toId: 'node-review',
      fromAnchor: 'bottom',
      toAnchor: 'top',
      label: '校验',
      color: '#667085',
      dashed: false,
      locked: false,
      zIndex: 2,
    },
    {
      id: 'connector-review-fulfill',
      fromId: 'node-review',
      toId: 'node-fulfill',
      fromAnchor: 'right',
      toAnchor: 'left',
      label: '是',
      color: '#12805c',
      dashed: false,
      locked: false,
      zIndex: 3,
    },
    {
      id: 'connector-review-close',
      fromId: 'node-review',
      toId: 'node-close',
      fromAnchor: 'top',
      toAnchor: 'bottom',
      label: '驳回',
      color: '#c2413b',
      dashed: true,
      locked: false,
      zIndex: 4,
    },
  ];
}

interface HistoryState {
  past: DiagramDocument[];
  future: DiagramDocument[];
}

const savedDocument = readStoredDocument();

export const useDiagramStore = defineStore('diagram', {
  state: () => ({
    title: savedDocument?.title ?? '订单履约架构图',
    nodes: savedDocument?.nodes ?? initialNodes(),
    connectors: savedDocument?.connectors ?? initialConnectors(),
    revision: savedDocument?.revision ?? 0,
    conflicts: [] as FieldConflict[],
    tabId: '',
    syncStatus: 'idle' as SyncStatus,
    selectedIds: [] as string[],
    selectedConnectorId: null as string | null,
    activeNodeId: null as string | null,
    toolMode: 'select' as ToolMode,
    zoom: 1,
    pan: { x: 36, y: 24 },
    snapToGrid: true,
    gridSize: 20,
    history: { past: [], future: [] } as HistoryState,
  }),
  getters: {
    selectedNodes(state): DiagramNode[] {
      return state.nodes.filter((node) => state.selectedIds.includes(node.id));
    },
    activeNode(state): DiagramNode | null {
      return state.nodes.find((node) => node.id === state.activeNodeId) ?? null;
    },
    canUndo: (state) => state.history.past.length > 0,
    canRedo: (state) => state.history.future.length > 0,
  },
  actions: {
    snapshot(): DiagramDocument {
      return {
        version: 1,
        revision: this.revision,
        title: this.title,
        nodes: clonePlain(this.nodes),
        connectors: clonePlain(this.connectors),
        updatedAt: Date.now(),
      };
    },
    checkpoint() {
      this.history.past.push(this.snapshot());
      if (this.history.past.length > 80) this.history.past.shift();
      this.history.future = [];
    },
    undo() {
      const previous = this.history.past.pop();
      if (!previous) return;
      this.history.future.push(this.snapshot());
      this.restore(previous);
      this.persistSoon();
    },
    redo() {
      const next = this.history.future.pop();
      if (!next) return;
      this.history.past.push(this.snapshot());
      this.restore(next);
      this.persistSoon();
    },
    restore(document: DiagramDocument) {
      this.title = document.title;
      this.nodes = clonePlain(document.nodes);
      this.connectors = clonePlain(document.connectors);
      this.selectedIds = this.selectedIds.filter((id) => this.nodes.some((node) => node.id === id));
      this.selectedConnectorId = null;
      this.activeNodeId = this.selectedIds.at(-1) ?? null;
    },
    addNode(kind: NodeKind, position?: { x: number; y: number }) {
      this.checkpoint();
      const size = DEFAULT_NODE_SIZE[kind];
      const point = position ?? {
        x: 220 + (this.nodes.length % 4) * 26,
        y: 220 + (this.nodes.length % 3) * 24,
      };
      const node: DiagramNode = {
        id: makeId(kind),
        kind,
        x: this.snapToGrid ? Math.round(point.x / this.gridSize) * this.gridSize : point.x,
        y: this.snapToGrid ? Math.round(point.y / this.gridSize) * this.gridSize : point.y,
        width: size.width,
        height: kind === 'table' ? Math.max(size.height, 82 + 4 * 34) : size.height,
        text:
          kind === 'table'
            ? 'new_table'
            : kind === 'diamond'
              ? '条件判断'
              : kind === 'circle'
                ? '开始 / 结束'
                : '流程节点',
        color: kind === 'table' ? '#ffffff' : '#eef4ff',
        locked: false,
        groupId: null,
        zIndex: Math.max(0, ...this.nodes.map((item) => item.zIndex)) + 1,
        fields: kind === 'table' ? ['id  BIGINT PK', 'name  VARCHAR(80)'] : [],
      };
      this.nodes.push(node);
      this.selectNode(node.id);
      this.persistSoon();
    },
    updateNode(id: string, patch: Partial<DiagramNode>) {
      const node = this.nodes.find((item) => item.id === id);
      if (!node) return;
      Object.assign(node, patch);
      for (const key of Object.keys(patch)) {
        const conflict = this.conflicts.find(
          (item) => item.entityKind === 'node' && item.entityId === id && item.field === key,
        );
        if (conflict) conflict.localValue = (node as Record<string, unknown>)[key];
      }
      this.persistSoon();
    },
    patchNode(id: string, patch: Partial<DiagramNode>) {
      this.checkpoint();
      this.updateNode(id, patch);
    },
    commitPositions(positions: Record<string, { x: number; y: number }>) {
      Object.entries(positions).forEach(([id, point]) => {
        const node = this.nodes.find((item) => item.id === id);
        if (node) {
          node.x = point.x;
          node.y = point.y;
        }
      });
      this.persistSoon();
    },
    selectNode(id: string, append = false) {
      this.selectedConnectorId = null;
      if (append) {
        this.selectedIds = this.selectedIds.includes(id)
          ? this.selectedIds.filter((item) => item !== id)
          : [...this.selectedIds, id];
      } else {
        this.selectedIds = [id];
      }
      this.activeNodeId = id;
    },
    selectConnector(id: string) {
      this.selectedConnectorId = id;
      this.selectedIds = [];
      this.activeNodeId = null;
    },
    clearSelection() {
      this.selectedIds = [];
      this.selectedConnectorId = null;
      this.activeNodeId = null;
    },
    addConnector(
      fromId: string,
      toId: string,
      fromAnchor: DiagramConnector['fromAnchor'],
      toAnchor: DiagramConnector['toAnchor'],
    ) {
      if (fromId === toId) return;
      const exists = this.connectors.some(
        (connector) =>
          connector.fromId === fromId &&
          connector.toId === toId &&
          connector.fromAnchor === fromAnchor &&
          connector.toAnchor === toAnchor,
      );
      if (exists) return;
      this.checkpoint();
      this.connectors.push({
        id: makeId('connector'),
        fromId,
        toId,
        fromAnchor,
        toAnchor,
        label: '',
        color: '#667085',
        dashed: false,
        locked: false,
        zIndex: Math.max(0, ...this.connectors.map((item) => item.zIndex)) + 1,
      });
      this.persistSoon();
    },
    updateConnector(id: string, patch: Partial<DiagramConnector>) {
      const connector = this.connectors.find((item) => item.id === id);
      if (!connector) return;
      Object.assign(connector, patch);
      for (const key of Object.keys(patch)) {
        const conflict = this.conflicts.find(
          (item) => item.entityKind === 'connector' && item.entityId === id && item.field === key,
        );
        if (conflict) conflict.localValue = (connector as Record<string, unknown>)[key];
      }
      this.persistSoon();
    },
    patchConnector(id: string, patch: Partial<DiagramConnector>) {
      this.checkpoint();
      this.updateConnector(id, patch);
    },
    deleteSelection() {
      if (!this.selectedIds.length && !this.selectedConnectorId) return;
      this.checkpoint();
      const selected = new Set(this.selectedIds);
      this.nodes = this.nodes.filter((node) => !selected.has(node.id));
      this.connectors = this.connectors.filter(
        (connector) =>
          connector.id !== this.selectedConnectorId &&
          !selected.has(connector.fromId) &&
          !selected.has(connector.toId),
      );
      this.clearSelection();
      this.persistSoon();
    },
    duplicateSelection() {
      if (!this.selectedIds.length) return;
      this.checkpoint();
      const idMap = new Map<string, string>();
      const copies = this.selectedNodes.map((node) => {
        const id = makeId(node.kind);
        idMap.set(node.id, id);
        return {
          ...clonePlain(node),
          id,
          x: node.x + 32,
          y: node.y + 32,
          zIndex: Math.max(0, ...this.nodes.map((item) => item.zIndex)) + idMap.size,
        };
      });
      const originalIds = new Set(this.selectedIds);
      const connectorCopies = this.connectors
        .filter(
          (connector) => originalIds.has(connector.fromId) && originalIds.has(connector.toId),
        )
        .map((connector) => ({
          ...clonePlain(connector),
          id: makeId('connector'),
          fromId: idMap.get(connector.fromId) as string,
          toId: idMap.get(connector.toId) as string,
          zIndex: Math.max(0, ...this.connectors.map((item) => item.zIndex)) + 1,
        }));
      this.nodes.push(...copies);
      this.connectors.push(...connectorCopies);
      this.selectedIds = copies.map((node) => node.id);
      this.activeNodeId = copies.at(-1)?.id ?? null;
      this.persistSoon();
    },
    groupSelection() {
      if (this.selectedIds.length < 2) return;
      this.checkpoint();
      const groupId = makeId('group');
      this.nodes.forEach((node) => {
        if (this.selectedIds.includes(node.id)) node.groupId = groupId;
      });
      this.persistSoon();
    },
    ungroupSelection() {
      if (!this.selectedIds.length) return;
      this.checkpoint();
      this.nodes.forEach((node) => {
        if (this.selectedIds.includes(node.id)) node.groupId = null;
      });
      this.persistSoon();
    },
    toggleLock() {
      const ids = this.selectedIds.length
        ? this.selectedIds
        : this.selectedConnectorId
          ? [this.selectedConnectorId]
          : [];
      if (!ids.length) return;
      this.checkpoint();
      if (this.selectedConnectorId) {
        this.connectors.forEach((connector) => {
          if (connector.id === this.selectedConnectorId) connector.locked = !connector.locked;
        });
      } else {
        this.nodes.forEach((node) => {
          if (ids.includes(node.id)) node.locked = !node.locked;
        });
      }
      this.persistSoon();
    },
    changeLayer(direction: 'front' | 'back') {
      const ids = this.selectedIds.length
        ? this.selectedIds
        : this.selectedConnectorId
          ? [this.selectedConnectorId]
          : [];
      if (!ids.length) return;
      this.checkpoint();
      if (this.selectedConnectorId) {
        const connector = this.connectors.find((item) => item.id === this.selectedConnectorId);
        if (connector) {
          connector.zIndex =
            direction === 'front'
              ? Math.max(...this.connectors.map((item) => item.zIndex)) + 1
              : Math.min(...this.connectors.map((item) => item.zIndex)) - 1;
        }
      } else {
        this.nodes.forEach((node) => {
          if (ids.includes(node.id)) {
            node.zIndex =
              direction === 'front'
                ? Math.max(...this.nodes.map((item) => item.zIndex)) + 1
                : Math.min(...this.nodes.map((item) => item.zIndex)) - 1;
          }
        });
      }
      this.persistSoon();
    },
    setToolMode(mode: ToolMode) {
      this.toolMode = mode;
    },
    zoomBy(delta: number, origin?: { x: number; y: number }) {
      const nextZoom = Math.min(2.5, Math.max(0.25, this.zoom + delta));
      if (origin) {
        const worldX = (origin.x - this.pan.x) / this.zoom;
        const worldY = (origin.y - this.pan.y) / this.zoom;
        this.pan = {
          x: origin.x - worldX * nextZoom,
          y: origin.y - worldY * nextZoom,
        };
      }
      this.zoom = nextZoom;
    },
    setZoom(zoom: number) {
      this.zoom = Math.min(2.5, Math.max(0.25, zoom));
    },
    fitToView(viewportWidth: number, viewportHeight: number) {
      if (!this.nodes.length) return;
      const minX = Math.min(...this.nodes.map((node) => node.x));
      const minY = Math.min(...this.nodes.map((node) => node.y));
      const maxX = Math.max(...this.nodes.map((node) => node.x + node.width));
      const maxY = Math.max(...this.nodes.map((node) => node.y + node.height));
      const width = maxX - minX;
      const height = maxY - minY;
      this.zoom = Math.min(
        1.4,
        Math.max(0.3, Math.min((viewportWidth - 100) / width, (viewportHeight - 100) / height)),
      );
      this.pan = {
        x: (viewportWidth - width * this.zoom) / 2 - minX * this.zoom,
        y: (viewportHeight - height * this.zoom) / 2 - minY * this.zoom,
      };
    },
    importDocument(document: DiagramDocument) {
      this.checkpoint();
      this.restore(document);
      this.persistSoon();
    },

    // ---- 共编修订 ----

    /** 打开时升级旧数据、接入标签页会话与本地草稿。 */
    initSync() {
      this.tabId = getOrCreateTabId();
      const stored = readStoredDocument();
      if (stored) {
        this.title = stored.title;
        this.nodes = clonePlain(stored.nodes);
        this.connectors = clonePlain(stored.connectors);
        this.revision = stored.revision;
      } else {
        this.revision = 1;
      }
      // 持久化升级后的修订号，让本地草稿与共编起点一致。
      skipRevisionBump = true;
      this.persistSoon();
      syncedBase = clonePlain(this.snapshot());
      lastSuccessfulSnapshot = clonePlain(this.snapshot());
      unsubBroadcast = subscribeToBroadcast((doc, tabId) => this.applyRemoteDocument(doc, tabId));
      unsubStorage = subscribeToStorage((doc) => this.applyRemoteDocument(doc, 'storage'));
      document.addEventListener('visibilitychange', this.handleVisibility);
      window.addEventListener('pageshow', this.handlePageShow);
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    },

    /** 接收其他标签页的文档，三方合并后接入。 */
    applyRemoteDocument(remote: DiagramDocument, remoteTabId: string) {
      if (remoteTabId === this.tabId) return;
      if (valuesEqual(remote, this.snapshot())) return;
      if (!syncedBase) syncedBase = clonePlain(this.snapshot());
      this.syncStatus = 'syncing';
      const result = mergeDocuments(
        syncedBase,
        this.snapshot(),
        remote,
        this.tabId,
        remoteTabId,
      );
      this.mergeConflicts(result.conflicts);
      this.restore(result.document);
      this.revision = result.document.revision;
      syncedBase = clonePlain(result.document);
      skipRevisionBump = true;
      this.persistSoon();
      this.syncStatus = 'idle';
    },

    /** 标签页休眠回来后，先把离开期间的改动合并进来。 */
    mergeAwayChanges() {
      const stored = readStoredDocument();
      if (!stored) return;
      if (valuesEqual(stored, this.snapshot())) return;
      if (!syncedBase) syncedBase = clonePlain(this.snapshot());
      const result = mergeDocuments(syncedBase, this.snapshot(), stored, this.tabId, 'away');
      this.mergeConflicts(result.conflicts);
      this.restore(result.document);
      this.revision = result.document.revision;
      syncedBase = clonePlain(result.document);
      skipRevisionBump = true;
      this.persistSoon();
    },

    mergeConflicts(incoming: FieldConflict[]) {
      const existing = new Set(
        this.conflicts.map(
          (item) =>
            `${item.entityId}:${item.field}:${JSON.stringify(item.localValue)}:${JSON.stringify(item.remoteValue)}`,
        ),
      );
      const fresh = incoming.filter(
        (item) =>
          !existing.has(
            `${item.entityId}:${item.field}:${JSON.stringify(item.localValue)}:${JSON.stringify(item.remoteValue)}`,
          ),
      );
      if (fresh.length) this.conflicts = [...this.conflicts, ...fresh];
    },

    /** 属性面板选择冲突取值后落地。 */
    resolveConflict(conflictId: string, choice: 'local' | 'remote') {
      const conflict = this.conflicts.find((item) => item.id === conflictId);
      if (!conflict) return;
      if (choice === 'remote') {
        if (conflict.field === '__delete__') {
          if (conflict.entityKind === 'node') {
            this.nodes = this.nodes.filter((node) => node.id !== conflict.entityId);
            this.connectors = this.connectors.filter(
              (connector) =>
                connector.fromId !== conflict.entityId && connector.toId !== conflict.entityId,
            );
          } else if (conflict.entityKind === 'connector') {
            this.connectors = this.connectors.filter(
              (connector) => connector.id !== conflict.entityId,
            );
          }
        } else if (conflict.entityKind === 'title') {
          this.title = conflict.remoteValue as string;
        } else if (conflict.entityKind === 'node') {
          const node = this.nodes.find((item) => item.id === conflict.entityId);
          if (node) (node as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
        } else if (conflict.entityKind === 'connector') {
          const connector = this.connectors.find((item) => item.id === conflict.entityId);
          if (connector) {
            (connector as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
          }
        }
      }
      this.conflicts = this.conflicts.filter((item) => item.id !== conflictId);
      this.persistSoon();
    },

    handleVisibility() {
      if (document.visibilityState === 'visible') this.mergeAwayChanges();
    },
    handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) this.mergeAwayChanges();
    },
    handleBeforeUnload() {
      if (persistTimer) {
        window.clearTimeout(persistTimer);
        persistTimer = undefined;
        this.flushPersist();
      }
    },

    /** 事务性落盘：失败则回滚到上次成功的文档，不留改到一半的画布。 */
    flushPersist() {
      if (!skipRevisionBump) this.revision += 1;
      skipRevisionBump = false;
      const doc = this.snapshot();
      const ok = writeDocumentToStorage(doc);
      if (ok) {
        lastSuccessfulSnapshot = clonePlain(doc);
        broadcastDocument(doc, this.tabId);
        this.syncStatus = 'idle';
      } else {
        if (lastSuccessfulSnapshot) {
          this.restore(lastSuccessfulSnapshot);
          this.revision = lastSuccessfulSnapshot.revision;
        }
        this.syncStatus = 'error';
      }
    },
    persistSoon() {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => this.flushPersist(), 180);
    },
  },
});
