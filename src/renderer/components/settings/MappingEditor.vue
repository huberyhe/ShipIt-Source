<script setup lang="ts">
import { ref } from 'vue'
import { Plus, Trash2, ArrowRight } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'

const props = defineProps<{ targetId: string; mappings: any[] }>()
const deployStore = useDeployStore()
const isAdding = ref(false)
const editingMappingId = ref<string | null>(null)
const editingForm = ref({ localPrefix: '', remotePath: '', description: '' })

async function saveMapping() {
  if (editingMappingId.value) {
    await deployStore.updateMapping(props.targetId, editingMappingId.value, editingForm.value)
  } else {
    await deployStore.addMapping(props.targetId, editingForm.value)
  }
  editingMappingId.value = null; isAdding.value = false
  editingForm.value = { localPrefix: '', remotePath: '', description: '' }
}

function startAdd() { isAdding.value = true; editingMappingId.value = null; editingForm.value = { localPrefix: '', remotePath: '', description: '' } }
function startEdit(m: any) { editingMappingId.value = m.id; editingForm.value = { localPrefix: m.localPrefix, remotePath: m.remotePath, description: m.description || '' } }
function cancelEdit() { editingMappingId.value = null; isAdding.value = false }
async function removeMapping(mappingId: string) { await deployStore.removeMapping(props.targetId, mappingId) }
</script>

<template>
  <div class="mapping-editor">
    <div class="mapping-header">
      <h4>目录映射</h4>
      <button v-if="!isAdding" class="add-btn" @click="startAdd"><Plus :size="12" /> 添加映射</button>
    </div>

    <div v-for="mapping in mappings" :key="mapping.id" class="mapping-item">
      <div class="mapping-row">
        <code class="local-path">{{ mapping.localPrefix }}</code>
        <ArrowRight :size="12" class="arrow" />
        <code class="remote-path">{{ mapping.remotePath }}</code>
        <span v-if="mapping.description" class="desc">{{ mapping.description }}</span>
        <div class="mapping-actions">
          <button class="mini-btn" @click="startEdit(mapping)">编辑</button>
          <button class="mini-btn danger" @click="removeMapping(mapping.id)"><Trash2 :size="12" /></button>
        </div>
      </div>
    </div>

    <div v-if="mappings.length === 0 && !isAdding" class="mapping-empty">
      暂无映射规则，例如：项目目录 <code>manage/</code> → 远程 <code>/opt/ssmp/</code>
    </div>

    <div v-if="isAdding || editingMappingId" class="mapping-form">
      <div class="form-row">
        <div class="form-field">
          <label :for="'map-local-' + props.targetId">本地路径（相对于项目根目录）</label>
          <input :id="'map-local-' + props.targetId" v-model="editingForm.localPrefix" placeholder="例如: manage/ 或 src/app/" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-field">
          <label :for="'map-remote-' + props.targetId">远程目标路径</label>
          <input :id="'map-remote-' + props.targetId" v-model="editingForm.remotePath" placeholder="例如: /opt/ssmp/ 或 /var/www/html/" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-field">
          <label :for="'map-desc-' + props.targetId">备注（可选）</label>
          <input :id="'map-desc-' + props.targetId" v-model="editingForm.description" placeholder="如：管理后台代码" />
        </div>
      </div>
      <div class="form-actions">
        <button class="cancel-btn" @click="cancelEdit">取消</button>
        <button class="save-btn" @click="saveMapping">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mapping-editor { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
.mapping-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.mapping-header h4 { font-size: 12px; color: var(--fg2); font-weight: normal; }
.add-btn { display: flex; align-items: center; gap: 3px; padding: 2px 8px; background: transparent; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px; font-size: 11px; }
.add-btn:hover { background: var(--accent); color: var(--fg3); }
.mapping-item { padding: 4px 0; }
.mapping-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
code.local-path { padding: 1px 6px; background: var(--green-bg); color: var(--green); border-radius: 4px; font-size: 11px; }
code.remote-path { padding: 1px 6px; background: var(--blue-bg); color: var(--blue); border-radius: 4px; font-size: 11px; }
.arrow { color: var(--fg2); flex-shrink: 0; }
.desc { color: var(--fg2); font-size: 11px; }
.mapping-actions { display: flex; gap: 2px; margin-left: auto; opacity: 0; transition: opacity 0.15s; }
.mapping-item:hover .mapping-actions { opacity: 1; }
.mini-btn { display: flex; align-items: center; padding: 2px 4px; background: transparent; color: var(--fg2); border-radius: 4px; font-size: 11px; }
.mini-btn:hover { background: var(--border); color: var(--fg); }
.mini-btn.danger:hover { background: var(--red-bg2); color: var(--red); }
.mapping-empty { font-size: 12px; color: var(--fg2); padding: 4px 0; }
.mapping-empty code { padding: 1px 4px; background: #333; border-radius: 4px; color: var(--fg2); }
.mapping-form { background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 10px; margin-top: 8px; }
.form-row { display: flex; gap: 10px; margin-bottom: 8px; }
.form-field { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.form-field label { font-size: 10px; color: var(--fg2); }
.form-field input { padding: 4px 8px; background: var(--bg5); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; outline: none; }
.form-field input:focus { border-color: var(--status-bar); }
.form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.cancel-btn { padding: 4px 12px; background: var(--bg5); color: var(--fg); border-radius: 4px; font-size: 11px; }
.cancel-btn:hover { background: var(--scrollbar-hover); }
.save-btn { padding: 4px 12px; background: var(--accent); color: var(--fg3); border-radius: 4px; font-size: 11px; }
.save-btn:hover { background: var(--accent2); }
</style>
