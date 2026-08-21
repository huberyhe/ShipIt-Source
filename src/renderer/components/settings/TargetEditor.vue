<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus, Trash2, Radio, Check, X, ArrowLeft } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import MappingEditor from './MappingEditor.vue'
import BaseDialog from '../common/BaseDialog.vue'

const deployStore = useDeployStore()

type Protocol = 'sftp' | 'ftp' | 'ftps' | 'ftpes' | 'local'

/** 各协议默认端口 */
function defaultPort(p: Protocol): number {
  switch (p) {
    case 'sftp': return 22
    case 'ftp':
    case 'ftpes': return 21
    case 'ftps': return 990
    default: return 0 // local 无端口
  }
}

const editingId = ref<string | null | undefined>(undefined)
const editingForm = ref({
  name: '', protocol: 'sftp' as Protocol, host: '', port: 22,
  username: '', password: '', privateKeyPath: '', passphrase: ''
})
const editingMappings = ref<any[]>([]) // 编辑中的映射列表

// 每个目标的测试结果独立存储，避免串台
const testResults = ref<Record<string, { success: boolean; error?: string; testing?: boolean }>>({})
const formTestResult = ref<{ success: boolean; error?: string } | null>(null)
const testingId = ref<string | null>(null)
const isFormTesting = ref(false)
const tempMap = ref({ localPrefix: '', remotePath: '', description: '' })

onMounted(async () => { await deployStore.loadTargets() })

function startAdd() {
  editingId.value = null
  editingForm.value = {
    name: '', protocol: 'sftp', host: '', port: 22,
    username: '', password: '', privateKeyPath: '', passphrase: ''
  }
  editingMappings.value = []
}

function startEdit(target: any) {
  editingId.value = target.id
  editingForm.value = {
    name: target.name, protocol: target.protocol, host: target.host,
    port: target.port || defaultPort(target.protocol),
    username: target.username, password: target.password || '',
    privateKeyPath: target.privateKeyPath || '', passphrase: target.passphrase || ''
  }
  editingMappings.value = JSON.parse(JSON.stringify(target.mappings || []))
}

function cancelEdit() { editingId.value = undefined }

async function saveTarget() {
  if (!editingForm.value.name.trim() || !editingForm.value.host.trim()) {
    window.dispatchEvent(new CustomEvent('toast', { detail: '请填写目标名称和主机地址' }))
    return
  }

  // 转为纯 JSON 对象，避免 Vue reactive proxy 导致 IPC 克隆失败
  const data = JSON.parse(JSON.stringify({
    name: editingForm.value.name,
    protocol: editingForm.value.protocol,
    host: editingForm.value.host,
    port: editingForm.value.port,
    username: editingForm.value.username,
    password: editingForm.value.password,
    privateKeyPath: editingForm.value.privateKeyPath,
    passphrase: editingForm.value.passphrase,
    mappings: editingMappings.value.map((m: any) => ({
      localPrefix: m.localPrefix,
      remotePath: m.remotePath,
      description: m.description || ''
    }))
  }))

  try {
    if (editingId.value) {
      await deployStore.updateTarget(editingId.value, data)
    } else {
      await deployStore.addTarget(data)
    }
    editingId.value = undefined
    window.dispatchEvent(new CustomEvent('toast-success', { detail: '目标已保存' }))
  } catch (err: any) {
    window.dispatchEvent(new CustomEvent('toast', { detail: '保存失败: ' + (err?.message || String(err)) }))
  }
}

const confirmDelete = ref<any>(null)

function askDelete(target: any) { confirmDelete.value = target }

async function doDelete() {
  if (!confirmDelete.value) return
  const name = confirmDelete.value.name
  await deployStore.removeTarget(confirmDelete.value.id)
  confirmDelete.value = null
  window.dispatchEvent(new CustomEvent('toast-success', { detail: `已删除目标 ${name}` }))
}

