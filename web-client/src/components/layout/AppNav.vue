<script setup lang="ts">
import { ref } from 'vue'
import SearchResults from './SearchResults.vue'

const query = ref('')
const searchType = ref<'code' | 'ast'>('code')
const results = ref<any>(null)
const searching = ref(false)
const showResults = ref(false)

async function search() {
  const q = query.value.trim()
  if (!q) return
  searching.value = true
  showResults.value = true
  results.value = null
  try {
    const url = '/search?q=' +
      encodeURIComponent(q) +
      '&type=' + searchType.value +
      '&limit=20'
    const resp = await fetch(url)
    if (!resp.ok) {
      const err = await resp.json()
      results.value = { error: err.error }
      return
    }
    results.value = await resp.json()
  } catch (err: any) {
    results.value = { error: err.message }
  } finally {
    searching.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') search()
}
</script>

<template>
  <nav class="bg-slate-800 text-white px-5 py-3
    flex items-center gap-6">
    <span class="font-bold text-lg">OVCS</span>
    <router-link to="/"
      class="text-slate-400 text-sm px-2 py-1
        rounded no-underline
        hover:text-white hover:bg-slate-700"
      active-class="!text-white !bg-slate-700">
      Dashboard
    </router-link>
    <router-link to="/diff"
      class="text-slate-400 text-sm px-2 py-1
        rounded no-underline
        hover:text-white hover:bg-slate-700"
      active-class="!text-white !bg-slate-700">
      Diff Viewer
    </router-link>
    <router-link to="/file"
      class="text-slate-400 text-sm px-2 py-1
        rounded no-underline
        hover:text-white hover:bg-slate-700"
      active-class="!text-white !bg-slate-700">
      File Viewer
    </router-link>
    <a href="/data"
      class="text-slate-400 text-sm px-2 py-1
        rounded no-underline
        hover:text-white hover:bg-slate-700">
      Data (JSON)
    </a>
    <a href="/presence"
      class="text-slate-400 text-sm px-2 py-1
        rounded no-underline
        hover:text-white hover:bg-slate-700">
      Presence (JSON)
    </a>
    <div class="ml-auto flex gap-1 items-center">
      <input v-model="query" type="text"
        placeholder="Search code..."
        class="px-2 py-1 border border-slate-600
          rounded bg-slate-700 text-white
          text-sm w-50
          placeholder:text-slate-400"
        @keydown="onKeydown" />
      <select v-model="searchType"
        class="px-1 py-1 border border-slate-600
          rounded bg-slate-700 text-white
          text-sm">
        <option value="code">Code</option>
        <option value="ast">AST</option>
      </select>
      <button @click="search"
        class="px-2.5 py-1 border
          border-slate-600 rounded
          bg-slate-600 text-white text-sm
          cursor-pointer hover:bg-slate-500">
        Search
      </button>
    </div>
  </nav>
  <SearchResults
    v-if="showResults"
    :results="results"
    :searching="searching"
    @close="showResults = false" />
</template>
