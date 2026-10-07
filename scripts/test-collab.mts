/**
 * 共编修订核心逻辑的 Node 端验证（不依赖 DOM）：
 * 跑引擎在内存里模拟两个标签页的并发编辑。
 */
import { applyOp, buildView, createEnvelope, emptyState, makeOpId, pruneDanglingConnectors } from '../src/collab/engine.ts';
import type { CollabEnvelope, CollabOp, MaterialState } from '../src/collab/types.ts';

let failures = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

function op(partial: Omit<CollabOp, 'id' | 'rev' | 'tab' | 'at'> & Partial<Pick<CollabOp, 'tab' | 'rev'>>): CollabOp {
  return {
    id: makeOpId(),
    rev: 0,
    tab: partial.tab ?? 'tab-a',
    at: Date.now(),
    ...partial,
  } as CollabOp;
}

function seedEnvelope(): CollabEnvelope {
  const envelope = createEnvelope({
    docId: 'doc-test',
    title: '测试图',
    nodes: [
      { id: 'n1', kind: 'rectangle', x: 10, y: 10, width: 100, height: 60, text: 'A', color: '#fff', locked: false, groupId: null, zIndex: 1, fields: [] },
      { id: 'n2', kind: 'rectangle', x: 300, y: 10, width: 100, height: 60, text: 'B', color: '#fff', locked: false, groupId: null, zIndex: 2, fields: [] },
      { id: 't1', kind: 'table', x: 10, y: 200, width: 200, height: 150, text: 'orders', color: '#fff', locked: false, groupId: null, zIndex: 3, fields: ['id PK', 'amount INT'] },
    ],
    connectors: [
      { id: 'c1', fromId: 'n1', toId: 'n2', fromAnchor: 'right', toAnchor: 'left', label: 'L1', color: '#666', dashed: false, locked: false, zIndex: 1 },
    ],
  });
  return envelope;
}

function stateFrom(envelope: CollabEnvelope): MaterialState {
  return {
    title: envelope.title,
    nodes: JSON.parse(JSON.stringify(envelope.nodes)),
    connectors: JSON.parse(JSON.stringify(envelope.connectors)),
    provenance: JSON.parse(JSON.stringify(envelope.provenance)),
    conflicts: JSON.parse(JSON.stringify(envelope.conflicts)),
  };
}

console.log('1) 旧文档升级为共同起点');
{
  const envelope = seedEnvelope();
  assert(envelope.rev === 1, '共同起点修订号为 1');
  assert(envelope.ops.length === 0, '起点没有历史操作');
  assert(envelope.conflicts.length === 0, '起点没有冲突');
}

console.log('2) 同字段并发编辑：后到不覆盖先到，双方取值都留下');
{
  const state = stateFrom(seedEnvelope());
  applyOp(state, op({ type: 'node-update', targetId: 'n1', changes: { text: 'A-标签页1' }, tab: 'tab-a' }));
  const result = applyOp(state, op({ type: 'node-update', targetId: 'n1', changes: { text: 'A-标签页2' }, tab: 'tab-b' }));
  const node = state.nodes.find((n) => n.id === 'n1')!;
  assert(node.text === 'A-标签页1', '画布保留先到的取值');
  assert(result.newConflicts.length === 1, '后到操作产生 1 个冲突');
  const conflict = state.conflicts[0];
  assert(conflict.first.value === 'A-标签页1', '冲突先到侧=标签页1的值');
  assert(conflict.other.value === 'A-标签页2', '冲突后到侧=标签页2的值');
  assert(conflict.first.tab === 'tab-a' && conflict.other.tab === 'tab-b', '两侧出处分别记录标签页');
}

console.log('3) 同标签页连续编辑自己的值不产生冲突');
{
  const state = stateFrom(seedEnvelope());
  applyOp(state, op({ type: 'node-update', targetId: 'n1', changes: { color: '#f00' }, tab: 'tab-a' }));
  applyOp(state, op({ type: 'node-update', targetId: 'n1', changes: { color: '#0f0' }, tab: 'tab-a' }));
  assert(state.conflicts.length === 0, '同标签页连续改不冲突');
  assert(state.nodes.find((n) => n.id === 'n1')!.color === '#0f0', '最新值落画布');
}

