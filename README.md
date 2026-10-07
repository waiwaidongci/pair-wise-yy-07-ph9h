# FrameFlow 流程图与 ERD 编辑器

基于 Vue 3、TypeScript、Vite、Element Plus、Pinia、Vue Router 和 Konva 构建。

## 功能

- 矩形、圆形、菱形、数据库表节点和连接线
- 从锚点拖拽连线、自动吸附、移动节点时连接线跟随
- 正交折线路由与节点绕行
- 拖动对齐参考线和实时距离提示
- 多选、分组、锁定、复制、层级调整
- 撤销 / 重做、缩略图、缩放、平移和适应画布
- 本地 JSON 保存 / 导入、SVG 导出
- localStorage 自动恢复最近编辑内容
- 多标签页共编修订：修订号信封 + 操作日志，图元 / 连接线 / 表字段改动实时同步
- 同字段并发编辑时后到不覆盖先到，双方取值进入属性面板冲突区待人裁定
- 删除图元自动剪除悬空连接线；标签页休眠回来先合并离开期间的修订
- 旧版无修订号文档打开即升级为 rev 1 共同起点；写入失败回到上次成功文档，本地草稿可重试或放弃

## 共编修订模型

- 共享文档是单个原子落盘的修订信封：修订号、已物化快照、最近操作日志、字段级出处和冲突条目
- 每个标签页有独立会话 id（sessionStorage），编辑先入本地草稿队列，读-改-写临界区提交并写后校验，防并发交叉覆盖
- 传输通道：BroadcastChannel 负责即时通知与在线感知，`storage` 事件负责休眠/掉线后的可靠追赶
- 冲突按字段保留双方取值（坐标合并为单一 position 冲突点），裁定本身也是一条修订操作，同步所有标签页

## 运行

```bash
export PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH"
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```
