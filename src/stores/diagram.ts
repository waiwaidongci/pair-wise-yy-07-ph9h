import { defineStore } from 'pinia';
import { bootstrap, CollabSession, simulateWriteFailure } from '../collab/session';
import type { CollabNotice, CollabOp, ConflictEntry, OpSpec, SaveState } from '../collab/types';
import type {
  DiagramConnector,
  DiagramDocument,
  DiagramNode,
  NodeKind,
  ToolMode,
} from '../types/diagram';
import type { ConnectorField, NodeField } from '../collab/types';
import { DEFAULT_NODE_SIZE } from '../utils/diagramGeometry';

type NodeChanges = Partial<Record<Exclude<NodeField, 'position'>, unknown>>;
type ConnectorChanges = Partial<Record<ConnectorField, unknown>>;

const STORAGE_KEY = 'pair-wise-yy-07-diagram';

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

/** 旧版本地文档：没有修订信封时作为共同起点种子 */
function legacySeed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const document = JSON.parse(raw) as DiagramDocument;
      if (document.version === 1 && Array.isArray(document.nodes)) return document;
    }
  } catch {
    // 损坏的旧数据忽略
  }
  return {
    title: '订单履约架构图',
    nodes: initialNodes(),
    connectors: initialConnectors(),
  };
}

interface HistoryEntry {
  undo: OpSpec[];
  redo: OpSpec[];
}

const seed = legacySeed();

/** 共编会话单例（不进入 Pinia 响应式状态，避免代理 Konva 无关对象） */
let session: CollabSession | null = null;

