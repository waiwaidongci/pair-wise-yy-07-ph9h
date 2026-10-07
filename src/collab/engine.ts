import type {
  CollabEnvelope,
  CollabOp,
  ConflictEntry,
  ConflictSide,
  MaterialState,
  NodeField,
  Provenance,
} from './types';
import { connectorFieldKey, nodeFieldKey, parseConflictKey, TITLE_KEY } from './types';

export const MAX_RETAINED_OPS = 300;

export function makeOpId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === 'object' && typeof right === 'object' && left !== null && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function sideOf(op: CollabOp, value: unknown): ConflictSide {
  return { op: op.id, tab: op.tab, at: op.at, value: clonePlain(value) };
}

/**
 * 把一次字段写入并入物化状态。
 * 规则：同一标签页在当前值基础上继续改 → 直接覆盖；
 * 别的标签页在旧值基础上改成不同取值 → 后到不覆盖先到，双方取值留冲突。
 */
function applyFieldWrite(
  state: MaterialState,
  op: CollabOp,
  key: string,
  value: unknown,
): ConflictEntry | null {
  const { target, id, field } = parseConflictKey(key);
  const owner = state.provenance[key];
  const conflictIndex = state.conflicts.findIndex((entry) => entry.key === key);

  if (conflictIndex >= 0) {
    const existing = state.conflicts[conflictIndex];
    // 已在冲突中：同标签页覆盖自己那一侧；异标签页替换后到侧并刷新时间
    if (existing.other.tab === op.tab) {
      existing.other = sideOf(op, value);
    } else if (existing.first.tab === op.tab) {
      // 原“先到方”再次写入：用新取值替换先到侧并直接落到画布
      existing.first = sideOf(op, value);
      writeFieldValue(state, key, value);
      state.provenance[key] = { op: op.id, tab: op.tab, at: op.at, value: clonePlain(value) };
    } else {
      existing.other = sideOf(op, value);
    }
    return existing;
  }

  if (owner && owner.tab !== op.tab && !sameValue(owner.value, value)) {
    const currentValue = readFieldValue(state, key);
    if (sameValue(currentValue, value)) {
      // 与画布现值一致，只是出处不同：转交出处，不产生冲突
      state.provenance[key] = { op: op.id, tab: op.tab, at: op.at, value: clonePlain(value) };
      return null;
    }
    const entry: ConflictEntry = {
      key,
      target,
      id,
      field,
      first: { op: owner.op, tab: owner.tab, at: owner.at, value: clonePlain(owner.value) },
      other: sideOf(op, value),
    };
    state.conflicts.push(entry);
    return entry;
  }

  writeFieldValue(state, key, value);
  state.provenance[key] = { op: op.id, tab: op.tab, at: op.at, value: clonePlain(value) };
  return null;
}

function readFieldValue(state: MaterialState, key: string): unknown {
  const { target, id, field } = parseConflictKey(key);
  if (target === 'doc') return state.title;
  if (target === 'node') {
    const node = state.nodes.find((item) => item.id === id);
    if (!node) return undefined;
    if (field === 'position') return { x: node.x, y: node.y };
    return node[field as Exclude<NodeField, 'position'>];
  }
  const connector = state.connectors.find((item) => item.id === id);
  return connector?.[field as keyof (typeof state.connectors)[number]];
}

function writeFieldValue(state: MaterialState, key: string, value: unknown) {
  const { target, id, field } = parseConflictKey(key);
  if (target === 'doc') {
    state.title = String(value);
    return;
  }
  if (target === 'node') {
    const node = state.nodes.find((item) => item.id === id);
    if (!node) return;
    if (field === 'position') {
      node.x = Number((value as { x: number }).x);
      node.y = Number((value as { y: number }).y);
      return;
    }
    (node as unknown as Record<string, unknown>)[field] = value;
    return;
  }
  const connector = state.connectors.find((item) => item.id === id);
  if (connector) (connector as unknown as Record<string, unknown>)[field] = value;
}

/** 删除结构性操作的冲突与出处 */
function cleanupTarget(state: MaterialState, prefix: string, deleteKeys: string[] = []) {
  const dead = new Set(deleteKeys);
  state.conflicts = state.conflicts.filter((entry) => {
    if (dead.has(entry.key)) return false;
    if (entry.key.startsWith(prefix)) return false;
    return true;
  });
  Object.keys(state.provenance).forEach((key) => {
    if (dead.has(key) || key.startsWith(prefix)) delete state.provenance[key];
  });
}

