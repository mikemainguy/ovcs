<script setup lang="ts">
import { escapeHtml } from '@/utils/escapeHtml'

defineProps<{
  results: any
  searching: boolean
}>()
defineEmits<{ close: [] }>()
</script>

<template>
  <div class="bg-white border-b-2
    border-slate-800 max-h-96
    overflow-y-auto">
    <div class="flex justify-between items-center
      px-5 py-2.5 bg-neutral-50
      border-b border-neutral-200">
      <h3 v-if="searching"
        class="m-0 text-sm">
        Searching...
      </h3>
      <h3 v-else-if="results?.error"
        class="m-0 text-sm">
        Error: {{ results.error }}
      </h3>
      <h3 v-else-if="results" class="m-0 text-sm">
        {{ results.count }} results for
        "{{ results.query }}"
        ({{ results.type }})
      </h3>
      <button @click="$emit('close')"
        class="cursor-pointer bg-transparent
          border-none text-lg text-neutral-500">
        &#x2715;
      </button>
    </div>
    <template v-if="results?.results">
      <div v-if="results.results.length === 0"
        class="px-5 py-2.5 text-sm">
        No results found.
      </div>
      <div v-for="r in results.results"
        :key="r.file_path + r.start_line"
        class="px-5 py-2.5 border-b
          border-neutral-100 text-sm
          hover:bg-neutral-50">
        <span v-if="r.score !== null"
          class="float-right text-neutral-400
            text-xs">
          {{ (r.score * 100).toFixed(1) }}%
        </span>
        <div class="font-semibold text-slate-800">
          <router-link
            :to="'/file?path=' +
              encodeURIComponent(r.file_path)"
            class="text-inherit no-underline
              border-b border-dashed
              border-neutral-400"
            @click="$emit('close')">
            {{ r.file_path }}
          </router-link>
        </div>
        <div class="text-neutral-500
          text-xs mt-0.5">
          <template v-if="r.node_name">
            {{ r.node_type }}: {{ r.node_name }}
            {{ r.signature || '' }}
            ({{ r.language }},
            lines {{ r.start_line }}-{{
              r.end_line }})
          </template>
          <template v-else>
            {{ r.language || 'unknown' }},
            lines {{ r.start_line }}-{{
              r.end_line }}
          </template>
        </div>
        <div v-if="r.content"
          class="font-mono bg-neutral-100
            px-2 py-1.5 rounded mt-1
            whitespace-pre-wrap text-xs
            max-h-24 overflow-y-auto"
          v-html="escapeHtml(
            r.content.substring(0, 500)
          )" />
      </div>
    </template>
  </div>
</template>