async function pickKeyFile() {
  try {
    const filePath = await window.deployApi.openFileDialog({
      title: '选择 SSH 密钥文件',
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (filePath) editingForm.value.privateKeyPath = filePath
  } catch {}
}

async function testConnection(target: any) {
  testingId.value = target.id
  testResults.value[target.id] = { success: false, error: '测试中...', testing: true }
  try {
    // 序列化去掉 Vue reactive proxy
    const plain = JSON.parse(JSON.stringify(target))
    const result = await window.deployApi.testConnection(plain)
    testResults.value[target.id] = { ...result, testing: false }
  } catch (err: any) {
    testResults.value[target.id] = { success: false, error: err.message, testing: false }
  } finally { testingId.value = null }
}

async function testFormConnection() {
  isFormTesting.value = true
  formTestResult.value = null
  try {
    const plain = JSON.parse(JSON.stringify(buildTestTarget()))
    formTestResult.value = await window.deployApi.testConnection(plain)
  } catch (err: any) {
    formTestResult.value = { success: false, error: err.message }
  } finally { isFormTesting.value = false }
}

// 从编辑表单构建临时目标对象用于测试
function buildTestTarget() {
  return {
    name: editingForm.value.name || '临时',
    protocol: editingForm.value.protocol,
    host: editingForm.value.host,
    port: editingForm.value.port,
    username: editingForm.value.username,
    password: editingForm.value.password,
    privateKeyPath: editingForm.value.privateKeyPath,
    passphrase: editingForm.value.passphrase,
    mappings: editingMappings.value
  }
}

// 编辑表单中临时添加映射
function addTempMapping(mapping: any) { editingMappings.value.push(mapping); tempMap.value = { localPrefix: '', remotePath: '', description: '' } }
function removeTempMapping(idx: number) { editingMappings.value.splice(idx, 1) }
</script>

<template>
  <div class="target-editor">
    <!-- ===== 列表视图 ===== -->
    <template v-if="editingId === undefined">
      <div class="section-header">
        <h3>上传目标</h3>
        <button class="add-btn" @click="startAdd"><Plus :size="14" /> 添加目标</button>
      </div>

      <div v-if="deployStore.targets.length === 0" class="empty-state">
        暂无上传目标，请添加一个
      </div>

      <div v-for="target in deployStore.targets" :key="target.id" class="target-card">
        <div class="target-info">
          <div class="target-primary">
            <span class="target-name">{{ target.name }}</span>
            <span class="target-protocol">{{ (target.protocol as string).toUpperCase() }}</span>
            <span class="target-host">{{ target.host }}:{{ target.port || (target.protocol==='ftp'?21:22) }}</span>
          </div>
          <div class="target-actions">
            <button class="icon-btn" title="测试连接" :disabled="testingId === target.id" @click="testConnection(target)">
              <Radio :size="14" /> <span>{{ testingId === target.id ? '测试中' : '测试' }}</span>
            </button>
            <button class="icon-btn" title="编辑" @click="startEdit(target)">✎ 编辑</button>
            <button class="icon-btn danger" title="删除" aria-label="删除目标" @click="askDelete(target)"><Trash2 :size="14" /></button>
          </div>
        </div>

        <div v-if="testResults[target.id]" class="test-result" :class="testResults[target.id].testing ? 'testing' : testResults[target.id].success ? 'success' : 'error'">
          <component :is="testResults[target.id].testing ? Radio : testResults[target.id].success ? Check : X" :size="12" :class="{ 'spin': testResults[target.id].testing }" />
          <span>{{ testResults[target.id].testing ? '测试中...' : testResults[target.id].success ? '连接成功' : testResults[target.id].error }}</span>
        </div>

        <MappingEditor :target-id="target.id" :mappings="target.mappings || []" />
      </div>
    </template>

    <!-- ===== 编辑/新增表单视图 ===== -->
    <div v-else class="edit-form">
      <div class="form-header">
        <h4>{{ editingId ? '编辑目标' : '新增目标' }}</h4>
        <button class="back-btn" @click="cancelEdit"><ArrowLeft :size="14" /> 返回列表</button>
      </div>

      <!-- 连接 -->
      <div class="form-section">
        <h5 class="form-section-title">连接</h5>
        <div class="form-row">
          <div class="form-field">
            <label for="tgt-name">名称</label>
            <input id="tgt-name" v-model="editingForm.name" placeholder="例如：生产环境" />
          </div>
          <div class="form-field">
            <label for="tgt-protocol">协议</label>
            <select id="tgt-protocol" v-model="editingForm.protocol" @change="editingForm.port = defaultPort(editingForm.protocol)">
              <option value="sftp">SFTP</option>
              <option value="ftp">FTP</option>
              <option value="ftps">FTPS (隐式 TLS)</option>
              <option value="ftpes">FTPES (显式 TLS)</option>
              <option value="local">本地目录</option>
            </select>
          </div>
        </div>

        <!-- local 协议：主机 = 本地根目录 -->
        <div class="form-row" v-if="editingForm.protocol === 'local'">
          <div class="form-field flex-2">
            <label for="tgt-host">本地根目录</label>
            <input id="tgt-host" v-model="editingForm.host" placeholder="D:\deploy 或 \\server\share" />
            <span class="field-hint">上传目标为本地/挂载目录</span>
          </div>
        </div>

        <div class="form-row" v-else>
          <div class="form-field flex-2">
            <label for="tgt-host">主机</label>
            <input id="tgt-host" v-model="editingForm.host" placeholder="ftp.example.com" />
          </div>
          <div class="form-field flex-1">
            <label for="tgt-port">端口</label>
            <input id="tgt-port" v-model.number="editingForm.port" type="number" />
          </div>
        </div>
      </div>

      <!-- 认证（本地目录无需） -->
      <div v-if="editingForm.protocol !== 'local'" class="form-section">
        <h5 class="form-section-title">认证</h5>
        <div class="form-row">
          <div class="form-field">
            <label for="tgt-user">用户名</label>
            <input id="tgt-user" v-model="editingForm.username" placeholder="root" />
          </div>
          <div class="form-field">
            <label for="tgt-pass">密码</label>
            <input id="tgt-pass" v-model="editingForm.password" type="password" placeholder="（可选，留空使用密钥）" />
          </div>
        </div>

        <div class="form-row" v-if="editingForm.protocol === 'sftp'">
          <div class="form-field">
            <label for="tgt-key">SSH 密钥路径</label>
            <div class="file-picker">
              <input id="tgt-key" v-model="editingForm.privateKeyPath" placeholder="C:\Users\xxx\.ssh\id_rsa" />
              <button class="browse-btn" aria-label="选择密钥文件" @click="pickKeyFile">浏览...</button>
            </div>
          </div>
          <div class="form-field">
            <label for="tgt-passphrase">密钥密码</label>
            <input id="tgt-passphrase" v-model="editingForm.passphrase" type="password" placeholder="（可选）" />
          </div>
        </div>
      </div>

      <!-- 目录映射 -->
      <div class="form-section">
        <h5 class="form-section-title">目录映射</h5>
        <div v-for="(m, idx) in editingMappings" :key="idx" class="edit-mapping-row">
          <code>{{ m.localPrefix }}</code>
          <span class="map-arrow">→</span>
          <code>{{ m.remotePath }}</code>
          <span v-if="m.description" class="map-desc">{{ m.description }}</span>
          <button class="mini-btn danger" aria-label="删除映射" @click="removeTempMapping(idx)"><Trash2 :size="12" /></button>
        </div>
        <div class="edit-mapping-add">
          <div class="inline-form">
            <input v-model="tempMap.localPrefix" aria-label="本地路径前缀" placeholder="本地前缀，如 manage/" class="inline-input" @keyup.enter="addTempMapping({ id:Date.now().toString(36), localPrefix:tempMap.localPrefix, remotePath:tempMap.remotePath, description:tempMap.description })" />
            <span class="map-arrow">→</span>
            <input v-model="tempMap.remotePath" aria-label="远程目标路径" placeholder="远程路径，如 /opt/ssmp/" class="inline-input" @keyup.enter="addTempMapping({ id:Date.now().toString(36), localPrefix:tempMap.localPrefix, remotePath:tempMap.remotePath, description:tempMap.description })" />
            <button class="mini-add-btn" @click="addTempMapping({ id:Date.now().toString(36), localPrefix:tempMap.localPrefix, remotePath:tempMap.remotePath, description:tempMap.description })">添加</button>
          </div>
        </div>
      </div>

      <!-- 底部操作区 -->
      <div class="form-footer">
        <div class="form-test-bar">
          <button class="test-btn" :disabled="isFormTesting || !editingForm.host" @click="testFormConnection">
            <Radio :size="13" /> {{ isFormTesting ? '测试中...' : '测试连接' }}
          </button>
          <span v-if="formTestResult" class="test-result-inline" :class="formTestResult.success ? 'success' : 'error'">
            <component :is="formTestResult.success ? Check : X" :size="12" />
            {{ formTestResult.success ? '连接成功' : formTestResult.error }}
          </span>
        </div>
        <div class="form-actions">
          <button class="cancel-btn" @click="cancelEdit">取消</button>
          <button class="save-btn" @click="saveTarget">{{ editingId ? '保存修改' : '保存目标' }}</button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <BaseDialog
      v-if="confirmDelete"
      title="删除上传目标"
      width="400px"
      close-on-overlay
      @close="confirmDelete = null"
    >
      <p class="confirm-text">确定删除上传目标 <strong>{{ confirmDelete.name }}</strong>？<br />此操作不可撤销。</p>
      <template #footer>
        <button class="cancel-btn" @click="confirmDelete = null">取消</button>
        <button class="danger-btn" @click="doDelete">删除</button>
      </template>
    </BaseDialog>
  </div>
</template>


<style scoped>
.target-editor { color: var(--fg); }
.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.section-header h3 { font-size: 13px; font-weight: normal; }
.add-btn { display: flex; align-items: center; gap: 4px; padding: 6px 14px; background: var(--accent); color: var(--fg3); border-radius: 4px; font-size: 12px; }
.add-btn:hover { background: var(--accent2); }
.empty-state { padding: 24px; text-align: center; color: var(--fg2); border: 1px dashed var(--border); border-radius: 6px; }
.target-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
.target-info { display: flex; align-items: center; justify-content: space-between; }
.target-primary { display: flex; align-items: center; gap: 8px; }
.target-name { font-weight: 500; color: var(--fg3); }
.target-protocol { font-size: 11px; padding: 1px 6px; background: var(--accent); color: var(--fg3); border-radius: 4px; }
.target-host { font-size: 12px; color: var(--fg2); }
.target-actions { display: flex; gap: 6px; }
.icon-btn { display: flex; align-items: center; gap: 4px; padding: 6px 12px; background: transparent; color: var(--fg2); border: 1px solid var(--border); border-radius: 4px; font-size: 11px; min-height: 30px; }
.icon-btn:hover:not(:disabled) { background: var(--border); color: var(--fg); }
.icon-btn:disabled { opacity: 0.4; }
.icon-btn.danger:hover { background: var(--red-bg2); color: var(--red); border-color: var(--red); }
.test-result { display: flex; align-items: center; gap: 4px; margin-top: 8px; padding: 4px 8px; font-size: 12px; border-radius: 4px; }
.test-result.testing { background: var(--blue-bg); color: var(--blue); }
.test-result.success { background: var(--green-bg); color: var(--green); }
.test-result.error { background: var(--red-bg); color: var(--red); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spin { animation: spin 1s linear infinite; }

/* 表单视图 */
.edit-form { background: var(--bg3); border: 1px solid var(--status-bar); border-radius: 8px; padding: 16px; }
.form-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.form-header h4 { font-size: 14px; font-weight: 500; }
.back-btn { display: flex; align-items: center; gap: 4px; padding: 5px 10px; background: transparent; color: var(--fg2); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; }
.back-btn:hover { background: var(--border); color: var(--fg); }

/* 分组 */
.form-section { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 10px; }
.form-section-title {
  font-size: 11px; color: var(--fg2); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.form-row { display: flex; gap: 12px; margin-bottom: 10px; }
.form-row:last-child { margin-bottom: 0; }
.form-field { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.form-field.flex-2 { flex: 2; }
.form-field.flex-1 { flex: 1; }
.form-field label { font-size: 11px; color: var(--fg2); }
.field-hint { font-size: 10px; color: var(--fg2); opacity: 0.8; }
.form-field input, .form-field select { padding: 7px 9px; background: var(--bg5); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.form-field input:focus, .form-field select:focus { border-color: var(--status-bar); box-shadow: 0 0 0 2px var(--accent3); }
.file-picker { display: flex; gap: 4px; }
.file-picker input { flex: 1; }
.browse-btn { padding: 7px 12px; background: var(--bg5); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; white-space: nowrap; }
.browse-btn:hover { background: var(--scrollbar-hover); }

.edit-mapping-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 11px; }
.edit-mapping-row code { padding: 2px 6px; border-radius: 4px; font-size: 10px; }
.edit-mapping-row code:first-child { background: var(--green-bg); color: var(--green); }
.edit-mapping-row code:last-of-type { background: var(--blue-bg); color: var(--blue); }
.map-arrow { color: var(--fg2); flex-shrink: 0; }
.map-desc { color: var(--fg2); font-size: 10px; margin-left: auto; }
.edit-mapping-add { margin-top: 6px; padding-top: 8px; border-top: 1px dashed var(--border); }
.inline-form { display: flex; align-items: center; gap: 6px; }
.inline-input { padding: 5px 8px; background: var(--bg5); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 11px; outline: none; width: 160px; }
.inline-input:focus { border-color: var(--status-bar); box-shadow: 0 0 0 2px var(--accent3); }
.mini-add-btn { padding: 5px 12px; background: var(--accent); color: var(--fg3); border-radius: 4px; font-size: 11px; }
.mini-add-btn:hover { background: var(--accent2); }
.mini-btn.danger { padding: 5px; background: transparent; color: var(--fg2); border-radius: 4px; font-size: 11px; display: flex; align-items: center; }
.mini-btn.danger:hover { background: var(--red-bg2); color: var(--red); }

/* 底部操作区 */
.form-footer { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.form-test-bar { display: flex; align-items: center; gap: 10px; }
.test-btn { display: flex; align-items: center; gap: 4px; padding: 6px 14px; background: var(--bg5); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; }
.test-btn:hover:not(:disabled) { background: var(--scrollbar-hover); }
.test-btn:disabled { opacity: 0.4; }
.test-result-inline { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.test-result-inline.success { color: var(--green); }
.test-result-inline.error { color: var(--red); }

.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.cancel-btn { padding: 7px 18px; background: var(--bg5); color: var(--fg); border-radius: 4px; }
.cancel-btn:hover { background: var(--scrollbar-hover); }
.save-btn { padding: 7px 18px; background: var(--accent); color: var(--fg3); border-radius: 4px; }
.save-btn:hover { background: var(--accent2); }
.confirm-text { font-size: 13px; color: var(--fg); line-height: 1.6; padding: 8px 16px; }
.danger-btn { padding: 7px 18px; background: var(--red); color: var(--fg3); border-radius: 4px; }
.danger-btn:hover { background: var(--red-bg2); }
</style>