/** 剪除指向已不存在图元的连接线；返回被剪除的连接线标签 */
export function pruneDanglingConnectors(state: MaterialState): string[] {
  const nodeIds = new Set(state.nodes.map((node) => node.id));
  const dangling = state.connectors.filter(
    (connector) => !nodeIds.has(connector.fromId) || !nodeIds.has(connector.toId),
  );
  if (!dangling.length) return [];
  const deadIds = new Set(dangling.map((connector) => connector.id));
  state.connectors = state.connectors.filter((connector) => !deadIds.has(connector.id));
  deadIds.forEach((id) => cleanupTarget(state, connectorFieldKey(id, '')));
  return dangling.map((connector) => connector.label || connector.id);
}

export interface ApplyResult {
  newConflicts: ConflictEntry[];
  /** 本次操作新剪除的失效连接线标签 */
  prunedLabels: string[];
}

/** 把一个修订操作物化为状态变更；幂等：重复应用同一 op 不产生重复效果 */
export function applyOp(state: MaterialState, op: CollabOp): ApplyResult {
  const result: ApplyResult = { newConflicts: [], prunedLabels: [] };

  switch (op.type) {
    case 'node-add': {
      if (state.nodes.some((node) => node.id === op.node.id)) break;
      state.nodes.push(clonePlain(op.node));
      break;
    }
    case 'node-update': {
      const node = state.nodes.find((item) => item.id === op.targetId);
      if (!node) break;
      (Object.entries(op.changes) as Array<[string, unknown]>).forEach(([field, value]) => {
        if (field === 'x' || field === 'y') return; // 坐标冲突归并到 position
        const entry = applyFieldWrite(state, op, nodeFieldKey(op.targetId, field), value);
        if (entry && !result.newConflicts.some((item) => item.key === entry.key)) {
          result.newConflicts.push(entry);
        }
      });
      // x/y 坐标合成 position 一个冲突点，避免两个字段各打一次架
      if ('x' in op.changes || 'y' in op.changes) {
        const current = state.nodes.find((item) => item.id === op.targetId);
        if (current) {
          const position = {
            x: 'x' in op.changes ? Number(op.changes.x) : current.x,
            y: 'y' in op.changes ? Number(op.changes.y) : current.y,
          };
          const entry = applyFieldWrite(state, op, nodeFieldKey(op.targetId, 'position'), position);
          if (entry && !result.newConflicts.some((item) => item.key === entry.key)) {
            result.newConflicts.push(entry);
          }
        }
      }
      break;
    }
    case 'node-move': {
      const targets = Object.entries(op.positions).filter(([id]) =>
        state.nodes.some((node) => node.id === id),
      );
      targets.forEach(([id, point]) => {
        const entry = applyFieldWrite(state, op, nodeFieldKey(id, 'position'), point);
        if (entry && !result.newConflicts.some((item) => item.key === entry.key)) {
          result.newConflicts.push(entry);
        }
      });
      break;
    }
    case 'node-delete': {
      const ids = new Set(op.ids);
      const cascadedConnectors = state.connectors.filter(
        (connector) => ids.has(connector.fromId) || ids.has(connector.toId),
      );
      const deletedConnectorIds = new Set(cascadedConnectors.map((connector) => connector.id));
      state.nodes = state.nodes.filter((node) => !ids.has(node.id));
      state.connectors = state.connectors.filter((connector) => !deletedConnectorIds.has(connector.id));
      op.ids.forEach((id) => cleanupTarget(state, nodeFieldKey(id, '')));
      deletedConnectorIds.forEach((id) => cleanupTarget(state, connectorFieldKey(id, '')));
      // 级联失效的连接线计入报告，供“别标签页删了图元”的合并提示使用
      result.prunedLabels.push(...cascadedConnectors.map((connector) => connector.label || connector.id));
      break;
    }
    case 'connector-add': {
      if (state.connectors.some((connector) => connector.id === op.connector.id)) break;
      // 起点或终点已不存在：该连接线不复活
      if (
        !state.nodes.some((node) => node.id === op.connector.fromId) ||
        !state.nodes.some((node) => node.id === op.connector.toId)
      ) {
        break;
      }
      state.connectors.push(clonePlain(op.connector));
      break;
    }
    case 'connector-update': {
      const connector = state.connectors.find((item) => item.id === op.targetId);
      if (!connector) break;
      (Object.entries(op.changes) as Array<[string, unknown]>).forEach(([field, value]) => {
        const entry = applyFieldWrite(state, op, connectorFieldKey(op.targetId, field), value);
        if (entry && !result.newConflicts.some((item) => item.key === entry.key)) {
          result.newConflicts.push(entry);
        }
      });
      break;
    }
    case 'connector-delete': {
      const ids = new Set(op.ids);
      state.connectors = state.connectors.filter((connector) => !ids.has(connector.id));
      ids.forEach((id) => cleanupTarget(state, connectorFieldKey(id, '')));
      break;
    }
    case 'title': {
      const entry = applyFieldWrite(state, op, TITLE_KEY, op.title);
      if (entry) result.newConflicts.push(entry);
      break;
    }
    case 'resolve': {
      const index = state.conflicts.findIndex((entry) => entry.key === op.key);
      if (index < 0) break;
      writeFieldValue(state, op.key, op.value);
      const provenance: Provenance = {
        op: op.id,
        tab: op.tab,
        at: op.at,
        value: clonePlain(op.value),
      };
      state.provenance[op.key] = provenance;
      state.conflicts.splice(index, 1);
      break;
    }
    case 'document-replace': {
      state.title = op.title;
      state.nodes = clonePlain(op.nodes);
      state.connectors = clonePlain(op.connectors);
      state.provenance = {};
      state.conflicts = [];
      result.prunedLabels = pruneDanglingConnectors(state);
      break;
    }
  }

  // 任何操作后都保证不存在指向已删图元的连接线
  result.prunedLabels = [...result.prunedLabels, ...pruneDanglingConnectors(state)];
  return result;
}

