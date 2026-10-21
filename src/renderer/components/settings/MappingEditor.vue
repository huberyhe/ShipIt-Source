<script setup lang="ts">
import { toastError, toastSuccess } from '../../utils/toast'
import { ref } from 'vue'
import { Plus, Trash2, ArrowRight } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import BaseButton from '../common/BaseButton.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'
import FormField from '../common/FormField.vue'
import EmptyState from '../common/EmptyState.vue'

const props = defineProps<{ targetId: string; mappings: any[] }>()
const deployStore = useDeployStore()
const isAdding = ref(false)
const editingMappingId = ref<string | null>(null)
const editingForm = ref({ localPrefix: '', remotePath: '', description: '' })

const saving = ref(false)

/**
 * 保存映射（新增或修改）。
 *
 * 两个必须点：
 * 1. 传给 IPC 的必须是**纯 JSON 对象**：Vue 的 reactive 代理无法被结构化克隆，
 *    直接传会让 `ipcRenderer.invoke` 抛 "An object could not be cloned"，
 *    而这里没接住的话表现为"点保存没反应"（曾出现该问题）。
 * 2. 失败必须可见：不 catch 的话 promise 静默 reject，用户看不到任何反馈。
 */
async function saveMapping() {
  const localPrefix = editingForm.value.localPrefix.trim()
  const remotePath = editingForm.value.remotePath.trim()
  if (!localPrefix || !remotePath) {
    toastError('请填写本地路径与远程目标路径')
    return
  }
  const payload = JSON.parse(JSON.stringify({ localPrefix, remotePath, description: editingForm.value.description || '' }))
  saving.value = true
  try {
    if (editingMappingId.value) {
      await deployStore.updateMapping(props.targetId, editingMappingId.value, payload)
      toastSuccess('映射已更新')
    } else {
      await deployStore.addMapping(props.targetId, payload)
      toastSuccess('映射已添加')
    }
    editingMappingId.value = null
    isAdding.value = false
    editingForm.value = { localPrefix: '', remotePath: '', description: '' }
  } catch (error) {
    const raw = String((error as Error)?.message || error)
    const msg = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
    toastError(`保存映射失败：${msg}`)
  } finally {
    saving.value = false
  }
}

function startAdd() { isAdding.value = true; editingMappingId.value = null; editingForm.value = { localPrefix: '', remotePath: '', description: '' } }
function startEdit(m: any) { editingMappingId.value = m.id; editingForm.value = { localPrefix: m.localPrefix, remotePath: m.remotePath, description: m.description || '' } }
function cancelEdit() { editingMappingId.value = null; isAdding.value = false }
/** 删除映射是破坏性操作：与"删除目标"保持一致，先确认 */
const confirmRemove = ref<any>(null)

function askRemove(mapping: any) { confirmRemove.value = mapping }
async function doRemove() {
  const target = confirmRemove.value
  if (!target) return
  confirmRemove.value = null
  try {
    // id 是字符串，可直接传；失败同样要可见（删除是破坏性操作，静默失败最危险）
    await deployStore.removeMapping(props.targetId, String(target.id))
    toastSuccess('映射已删除')
  } catch (error) {
    const raw = String((error as Error)?.message || error)
    const msg = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
    toastError(`删除映射失败：${msg}`)
  }
}
</script>

