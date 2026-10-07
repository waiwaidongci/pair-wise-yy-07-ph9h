import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { useDiagramStore } from './stores/diagram';
import 'element-plus/dist/index.css';
import './styles.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia).use(router).use(ElementPlus, { locale: zhCn });

// 挂载前把旧文档升级成修订信封，并恢复本标签页未提交的草稿
useDiagramStore(pinia).initCollab();

app.mount('#app');
