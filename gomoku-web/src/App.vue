<script setup lang="ts">
import { ref } from 'vue'
import HomeView from '@/views/HomeView.vue'
import PveView from '@/views/PveView.vue'
import PvpView from '@/views/PvpView.vue'
import type { Difficulty, Stone } from '@/game/types'

const view = ref<'home' | 'pve' | 'pvp'>('home')
const pveConfig = ref<{ difficulty: Difficulty; playerStone: Stone }>({
  difficulty: 'normal',
  playerStone: 1,
})

function startPve(config: { difficulty: Difficulty; playerStone: Stone }): void {
  pveConfig.value = config
  view.value = 'pve'
}

function backHome(): void {
  view.value = 'home'
}
</script>

<template>
  <main class="app">
    <HomeView v-if="view === 'home'" @start-pve="startPve" @start-pvp="view = 'pvp'" />
    <PveView
      v-else-if="view === 'pve'"
      :key="`${pveConfig.difficulty}-${pveConfig.playerStone}`"
      :difficulty="pveConfig.difficulty"
      :player-stone="pveConfig.playerStone"
      @exit="backHome"
    />
    <PvpView v-else @exit="backHome" />
  </main>
</template>

<style scoped>
.app {
  min-height: 100vh;
}
</style>