export const useDiagramStore = defineStore('diagram', {
  state: () => ({
    title: seed.title,
    nodes: clonePlain(seed.nodes) as DiagramNode[],
    connectors: clonePlain(seed.connectors) as DiagramConnector[],
    selectedIds: [] as string[],
    selectedConnectorId: null as string | null,
    activeNodeId: null as string | null,
    toolMode: 'select' as ToolMode,
    zoom: 1,
    pan: { x: 36, y: 24 },
    snapToGrid: true,
    gridSize: 20,
    // —— 共编修订状态 ——
    collabReady: false,
    docId: '' as string,
    tabId: '' as string,
    revision: 1,
    saveState: 'synced' as SaveState,
    peers: 0,
    pendingCount: 0,
    conflictKeys: [] as string[],
    conflictEntries: [] as ConflictEntry[],
    notices: [] as CollabNotice[],
    // 本标签页撤销/重做（基于补偿操作）
    history: { past: [] as HistoryEntry[], future: [] as HistoryEntry[] },
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
    conflictCount: (state) => state.conflictKeys.length,
    nodeConflicts: (state) => (id: string) =>
      state.conflictKeys
        .filter((key) => key.startsWith(`node:${id}:`))
        .map((key) => key.split(':')[2]),
    connectorHasConflict: (state) => (id: string) =>
      state.conflictKeys.some((key) => key.startsWith(`connector:${id}:`)),
    titleHasConflict: (state) => state.conflictKeys.includes('doc:title'),
    getConflictEntry: (state) => (key: string) =>
      state.conflictEntries.find((entry) => entry.key === key) ?? null,
  },
  actions: {
    // ————————————————— 共编会话装配 —————————————————

    initCollab() {
      if (this.collabReady) return;
      const booted = bootstrap({
        title: this.title,
        nodes: this.nodes,
        connectors: this.connectors,
      });
      session = new CollabSession(booted.envelope, booted.recoveredPending, {
        onView: (view) => {
          this.docId = view.docId;
          this.tabId = view.tabId;
          this.revision = view.revision;
          this.saveState = view.saveState;
          this.peers = view.peers;
          this.pendingCount = view.pendingCount;
          this.title = view.title;
          this.nodes = view.nodes;
          this.connectors = view.connectors;
          this.conflictKeys = view.conflicts.map((entry) => entry.key);
          this.conflictEntries = view.conflicts;
          // 远端删除/合并后，清掉失效选择
          const nodeIds = new Set(view.nodes.map((node) => node.id));
          const connectorIds = new Set(view.connectors.map((connector) => connector.id));
          this.selectedIds = this.selectedIds.filter((id) => nodeIds.has(id));
          if (this.selectedConnectorId && !connectorIds.has(this.selectedConnectorId)) {
            this.selectedConnectorId = null;
          }
          if (this.activeNodeId && !nodeIds.has(this.activeNodeId)) this.activeNodeId = null;
        },
        onNotice: (notice) => {
          this.notices.push(notice);
        },
      });
      this.collabReady = true;
      if (booted.migrated) this.notices.push({ kind: 'migrated' });
    },

    dispatch(spec: OpSpec, history?: { undo: OpSpec[] }): CollabOp {
      if (!session) this.initCollab();
      if (history) {
        this.history.past.push({ undo: history.undo, redo: [spec] });
        if (this.history.past.length > 80) this.history.past.shift();
        this.history.future = [];
      }
      return session!.dispatch(spec);
    },

    undo() {
      const entry = this.history.past.pop();
      if (!entry || !session) return;
      entry.undo.forEach((spec) => session!.dispatch(spec));
      this.history.future.push(entry);
    },

    redo() {
      const entry = this.history.future.pop();
      if (!entry || !session) return;
      entry.redo.forEach((spec) => session!.dispatch(spec));
      this.history.past.push(entry);
    },

    async saveNow(): Promise<boolean> {
      if (!session) this.initCollab();
      await session!.flushNow();
      return this.saveState === 'synced';
    },

    retryPending() {
      void session?.flushNow();
    },

    discardPending() {
      session?.discardPending();
    },

    resolveConflict(key: string, value: unknown) {
      session?.resolveConflict(key, value);
    },

    simulateWriteFailure() {
      simulateWriteFailure(1);
    },

    // ————————————————— 选择 / 视图（本地状态，不参与修订） —————————————————

    snapshot(): DiagramDocument {
      return {
        version: 1,
        title: this.title,
        nodes: clonePlain(this.nodes),
        connectors: clonePlain(this.connectors),
        updatedAt: Date.now(),
      };
    },

    /** 拖拽开始前保留撤销点（不立即产生修订，只记录拖前坐标） */
    checkpoint() {
      // 修订由 dragend 时的 node-move 一次性产生；此方法保留给调用方兼容
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

    // ————————————————— 图元编辑（产生修订操作） —————————————————

    addNode(kind: NodeKind, position?: { x: number; y: number }) {
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
      this.dispatch(
        { type: 'node-add', node },
        { undo: [{ type: 'node-delete', ids: [node.id] }] },
      );
      this.selectNode(node.id);
    },

    /** 拖拽中的实时坐标更新：仅改本地视图，不产生修订 */
    updateNode(id: string, patch: Partial<DiagramNode>) {
      const node = this.nodes.find((item) => item.id === id);
      if (!node) return;
      Object.assign(node, patch);
    },

    /** 属性面板提交：产生 node-update 修订 */
    patchNode(id: string, patch: Partial<DiagramNode>) {
      const node = this.nodes.find((item) => item.id === id);
      if (!node) return;
      const changes: NodeChanges = {};
      (Object.keys(patch) as Array<keyof DiagramNode>).forEach((key) => {
        if (key === 'id' || key === 'kind') return;
        changes[key as Exclude<NodeField, 'position'>] = patch[key];
      });
      if (!Object.keys(changes).length) return;
      const before: NodeChanges = {};
      Object.keys(changes).forEach((key) => {
        before[key as Exclude<NodeField, 'position'>] = (node as unknown as Record<string, unknown>)[key];
      });
      this.dispatch(
        { type: 'node-update', targetId: id, changes },
        { undo: [{ type: 'node-update', targetId: id, changes: before }] },
      );
    },

    /**
     * 拖拽/方向键结束：一次性产生 node-move 修订。
     * startPositions 为拖前坐标，用于撤销；没有传则只提交不记录撤销点。
     */
    commitPositions(
      positions: Record<string, { x: number; y: number }>,
      startPositions?: Record<string, { x: number; y: number }>,
    ) {
      const entries = Object.entries(positions);
      if (!entries.length) return;
      // 没动的图元不进修订
      const moved = Object.fromEntries(
        entries.filter(([id, point]) => {
          const node = this.nodes.find((item) => item.id === id);
          return node && (node.x !== point.x || node.y !== point.y);
        }),
      );
      if (!Object.keys(moved).length) return;
      const history = startPositions
        ? {
            undo: [
              {
                type: 'node-move' as const,
                positions: Object.fromEntries(
                  Object.keys(moved).map((id) => [id, startPositions[id]]),
                ),
              },
            ],
          }
        : undefined;
      this.dispatch({ type: 'node-move', positions: moved }, history);
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
      const connector: DiagramConnector = {
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
      };
      this.dispatch(
        { type: 'connector-add', connector },
        { undo: [{ type: 'connector-delete', ids: [connector.id] }] },
      );
    },

    updateConnector(id: string, patch: Partial<DiagramConnector>) {
      const connector = this.connectors.find((item) => item.id === id);
      if (!connector) return;
      Object.assign(connector, patch);
    },

    patchConnector(id: string, patch: Partial<DiagramConnector>) {
      const connector = this.connectors.find((item) => item.id === id);
      if (!connector) return;
      const changes: ConnectorChanges = {};
      (Object.keys(patch) as Array<keyof DiagramConnector>).forEach((key) => {
        if (key === 'id' || key === 'fromId' || key === 'toId') return;
        changes[key as ConnectorField] = patch[key];
      });
      if (!Object.keys(changes).length) return;
      const before: ConnectorChanges = {};
      Object.keys(changes).forEach((key) => {
        before[key as ConnectorField] = (connector as unknown as Record<string, unknown>)[key];
      });
      this.dispatch(
        { type: 'connector-update', targetId: id, changes },
        { undo: [{ type: 'connector-update', targetId: id, changes: before }] },
      );
    },

    setTitle(title: string) {
      const next = title.trim();
      if (!next || next === this.title) return;
      this.dispatch(
        { type: 'title', title: next },
        { undo: [{ type: 'title', title: this.title }] },
      );
    },

    deleteSelection() {
      if (!this.selectedIds.length && !this.selectedConnectorId) return;
      const nodeIds = [...this.selectedIds];
      const connectorIds = this.connectors
        .filter(
          (connector) =>
            connector.id === this.selectedConnectorId ||
            nodeIds.includes(connector.fromId) ||
            nodeIds.includes(connector.toId),
        )
        .map((connector) => connector.id);
      const undoNodes = this.nodes
        .filter((node) => nodeIds.includes(node.id))
        .map((node) => clonePlain(node));
      const undoConnectors = this.connectors
        .filter((connector) => connectorIds.includes(connector.id))
        .map((connector) => clonePlain(connector));
      const undo: OpSpec[] = [];
      if (undoNodes.length) undo.push({ type: 'node-add', node: undoNodes[0] });
      undoNodes.slice(1).forEach((node) => undo.push({ type: 'node-add', node }));
      undoConnectors.forEach((connector) => undo.push({ type: 'connector-add', connector }));
      const specs: OpSpec[] = [];
      if (nodeIds.length) specs.push({ type: 'node-delete', ids: nodeIds });
      if (connectorIds.length) specs.push({ type: 'connector-delete', ids: connectorIds });
      specs.forEach((spec, index) => {
        this.dispatch(spec, index === 0 ? { undo } : undefined);
      });
      this.clearSelection();
    },

    duplicateSelection() {
      if (!this.selectedIds.length) return;
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
      const undo: OpSpec[] = [{
        type: 'node-delete',
        ids: copies.map((node) => node.id),
      }];
      if (connectorCopies.length) {
        undo.push({ type: 'connector-delete', ids: connectorCopies.map((connector) => connector.id) });
      }
      copies.forEach((node, index) => {
        this.dispatch(
          { type: 'node-add', node },
          index === 0 ? { undo } : undefined,
        );
      });
      connectorCopies.forEach((connector) => {
        this.dispatch({ type: 'connector-add', connector });
      });
      this.selectedIds = copies.map((node) => node.id);
      this.activeNodeId = copies.at(-1)?.id ?? null;
    },

    groupSelection() {
      if (this.selectedIds.length < 2) return;
      const groupId = makeId('group');
      const changes: NodeChanges = { groupId };
      this.selectedIds.forEach((id) => {
        this.dispatch({
          type: 'node-update',
          targetId: id,
          changes,
        });
      });
    },

    ungroupSelection() {
      if (!this.selectedIds.length) return;
      this.selectedIds.forEach((id) => {
        this.dispatch({ type: 'node-update', targetId: id, changes: { groupId: null } });
      });
    },

    toggleLock() {
      if (this.selectedConnectorId) {
        const connector = this.connectors.find((item) => item.id === this.selectedConnectorId);
        if (connector) {
          this.patchConnector(connector.id, { locked: !connector.locked });
        }
        return;
      }
      if (!this.selectedIds.length) return;
      const nextLocked = !this.selectedNodes.every((node) => node.locked);
      this.selectedIds.forEach((id) => {
        this.dispatch({ type: 'node-update', targetId: id, changes: { locked: nextLocked } });
      });
    },

    changeLayer(direction: 'front' | 'back') {
      if (this.selectedConnectorId) {
        const connector = this.connectors.find((item) => item.id === this.selectedConnectorId);
        if (!connector) return;
        const zIndex =
          direction === 'front'
            ? Math.max(...this.connectors.map((item) => item.zIndex)) + 1
            : Math.min(...this.connectors.map((item) => item.zIndex)) - 1;
        this.patchConnector(connector.id, { zIndex });
        return;
      }
      if (!this.selectedIds.length) return;
      this.selectedIds.forEach((id, index) => {
        const zIndex =
          direction === 'front'
            ? Math.max(...this.nodes.map((item) => item.zIndex)) + index + 1
            : Math.min(...this.nodes.map((item) => item.zIndex)) - index - 1;
        this.dispatch({ type: 'node-update', targetId: id, changes: { zIndex } });
      });
    },

    importDocument(document: DiagramDocument) {
      // 导入整体替换为新的共同起点（保留同一文档身份，修订号继续向前）
      this.history = { past: [], future: [] };
      this.selectedIds = [];
      this.selectedConnectorId = null;
      this.activeNodeId = null;
      this.dispatch({
        type: 'document-replace',
        title: document.title,
        nodes: clonePlain(document.nodes),
        connectors: clonePlain(document.connectors),
      });
    },

    // ————————————————— 纯本地视图状态 —————————————————

    setToolMode(mode: ToolMode) {
      this.toolMode = mode;
    },
    zoomBy(delta: number, origin?: { x: number; y: number }) {
      const nextZoom = Math.min(2.5, Math.max(0.25, this.zoom + delta));
      if (origin) {
        const worldX = (origin.x - this.pan.x) / this.zoom;
        const worldY = (origin.y - this.pan.y) / this.zoom;
        this.pan = { x: origin.x - worldX * nextZoom, y: origin.y - worldY * nextZoom };
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
      this.zoom = Math.min(1.4, Math.max(0.3, Math.min((viewportWidth - 100) / width, (viewportHeight - 100) / height)));
      this.pan = {
        x: (viewportWidth - width * this.zoom) / 2 - minX * this.zoom,
        y: (viewportHeight - height * this.zoom) / 2 - minY * this.zoom,
      };
    },

    /** 兼容旧调用：所有编辑已即时进入修订队列 */
    persistSoon() {
      void session?.flushNow();
    },
  },
});
