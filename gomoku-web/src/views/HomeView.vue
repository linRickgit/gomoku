<script setup lang="ts">
import { ref } from 'vue'
import type { Difficulty, Stone } from '@/game/types'
import { BLACK, WHITE } from '@/game/types'

const emit = defineEmits<{
  startPve: [config: { difficulty: Difficulty; playerStone: Stone }]
  startPvp: []
}>()

const difficulty = ref<Difficulty>('normal')
const playerStone = ref<Stone>(BLACK)

const DIFFICULTY_OPTIONS: Array<{ value: Difficulty; label: string; desc: string }> = [
  { value: 'easy', label: '简单', desc: '只看眼前一步，会漏防' },
  { value: 'normal', label: '普通', desc: '两层搜索，会算冲四' },
  { value: 'hard', label: '困难', desc: '四层搜索，攻守兼备' },
]

function startPve(): void {
  emit('startPve', { difficulty: difficulty.value, playerStone: playerStone.value })
}
</script>

<template>
  <div class="home">
    <h1 class="title">五子棋</h1>
    <p class="subtitle">15×15 自由局，先连成五子者胜</p>

    <section class="card">
      <h2 class="card__title">人机对弈</h2>
      <p class="card__hint">AI 完全在你的浏览器里运行，不经过服务器</p>

      <div class="field">
        <span class="field__label">难度</span>
        <div class="options">
          <button
            v-for="option in DIFFICULTY_OPTIONS"
            :key="option.value"
            type="button"
            class="option"
            :class="{ 'option--active': difficulty === option.value }"
            @click="difficulty = option.value"
          >
            <strong>{{ option.label }}</strong>
            <small>{{ option.desc }}</small>
          </button>
        </div>
      </div>

      <div class="field">
        <span class="field__label">先后手</span>
        <div class="options options--compact">
          <button
            type="button"
            class="option"
            :class="{ 'option--active': playerStone === BLACK }"
            @click="playerStone = BLACK"
          >
            我执黑先行
          </button>
          <button
            type="button"
            class="option"
            :class="{ 'option--active': playerStone === WHITE }"
            @click="playerStone = WHITE"
          >
            我执白后手
          </button>
        </div>
      </div>

      <button type="button" class="primary" @click="startPve">开始人机对弈</button>
    </section>

    <section class="card">
      <h2 class="card__title">玩家对弈</h2>
      <p class="card__hint">创建房间后把 6 位房间码发给对手，对方输入即可加入</p>
      <button type="button" class="primary" @click="emit('startPvp')">进入联机大厅</button>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 20px 48px;
}

.title {
  margin: 0;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 2px;
}

.subtitle {
  margin: 6px 0 24px;
  color: #6b6b6b;
  font-size: 14px;
}

.card {
  background: #fff;
  border: 1px solid #e6e6e6;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}

.card__title {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 600;
}

.card__hint {
  margin: 0 0 16px;
  color: #8a8a8a;
  font-size: 13px;
}

.field {
  margin-bottom: 16px;
}

.field__label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  color: #555;
}

.options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.options--compact {
  grid-template-columns: repeat(2, 1fr);
}

.option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border: 1px solid #dcdcdc;
  border-radius: 8px;
  background: #fafafa;
  cursor: pointer;
  font-size: 13px;
  color: #333;
  transition: all 0.15s;
}

.option small {
  color: #999;
  font-size: 11px;
  line-height: 1.4;
}

.option:hover {
  border-color: #b8b8b8;
}

.option--active {
  border-color: #2f6fed;
  background: #eef3ff;
  color: #2f6fed;
}

.option--active small {
  color: #5b86d6;
}

.primary {
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: 8px;
  background: #2f6fed;
  color: #fff;
  font-size: 15px;
  cursor: pointer;
  transition: background 0.15s;
}

.primary:hover {
  background: #2559c9;
}
</style>
