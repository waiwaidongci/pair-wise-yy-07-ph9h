<script setup lang="ts">
import { Back, Connection, Grid, Rank } from '@element-plus/icons-vue';
</script>

<template>
  <div class="guide-page">
    <header>
      <div>
        <span class="brand-mark"><Grid /></span>
        <div>
          <h1>FrameFlow 使用说明</h1>
          <p>流程图、ERD 和架构图的本地编辑工作台</p>
        </div>
      </div>
      <router-link to="/">
        <el-button :icon="Back">返回编辑器</el-button>
      </router-link>
    </header>
    <main>
      <section>
        <h2>画布操作</h2>
        <div class="guide-grid">
          <article>
            <Rank />
            <h3>选择与移动</h3>
            <p>单击选择图元，按住 Shift 多选。拖动时显示橙色对齐参考线与实时距离。</p>
          </article>
          <article>
            <Connection />
            <h3>锚点连线</h3>
            <p>切换到连线模式，选中节点后拖动四周锚点到目标节点，系统会自动选择目标锚点并绕开遮挡。</p>
          </article>
          <article>
            <Grid />
            <h3>画布导航</h3>
            <p>滚轮围绕指针缩放，拖动画布空白区域平移。点击“适应”可让全部图元回到可视区。</p>
          </article>
        </div>
      </section>
      <section>
        <h2>快捷键</h2>
        <div class="shortcut-table">
          <span><kbd>Ctrl/Cmd + Z</kbd><em>撤销</em></span>
          <span><kbd>Ctrl/Cmd + Shift + Z</kbd><em>重做</em></span>
          <span><kbd>Ctrl/Cmd + D</kbd><em>复制选中图元</em></span>
          <span><kbd>Ctrl/Cmd + G</kbd><em>组合选中图元</em></span>
          <span><kbd>Ctrl/Cmd + Shift + G</kbd><em>取消组合</em></span>
          <span><kbd>Delete / Backspace</kbd><em>删除所选对象</em></span>
          <span><kbd>方向键</kbd><em>按网格移动</em></span>
          <span><kbd>Shift + 方向键</kbd><em>精细移动</em></span>
          <span><kbd>Esc</kbd><em>返回选择模式并清除选择</em></span>
        </div>
      </section>
      <section>
        <h2>多标签页共编与修订</h2>
        <div class="guide-grid">
          <article>
            <Connection />
            <h3>修订实时同步</h3>
            <p>打开多个标签页评审同一张画布时，图元、连接线和表字段的每次修改都会带上修订号写入共享文档，其他标签页立即看到。</p>
          </article>
          <article>
            <Rank />
            <h3>同改不覆盖</h3>
            <p>两个标签页同时编辑同一属性时，后到的修改不覆盖先到的，双方取值都保留在右侧属性面板的冲突区，由人裁定最终值。</p>
          </article>
          <article>
            <Back />
            <h3>失效连接线与休眠恢复</h3>
            <p>图元被删除后，牵连的连接线自动失效移除；标签页被系统休眠后回来，会先合并离开期间的修订再继续本地草稿。写入失败时画布停留在上次成功保存的文档，修改留在本地草稿可重试或放弃。</p>
          </article>
        </div>
      </section>
      <section>
        <h2>保存与导出</h2>
        <p>
          编辑内容以修订信封（含修订号、操作日志和字段出处）自动保存在本机浏览器，旧版无修订号文档首次打开会自动升级为共编起点。
          JSON 文件包含完整节点、字段、连接线和样式参数，导入后会成为新的共编起点；SVG 导出适合插入文档或交付评审。
        </p>
      </section>
    </main>
  </div>
</template>