console.log('4) 改不同字段互不冲突（字段级合并）');
{
  const state = stateFrom(seedEnvelope());
  applyOp(state, op({ type: 'node-update', targetId: 'n1', changes: { text: '改名' }, tab: 'tab-a' }));
  applyOp(state, op({ type: 'node-update', targetId: 'n1', changes: { color: '#123' }, tab: 'tab-b' }));
  assert(state.conflicts.length === 0, '不同字段无冲突');
  const node = state.nodes.find((n) => n.id === 'n1')!;
  assert(node.text === '改名' && node.color === '#123', '两边字段改动都生效');
}

console.log('5) 表字段并发编辑也走冲突保留');
{
  const state = stateFrom(seedEnvelope());
  applyOp(state, op({ type: 'node-update', targetId: 't1', changes: { fields: ['id PK', 'a'] }, tab: 'tab-a' }));
  applyOp(state, op({ type: 'node-update', targetId: 't1', changes: { fields: ['id PK', 'b'] }, tab: 'tab-b' }));
  assert(state.conflicts.some((c) => c.key === 'node:t1:fields'), '表字段冲突被记录');
  assert(JSON.stringify(state.nodes.find((n) => n.id === 't1')!.fields) === JSON.stringify(['id PK', 'a']), '先到字段落画布');
}

console.log('6) resolve 操作选定后冲突消失、值落画布，并可再次同步');
{
  const state = stateFrom(seedEnvelope());
  applyOp(state, op({ type: 'node-update', targetId: 'n1', changes: { text: 'V1' }, tab: 'tab-a' }));
  const other = op({ type: 'node-update', targetId: 'n1', changes: { text: 'V2' }, tab: 'tab-b' });
  applyOp(state, other);
  assert(state.conflicts.length === 1, '前置：存在 1 个冲突');
  applyOp(state, op({ type: 'resolve', key: 'node:n1:text', value: 'V2', tab: 'tab-a' }));
  assert(state.conflicts.length === 0, '裁定后冲突移除');
  assert(state.nodes.find((n) => n.id === 'n1')!.text === 'V2', '选定的值落画布');
  // 第三方重放到 resolve 也能得到一致状态
  const state2 = stateFrom(seedEnvelope());
  applyOp(state2, op({ type: 'node-update', targetId: 'n1', changes: { text: 'V1' }, tab: 'tab-a' }));
  applyOp(state2, other);
  applyOp(state2, op({ type: 'resolve', key: 'node:n1:text', value: 'V2', tab: 'tab-a' }));
  assert(state2.nodes.find((n) => n.id === 'n1')!.text === 'V2' && state2.conflicts.length === 0, '重放修订日志得到一致结果');
}

console.log('7) 删除图元后牵连连接线被剪除，不残留悬空线');
{
  const state = stateFrom(seedEnvelope());
  const result = applyOp(state, op({ type: 'node-delete', ids: ['n2'] }));
  assert(!state.connectors.some((c) => c.id === 'c1'), '指向被删图元的连接线已移除');
  assert(result.prunedLabels.includes('L1'), '剪枝报告包含连接线标签');
  assert(!state.conflicts.some((c) => c.key.startsWith('connector:c1:')), '连接线冲突一并清理');
}

console.log('8) 迟到的 connector-add 不复活悬空线');
{
  const state = stateFrom(seedEnvelope());
  applyOp(state, op({ type: 'node-delete', ids: ['n2'] }));
  applyOp(state, op({
    type: 'connector-add',
    connector: { id: 'c-late', fromId: 'n1', toId: 'n2', fromAnchor: 'right', toAnchor: 'left', label: '迟到', color: '#000', dashed: false, locked: false, zIndex: 9 },
    tab: 'tab-b',
  }));
  assert(!state.connectors.some((c) => c.id === 'c-late'), '端点不存在的连接线不会被加回');
}

