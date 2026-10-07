<script setup lang="ts">
import {
  Bottom,
  Connection,
  CopyDocument,
  Delete,
  Document,
  Download,
  Finished,
  Grid,
  Lock,
  Rank,
  RefreshLeft,
  RefreshRight,
  Top,
  Unlock,
  Upload,
  WarningFilled,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { nextTick, ref, watch } from 'vue';
import DiagramCanvas from '../components/DiagramCanvas.vue';
import PropertiesPanel from '../components/PropertiesPanel.vue';
import ShapePalette from '../components/ShapePalette.vue';
import { useDiagramStore } from '../stores/diagram';
import type { DiagramDocument } from '../types/diagram';

const store = useDiagramStore();
const importInput = ref<HTMLInputElement | null>(null);
const titleDraft = ref(store.title);

watch(
  () => store.title,
  (title) => {
    titleDraft.value = title;
  },
);

// 标题冲突期间不强行覆盖用户正在输入的草稿
watch(
  () => store.titleHasConflict,
  () => {
    if (!store.titleHasConflict) titleDraft.value = store.title;
  },
);

function commitTitle() {
  const value = titleDraft.value.trim();
  if (!value) {
    titleDraft.value = store.title;
    return;
  }
  if (value !== store.title) store.setTitle(value);
  else titleDraft.value = store.title;
}

async function saveNow() {
  const ok = await store.saveNow();
  if (ok) ElMessage.success('修订已写入共享文档');
}

function retrySave() {
  store.retryPending();
}

function discardLocalEdits() {
  store.discardPending();
  ElMessage.info('已放弃未提交修改，画布恢复到上次成功保存的文档');
}

function openImport() {
  importInput.value?.click();
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const document = JSON.parse(await file.text()) as DiagramDocument;
    if (document.version !== 1 || !Array.isArray(document.nodes) || !Array.isArray(document.connectors)) {
      throw new Error('文件结构不符合 FrameFlow v1 格式');
    }
    store.importDocument(document);
    ElMessage.success(`已导入 ${file.name}，成为新的共编起点`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导入失败');
  } finally {
    input.value = '';
  }
}

function run(action: () => void, message?: string) {
  action();
  if (message) ElMessage.success(message);
  void nextTick();
}

// 共编事件通知（冲突、剪枝、写失败、旧数据迁移）
const notifiedPruned = new Set<string>();
watch(
  () => store.notices.length,
  () => {
    const notices = store.notices.splice(0, store.notices.length);
    notices.forEach((notice) => {
      if (notice.kind === 'conflict') {
        ElMessage.warning(`检测到 ${notice.entries.length} 处共编冲突，请在右侧属性面板裁定`);
      } else if (notice.kind === 'save-error') {
        ElMessage.error(`写入失败：${notice.message}，修改保留在本地草稿`);
      } else if (notice.kind === 'migrated') {
        ElMessage.success('已把旧版本文档升级为共编修订共同起点（rev 1）');
      } else if (notice.kind === 'pruned') {
        notice.labels.forEach((label) => {
          if (!notifiedPruned.has(label)) {
            notifiedPruned.add(label);
            ElMessage.info(`连接线「${label}」因端点图元已删除而失效，已自动移除`);
          }
        });
      }
    });
  },
);
</script>

<template>
  <div class="editor-shell">
    <header class="editor-header">
      <div class="editor-brand">
        <span class="brand-mark"><Grid /></span>
        <div>
          <strong>FrameFlow</strong>
          <small>流程与数据模型工作台</small>
        </div>
      </div>
      <div class="document-title">
        <el-input
          v-model="titleDraft"
          class="title-input"
          @change="commitTitle"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <el-badge
          v-if="store.titleHasConflict"
          type="warning"
          class="title-conflict-badge"
          value="冲突"
        />
        <span class="save-state" :class="`is-${store.saveState}`">
          <Finished v-if="store.saveState === 'synced'" />
          <span v-else-if="store.saveState === 'saving'" class="save-spinner" />
          <WarningFilled v-else />
          {{
            store.saveState === 'synced'
              ? `修订 #${store.revision} 已同步`
              : store.saveState === 'saving'
                ? `正在提交 #${store.revision + 1}…`
                : '写入失败'
          }}
        </span>
      </div>
      <div class="header-actions">
        <router-link class="guide-link" to="/guide">快捷键说明</router-link>
        <el-button :icon="Upload" @click="openImport">导入 JSON</el-button>
        <el-button type="primary" :icon="Download" @click="saveNow">保存</el-button>
        <input
          ref="importInput"
          class="hidden-input"
          type="file"
          accept="application/json,.json"
          @change="importFile"
        >
      </div>
    </header>

    <!-- 写入失败恢复条：画布保持上次成功的文档，可重试或放弃本地修改 -->
    <div v-if="store.saveState === 'error'" class="save-error-banner">
      <WarningFilled />
      <span>
        写入共享文档失败，画布仍停留在上次成功保存的修订 #{{ store.revision }}，
        本地有 {{ store.pendingCount }} 项未提交修改。
      </span>
      <el-button size="small" type="primary" @click="retrySave">重试写入</el-button>
      <el-button size="small" @click="discardLocalEdits">放弃本地修改</el-button>
    </div>

    <section class="editor-toolbar">
      <div class="tool-group">
        <el-tooltip content="撤销 Ctrl/Cmd + Z">
          <el-button
            :icon="RefreshLeft"
            :disabled="!store.canUndo"
            @click="run(() => store.undo())"
          />
        </el-tooltip>
        <el-tooltip content="重做 Ctrl/Cmd + Shift + Z">
          <el-button
            :icon="RefreshRight"
            :disabled="!store.canRedo"
            @click="run(() => store.redo())"
          />
        </el-tooltip>
      </div>
      <span class="toolbar-divider" />
      <div class="tool-group">
        <el-button
          :type="store.toolMode === 'select' ? 'primary' : 'default'"
          :icon="Rank"
          @click="store.setToolMode('select')"
        >
          选择
        </el-button>
        <el-button
          :type="store.toolMode === 'connect' ? 'primary' : 'default'"
          :icon="Connection"
          @click="store.setToolMode('connect')"
        >
          连线
        </el-button>
      </div>
      <span class="toolbar-divider" />
      <div class="tool-group">
        <el-button :icon="CopyDocument" @click="run(() => store.duplicateSelection(), '已复制所选图元')">
          复制
        </el-button>
        <el-button
          :icon="store.activeNode?.locked ? Unlock : Lock"
          @click="run(() => store.toggleLock())"
        >
          {{ store.activeNode?.locked ? '解锁' : '锁定' }}
        </el-button>
        <el-dropdown trigger="click">
          <el-button :icon="Rank">层级</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item :icon="Top" @click="run(() => store.changeLayer('front'))">
                移到顶层
              </el-dropdown-item>
              <el-dropdown-item :icon="Bottom" @click="run(() => store.changeLayer('back'))">
                移到底层
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <span class="toolbar-divider" />
      <div class="tool-group">
        <el-button @click="run(() => store.groupSelection(), '已分组')">分组</el-button>
        <el-button @click="run(() => store.ungroupSelection(), '已取消分组')">取消分组</el-button>
      </div>
      <span class="toolbar-spacer" />
      <span v-if="store.conflictCount" class="conflict-toolbar-badge">
        <WarningFilled />
        {{ store.conflictCount }} 处共编冲突待裁定（见右侧面板）
      </span>
      <el-button
        type="danger"
        plain
        :icon="Delete"
        :disabled="!store.selectedIds.length && !store.selectedConnectorId"
        @click="run(() => store.deleteSelection())"
      >
        删除
      </el-button>
    </section>

    <main class="editor-workspace">
      <ShapePalette />
      <DiagramCanvas />
      <PropertiesPanel />
    </main>

    <footer class="editor-status">
      <span><Document /> {{ store.nodes.length }} 个图元</span>
      <span><Connection /> {{ store.connectors.length }} 条连接</span>
      <span>选择 {{ store.selectedIds.length }} 项</span>
      <span class="status-spacer" />
      <span>修订 rev {{ store.revision }}</span>
      <span>
        <i
          class="status-dot"
          :class="store.saveState === 'error' ? 'is-error' : store.saveState === 'saving' ? 'is-saving' : 'is-ok'"
        />
        {{ store.saveState === 'synced' ? '已同步' : store.saveState === 'saving' ? '提交中' : '写失败' }}
      </span>
      <span class="status-online">
        <i />
        本标签页 {{ store.tabId.slice(-4) }} · 共编 {{ store.peers + 1 }} 个标签页
      </span>
      <span v-if="store.pendingCount" class="status-pending">
        {{ store.pendingCount }} 项本地草稿待提交
      </span>
      <span>缩放 {{ Math.round(store.zoom * 100) }}%</span>
      <span>网格 {{ store.gridSize }} px</span>
    </footer>
  </div>
</template>
