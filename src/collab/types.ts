import type { DiagramConnector, DiagramNode } from '../types/diagram';

/** 图元上可产生共编冲突的字段（position 对应拖动产生的整组坐标） */
export type NodeField =
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'text'
  | 'color'
  | 'locked'
  | 'groupId'
  | 'zIndex'
  | 'fields'
  | 'position';

export type ConnectorField = 'label' | 'color' | 'dashed' | 'fromAnchor' | 'toAnchor';

export type ConflictTarget = 'node' | 'connector' | 'doc';

export interface ConflictSide {
  /** 产生该取值的修订操作 id */
  op: string;
  /** 写入该取值的标签页会话 id */
  tab: string;
  at: number;
  value: unknown;
}

/** 同一字段被两个标签页写入不同取值时保留下来的双方取值 */
export interface ConflictEntry {
  /** 例如 node:node-review:text / connector:c-1:label / doc:title */
  key: string;
  target: ConflictTarget;
  /** doc 级冲突时为 null */
  id: string | null;
  field: string;
  /** 先到的一方，其取值同时是画布上当前显示的取值 */
  first: ConflictSide;
  /** 后到的一方，其取值只停留在冲突面板，不落画布 */
  other: ConflictSide;
}

interface OpBase {
  id: string;
  /** 落盘时分配的修订号；未提交的本地草稿为 0 */
  rev: number;
  tab: string;
  at: number;
}

export type CollabOp = OpBase &
  (
    | { type: 'node-add'; node: DiagramNode }
    | { type: 'node-update'; targetId: string; changes: Partial<Record<Exclude<NodeField, 'position'>, unknown>> }
    | { type: 'node-move'; positions: Record<string, { x: number; y: number }> }
    | { type: 'node-delete'; ids: string[] }
    | { type: 'connector-add'; connector: DiagramConnector }
    | { type: 'connector-update'; targetId: string; changes: Partial<Record<ConnectorField, unknown>> }
    | { type: 'connector-delete'; ids: string[] }
    | { type: 'title'; title: string }
    | { type: 'document-replace'; title: string; nodes: DiagramNode[]; connectors: DiagramConnector[] }
    | { type: 'resolve'; key: string; value: unknown }
  );

/** 动作发起时的操作描述，id / 修订号 / 标签页由会话补齐 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type OpSpec = DistributiveOmit<CollabOp, 'id' | 'rev' | 'tab' | 'at'>;

/** 每个字段最近一次落盘取值的出处，用于判定后到操作是否来自别的标签页 */
export interface Provenance {
  op: string;
  tab: string;
  at: number;
  value: unknown;
}

/** 物化状态：信封快照 + 运行期状态都走这套结构 */
export interface MaterialState {
  title: string;
  nodes: DiagramNode[];
  connectors: DiagramConnector[];
  provenance: Record<string, Provenance>;
  conflicts: ConflictEntry[];
}

/**
 * 跨标签页共享的修订信封，整体一次 setItem 原子落盘。
 * nodes / connectors / title 已是 ops 全部物化后的快照（即“上次成功的文档”）。
 */
export interface CollabEnvelope extends MaterialState {
  format: 'frameflow-collab';
  formatVersion: 1;
  docId: string;
  /** 当前修订号；共同起点为 1，每提交一个操作 +1 */
  rev: number;
  ops: CollabOp[];
  updatedAt: number;
}

export type SaveState = 'synced' | 'saving' | 'error';

export interface ViewSnapshot {
  title: string;
  nodes: DiagramNode[];
  connectors: DiagramConnector[];
  conflicts: ConflictEntry[];
  revision: number;
  docId: string;
  saveState: SaveState;
  peers: number;
  tabId: string;
  pendingCount: number;
}

export type CollabNotice =
  | { kind: 'conflict'; entries: ConflictEntry[] }
  | { kind: 'pruned'; labels: string[] }
  | { kind: 'save-error'; message: string }
  | { kind: 'migrated' };

export function nodeFieldKey(id: string, field: string): string {
  return `node:${id}:${field}`;
}

export function connectorFieldKey(id: string, field: string): string {
  return `connector:${id}:${field}`;
}

export const TITLE_KEY = 'doc:title';

export function parseConflictKey(key: string): {
  target: ConflictTarget;
  id: string | null;
  field: string;
} {
  if (key === TITLE_KEY) return { target: 'doc', id: null, field: 'title' };
  const [target, id, field] = key.split(':');
  return { target: target as ConflictTarget, id: id ?? null, field: field ?? '' };
}