/** 从空状态回放全部操作（含冲突重建） */
export function materialize(ops: CollabOp[], initial: MaterialState): MaterialState {
  const state: MaterialState = {
    title: initial.title,
    nodes: clonePlain(initial.nodes),
    connectors: clonePlain(initial.connectors),
    provenance: {},
    conflicts: [],
  };
  ops.forEach((op) => applyOp(state, op));
  return state;
}

export function emptyState(): MaterialState {
  return { title: '', nodes: [], connectors: [], provenance: {}, conflicts: [] };
}

/** 以信封里的快照为基准、叠加尚未落盘的本地操作，得到该标签页当前所见 */
export function buildView(envelope: CollabEnvelope, pending: CollabOp[]): MaterialState {
  const state: MaterialState = {
    title: envelope.title,
    nodes: clonePlain(envelope.nodes),
    connectors: clonePlain(envelope.connectors),
    provenance: clonePlain(envelope.provenance),
    conflicts: clonePlain(envelope.conflicts),
  };
  pending.forEach((op) => applyOp(state, op));
  return state;
}

/** 生成共同起点信封：旧版无修订号文档在这里升级成 rev 1 */
export function createEnvelope(input: {
  docId: string;
  title: string;
  nodes: MaterialState['nodes'];
  connectors: MaterialState['connectors'];
}): CollabEnvelope {
  const state: MaterialState = {
    title: input.title,
    nodes: clonePlain(input.nodes),
    connectors: clonePlain(input.connectors),
    provenance: {},
    conflicts: [],
  };
  // 旧数据里可能本来就有指向缺失图元的断线，升级时一并清掉
  pruneDanglingConnectors(state);
  return {
    format: 'frameflow-collab',
    formatVersion: 1,
    docId: input.docId,
    rev: 1,
    title: state.title,
    nodes: state.nodes,
    connectors: state.connectors,
    provenance: {},
    conflicts: [],
    ops: [],
    updatedAt: Date.now(),
  };
}

/** 校验读到的内容是不是合法信封 */
export function isEnvelope(value: unknown): value is CollabEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.format === 'frameflow-collab' &&
    typeof envelope.rev === 'number' &&
    typeof envelope.title === 'string' &&
    Array.isArray(envelope.nodes) &&
    Array.isArray(envelope.connectors) &&
    Array.isArray(envelope.ops) &&
    typeof envelope.provenance === 'object' &&
    Array.isArray(envelope.conflicts)
  );
}
