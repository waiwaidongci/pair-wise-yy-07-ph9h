export type NodeKind = 'rectangle' | 'circle' | 'diamond' | 'table';
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';
export type ToolMode = 'select' | 'connect';

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  locked: boolean;
  groupId: string | null;
  zIndex: number;
  fields: string[];
}

export interface DiagramConnector {
  id: string;
  fromId: string;
  toId: string;
  fromAnchor: AnchorSide;
  toAnchor: AnchorSide;
  label: string;
  color: string;
  dashed: boolean;
  locked: boolean;
  zIndex: number;
}

export interface DiagramDocument {
  version: 1;
  /** 共编修订号；旧数据没有修订号，打开时升级为共同起点 1。 */
  revision: number;
  title: string;
  nodes: DiagramNode[];
  connectors: DiagramConnector[];
  updatedAt: number;
}

/** 两处同时编辑同一字段时保留的冲突取值，留在属性面板等人选定。 */
export interface FieldConflict {
  id: string;
  entityKind: 'node' | 'connector' | 'title';
  entityId: string;
  field: string;
  fieldLabel: string;
  localValue: unknown;
  remoteValue: unknown;
  localTab: string;
  remoteTab: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface Point {
  x: number;
  y: number;
}

export interface AnchorPoint extends Point {
  side: AnchorSide;
}

export interface AlignmentGuide {
  orientation: 'vertical' | 'horizontal';
  position: number;
  start: number;
  end: number;
  label: string;
}
