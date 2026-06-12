import { createRouter, createWebHistory } from 'vue-router'
import DashboardView from './views/DashboardView.vue'
import DiffView from './views/DiffView.vue'
import FileView from './views/FileView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: DashboardView },
    { path: '/diff', component: DiffView },
    { path: '/file', component: FileView },
  ],
})