console.log('9) 休眠期间远端改动：信封快照 + 本地草稿重放得到合并视图');
{
  // 标签页1提交：改 n1 文本
  const envelopeA = seedEnvelope();
  const viewAState: MaterialState = stateFrom(envelopeA);
  applyOp(viewAState, op({ type: 'node-update', targetId: 'n1', changes: { text: '远端改名' }, tab: 'tab-a' }));
  Object.assign(envelopeA, {
    title: viewAState.title,
    nodes: viewAState.nodes,
    connectors: viewAState.connectors,
    provenance: viewAState.provenance,
    conflicts: viewAState.conflicts,
    rev: 2,
  });
  envelopeA.ops.push(op({ type: 'node-update', targetId: 'n1', changes: { text: '远端改名' }, tab: 'tab-a' }));
  // 休眠的标签页2带着改 n2 颜色的草稿回来
  const localDraft = op({ type: 'node-update', targetId: 'n2', changes: { color: '#abc' }, tab: 'tab-b' });
  const merged = buildView(envelopeA, [localDraft]);
  assert(merged.nodes.find((n) => n.id === 'n1')!.text === '远端改名', '离开期间远端的改名已合并');
  assert(merged.nodes.find((n) => n.id === 'n2')!.color === '#abc', '本地草稿仍保留并叠加');
  assert(merged.conflicts.length === 0, '改不同对象无冲突');
}

console.log('10) 并发移动同一图元：position 合成单一冲突点');
{
  const state = stateFrom(seedEnvelope());
  applyOp(state, op({ type: 'node-move', positions: { n1: { x: 50, y: 50 } }, tab: 'tab-a' }));
  applyOp(state, op({ type: 'node-move', positions: { n1: { x: 90, y: 90 } }, tab: 'tab-b' }));
  assert(state.nodes.find((n) => n.id === 'n1')!.x === 50, '先到位置保留');
  assert(state.conflicts.filter((c) => c.key === 'node:n1:position').length === 1, '位置只有一个冲突条目');
}

console.log('11) 幂等：同一操作重放不产生重复图元/连接线');
{
  const state = stateFrom(seedEnvelope());
  const addOp = op({
    type: 'node-add',
    node: { id: 'n-new', kind: 'circle', x: 0, y: 0, width: 80, height: 80, text: 'X', color: '#fff', locked: false, groupId: null, zIndex: 9, fields: [] },
  });
  applyOp(state, addOp);
  applyOp(state, addOp);
  assert(state.nodes.filter((n) => n.id === 'n-new').length === 1, 'node-add 重放不重复');
}

console.log('12) 旧数据含悬空连接线时升级即清理');
{
  const envelope = createEnvelope({
    docId: 'doc-dirty',
    title: '脏数据',
    nodes: [{ id: 'only', kind: 'rectangle', x: 0, y: 0, width: 10, height: 10, text: 'x', color: '', locked: false, groupId: null, zIndex: 1, fields: [] }],
    connectors: [
      { id: 'ghost', fromId: 'only', toId: 'missing', fromAnchor: 'right', toAnchor: 'left', label: '鬼线', color: '', dashed: false, locked: false, zIndex: 1 },
    ],
  });
  assert(envelope.connectors.length === 0, '升级时悬空连接线被清理');
}

console.log('13) pruneDanglingConnectors 直接调用');
{
  const state: MaterialState = emptyState();
  state.nodes = stateFrom(seedEnvelope()).nodes;
  state.connectors = [
    { id: 'ok', fromId: 'n1', toId: 'n2', fromAnchor: 'right', toAnchor: 'left', label: '', color: '', dashed: false, locked: false, zIndex: 1 },
    { id: 'bad', fromId: 'n1', toId: 'gone', fromAnchor: 'right', toAnchor: 'left', label: '坏', color: '', dashed: false, locked: false, zIndex: 2 },
  ];
  const labels = pruneDanglingConnectors(state);
  assert(labels.includes('坏') && state.connectors.length === 1, '只剪除悬空线，保留有效线');
}

if (failures > 0) {
  console.error(`\n${failures} 项验证失败`);
  process.exit(1);
}
console.log('\n全部共编核心验证通过');