<template>
  <div class="mapping-editor">
    <div class="mapping-header">
      <h4>目录映射</h4>
      <BaseButton v-if="!isAdding" variant="outline" size="sm" class="add-btn" @click="startAdd"><Plus :size="12" /> 添加映射</BaseButton>
    </div>

    <div v-for="mapping in mappings" :key="mapping.id" class="mapping-item">
      <div class="mapping-row">
        <code class="local-path">{{ mapping.localPrefix }}</code>
        <ArrowRight :size="12" class="arrow" />
        <code class="remote-path">{{ mapping.remotePath }}</code>
        <span v-if="mapping.description" class="desc">{{ mapping.description }}</span>
        <div class="mapping-actions">
          <button class="mini-btn" @click="startEdit(mapping)">编辑</button>
          <button class="mini-btn danger" aria-label="删除映射" @click="askRemove(mapping)"><Trash2 :size="12" /></button>
        </div>
      </div>
    </div>

    <EmptyState v-if="mappings.length === 0 && !isAdding" size="inline" text="暂无映射规则，例如：项目目录">
      <code>dist/</code> → 远程 <code>/var/www/app/</code>
    </EmptyState>

    <div v-if="isAdding || editingMappingId" class="mapping-form">
      <div class="form-row">
        <FormField label="本地路径（相对于项目根目录）" :for="'map-local-' + props.targetId">
          <input :id="'map-local-' + props.targetId" v-model="editingForm.localPrefix" placeholder="例如: dist/ 或 src/assets/" />
        </FormField>
      </div>
      <div class="form-row">
        <FormField label="远程目标路径" :for="'map-remote-' + props.targetId">
          <input :id="'map-remote-' + props.targetId" v-model="editingForm.remotePath" placeholder="例如: /var/www/app/ 或 /opt/web/" />
        </FormField>
      </div>
      <div class="form-row">
        <FormField label="备注（可选）" :for="'map-desc-' + props.targetId">
          <input :id="'map-desc-' + props.targetId" v-model="editingForm.description" placeholder="如：管理后台代码" />
        </FormField>
      </div>
      <div class="form-actions">
        <BaseButton variant="secondary" size="sm" class="cancel-btn" @click="cancelEdit">取消</BaseButton>
        <BaseButton variant="primary" size="sm" class="save-btn" :disabled="saving" @click="saveMapping">保存</BaseButton>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirmRemove"
      title="删除映射"
      confirm-text="删除"
      danger
      width="420px"
      confirm-on-enter
      @confirm="doRemove"
      @cancel="confirmRemove = null"
    >
      确定删除映射 <code>{{ confirmRemove.localPrefix }}</code> → <code>{{ confirmRemove.remotePath }}</code>？<br />
      此操作不可撤销。
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.mapping-editor { margin: 8px; border-top: 1px solid var(--border); padding: 8px; }
.mapping-header { display: flex; align-items: center; justify-content: space-between; margin: 4px; }
.mapping-header h4 { font-size: 12px; color: var(--fg2); font-weight: normal; }
.mapping-item { padding: 4px 0; }
.mapping-row { display: flex; align-items: center; gap: 4px; font-size: 12px; }
code.local-path { padding: 1px 4px; background: var(--green-bg); color: var(--green); border-radius: 4px; font-size: 11px; }
code.remote-path { padding: 1px 4px; background: var(--blue-bg); color: var(--blue); border-radius: 4px; font-size: 11px; }
.arrow { color: var(--fg2); flex-shrink: 0; }
.desc { color: var(--fg2); font-size: 11px; }
/* margin:auto 会把按钮推到整行中间（悬空、与内容脱节）；改为贴行尾，与目标卡片的操作列对齐 */
.mapping-actions { display: flex; gap: 4px; margin-left: auto; opacity: 0; transition: opacity 0.15s; }
.mapping-item:hover .mapping-actions { opacity: 1; }
.mini-btn { display: flex; align-items: center; padding: 4px 4px; background: transparent; color: var(--fg2); border-radius: 4px; font-size: 11px; }
.mini-btn:hover { background: var(--border); color: var(--fg); }
.mini-btn.danger:hover { background: var(--red-bg2); color: var(--red); }
.empty-state code { padding: 1px 4px; background: var(--bg4); border-radius: 4px; color: var(--fg); }
.mapping-form { background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 8px; margin: 8px; }
.form-row { display: flex; gap: 8px; margin: 8px; }
.form-field { flex: 1; }
.form-actions { display: flex; justify-content: flex-end; gap: 4px; }
</style>
