<script setup lang="ts">
import { Delete, Lock, Unlock, WarningFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, ref, watch } from 'vue';
import { useDiagramStore } from '../stores/diagram';
import type { AnchorSide } from '../types/diagram';

const store = useDiagramStore();
const textDraft = ref('');
const fieldDraft = ref('');

watch(
  () => store.activeNode,
  (node) => {
    textDraft.value = node?.text ?? '';
    fieldDraft.value = node?.fields.join('\n') ?? '';
  },
  { immediate: true, deep: true },
);

const activeConnector = computed(
  () => store.connectors.find((connector) => connector.id === store.selectedConnectorId) ?? null,
);

const FIELD_LABELS: Record<string, string> = {
  position: '位置',
  x: 'X',
  y: 'Y',
  width: '宽度',
  height: '高度',
  text: '名称',
  color: '颜色',
  locked: '锁定',
  groupId: '分组',
  zIndex: '层级',
  fields: '表字段',
  label: '标签',
  dashed: '虚线',
  fromAnchor: '起点锚点',
  toAnchor: '终点锚点',
  title: '文档标题',
};

const ANCHOR_LABELS: Record<string, string> = {
  top: '上',
  right: '右',
  bottom: '下',
  left: '左',
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function formatValue(value: unknown, field: string): string {
  if (value === null || value === undefined) return '空';
  if (field === 'position' && typeof value === 'object') {
    const point = value as { x: number; y: number };
    return `x: ${Math.round(point.x)}, y: ${Math.round(point.y)}`;
  }
  if (field === 'fields' && Array.isArray(value)) {
    return value.length ? value.join(' / ') : '（无字段）';
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (field === 'fromAnchor' || field === 'toAnchor') {
    return ANCHOR_LABELS[String(value)] ?? String(value);
  }
  if (field === 'groupId') return value ? '已分组' : '无分组';
  if (typeof value === 'string') return value || '（空）';
  return String(value);
}

function objectName(entry: { target: string; id: string | null }): string {
  if (entry.target === 'doc') return '文档';
  if (entry.target === 'node') {
    return store.nodes.find((node) => node.id === entry.id)?.text ?? '已删除图元';
  }
  const connector = store.connectors.find((item) => item.id === entry.id);
  return connector?.label ? `连接线「${connector.label}」` : '连接线';
}

function chooseConflict(key: string, value: unknown) {
  store.resolveConflict(key, value);
  ElMessage.success('已采用所选取值，并同步给所有标签页');
}

function patchNode(patch: Parameters<typeof store.patchNode>[1]) {
  if (store.activeNode) store.patchNode(store.activeNode.id, patch);
}

function applyText() {
  if (store.activeNode && textDraft.value.trim() !== store.activeNode.text) {
    patchNode({ text: textDraft.value.trim() || '未命名节点' });
  }
}

function applyFields() {
  if (store.activeNode?.kind !== 'table') return;
  const fields = fieldDraft.value
    .split('\n')
    .map((field) => field.trim())
    .filter(Boolean);
  patchNode({
    fields,
    height: Math.max(120, 76 + fields.length * 34),
  });
}

async function removeSelection() {
  try {
    await ElMessageBox.confirm('删除当前选中的图元和连接线？', '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
    store.deleteSelection();
    ElMessage.success('已删除');
  } catch {
    // 用户取消时保持选择不变。
  }
}
</script>

<template>
  <aside class="properties-panel">
    <div class="panel-title">
      <strong>属性</strong>
      <span>{{ store.selectedIds.length }} 个图元</span>
    </div>

    <!-- 共编冲突：两边取值都保留，等人选定 -->
    <section v-if="store.conflictEntries.length" class="conflict-section">
      <div class="conflict-head">
        <WarningFilled />
        <strong>共编冲突 {{ store.conflictEntries.length }}</strong>
      </div>
      <p class="conflict-hint">两个标签页同时改了同一属性，画布保留先到的取值，请选定最终值：</p>
      <article v-for="entry in store.conflictEntries" :key="entry.key" class="conflict-card">
        <header>
          <span class="conflict-object">{{ objectName(entry) }}</span>
          <span class="conflict-field">{{ fieldLabel(entry.field) }}</span>
        </header>
        <div class="conflict-sides">
          <button
            type="button"
            class="conflict-side"
            :class="{ 'is-own': entry.first.tab === store.tabId, 'is-current': true }"
            @click="chooseConflict(entry.key, entry.first.value)"
          >
            <span class="side-meta">
              先到 · 画布现值
              <em v-if="entry.first.tab === store.tabId">（本标签页）</em>
            </span>
            <span class="side-value">{{ formatValue(entry.first.value, entry.field) }}</span>
            <span class="side-choose">采用此值</span>
          </button>
          <button
            type="button"
            class="conflict-side"
            :class="{ 'is-own': entry.other.tab === store.tabId }"
            @click="chooseConflict(entry.key, entry.other.value)"
          >
            <span class="side-meta">
              后到
              <em v-if="entry.other.tab === store.tabId">（本标签页）</em>
            </span>
            <span class="side-value">{{ formatValue(entry.other.value, entry.field) }}</span>
            <span class="side-choose">采用此值</span>
          </button>
        </div>
      </article>
    </section>

    <template v-if="store.activeNode">
      <div class="property-group">
        <div class="section-label">
          基础信息
          <el-tag
            v-if="store.nodeConflicts(store.activeNode.id).length"
            type="warning"
            size="small"
            effect="plain"
          >
            {{ store.nodeConflicts(store.activeNode.id).length }} 项待裁定
          </el-tag>
        </div>
        <label>
          <span>名称 / 标题</span>
          <el-input v-model="textDraft" @blur="applyText" @keydown.enter="applyText" />
        </label>
        <div class="two-fields">
          <label>
            <span>X</span>
            <el-input-number
              :model-value="Math.round(store.activeNode.x)"
              :min="-2000"
              :max="5000"
              controls-position="right"
              @change="patchNode({ x: Number($event) })"
            />
          </label>
          <label>
            <span>Y</span>
            <el-input-number
              :model-value="Math.round(store.activeNode.y)"
              :min="-2000"
              :max="5000"
              controls-position="right"
              @change="patchNode({ y: Number($event) })"
            />
          </label>
        </div>
        <div class="two-fields">
          <label>
            <span>宽度</span>
            <el-input-number
              :model-value="store.activeNode.width"
              :min="70"
              :max="520"
              controls-position="right"
              @change="patchNode({ width: Number($event) })"
            />
          </label>
          <label>
            <span>高度</span>
            <el-input-number
              :model-value="store.activeNode.height"
              :min="50"
              :max="620"
              controls-position="right"
              @change="patchNode({ height: Number($event) })"
            />
          </label>
        </div>
        <label>
          <span>填充颜色</span>
          <el-color-picker
            :model-value="store.activeNode.color"
            @change="patchNode({ color: String($event) })"
          />
        </label>
      </div>

      <div v-if="store.activeNode.kind === 'table'" class="property-group">
        <div class="section-label">表字段</div>
        <el-input
          v-model="fieldDraft"
          type="textarea"
          :rows="7"
          placeholder="每行一个字段，例如 id BIGINT PK"
          @blur="applyFields"
        />
        <small>支持字段名、类型和 PK / FK 标注，换行自动调整表高。</small>
      </div>

      <div class="property-group">
        <div class="section-label">行为</div>
        <el-button class="full-button" @click="store.toggleLock()">
          <el-icon><Lock v-if="!store.activeNode.locked" /><Unlock v-else /></el-icon>
          {{ store.activeNode.locked ? '解除锁定' : '锁定图元' }}
        </el-button>
        <div class="two-buttons">
          <el-button @click="store.changeLayer('front')">移到顶层</el-button>
          <el-button @click="store.changeLayer('back')">移到底层</el-button>
        </div>
      </div>
    </template>

    <template v-else-if="activeConnector">
      <div class="property-group">
        <div class="section-label">
          连接线
          <el-tag
            v-if="store.connectorHasConflict(activeConnector.id)"
            type="warning"
            size="small"
            effect="plain"
          >
            有待裁定
          </el-tag>
        </div>
        <label>
          <span>标签</span>
          <el-input
            :model-value="activeConnector.label"
            @change="store.patchConnector(activeConnector.id, { label: String($event) })"
          />
        </label>
        <label>
          <span>颜色</span>
          <el-color-picker
            :model-value="activeConnector.color"
            @change="store.patchConnector(activeConnector.id, { color: String($event) })"
          />
        </label>
        <label class="switch-row">
          <span>虚线</span>
          <el-switch
            :model-value="activeConnector.dashed"
            @change="store.patchConnector(activeConnector.id, { dashed: Boolean($event) })"
          />
        </label>
        <label>
          <span>起点锚点</span>
          <el-select
            :model-value="activeConnector.fromAnchor"
            @change="store.patchConnector(activeConnector.id, { fromAnchor: $event as AnchorSide })"
          >
            <el-option label="上" value="top" />
            <el-option label="右" value="right" />
            <el-option label="下" value="bottom" />
            <el-option label="左" value="left" />
          </el-select>
        </label>
        <label>
          <span>终点锚点</span>
          <el-select
            :model-value="activeConnector.toAnchor"
            @change="store.patchConnector(activeConnector.id, { toAnchor: $event as AnchorSide })"
          >
            <el-option label="上" value="top" />
            <el-option label="右" value="right" />
            <el-option label="下" value="bottom" />
            <el-option label="左" value="left" />
          </el-select>
        </label>
      </div>
    </template>

    <div v-else-if="!store.conflictEntries.length" class="empty-properties">
      <strong>未选择对象</strong>
      <span>在画布中选择图元或连接线后，可在此调整文字、位置、颜色、锁定和层级。</span>
    </div>

    <div v-if="store.selectedIds.length || activeConnector" class="danger-zone">
      <el-button type="danger" plain class="full-button" :icon="Delete" @click="removeSelection">
        删除所选对象
      </el-button>
    </div>
  </aside>
</template>
