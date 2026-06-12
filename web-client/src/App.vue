<script setup lang="ts">
import AppNav from './components/layout/AppNav.vue'
</script>

<template>
  <AppNav />
  <main class="max-w-6xl mx-auto p-5">
    <router-view />
  </main>
</template>
