<script setup lang="ts">
import { computed } from 'vue'
import { Rocket, ExternalLink } from 'lucide-vue-next'
import BaseDialog from './BaseDialog.vue'
import IconButton from './IconButton.vue'
import { useUiStore } from '../../stores/ui'

defineEmits<{ close: [] }>()

// 版本号硬绑定主进程 app.getVersion()（App 启动时已预取到 store），同步可用、无首帧空态
const uiStore = useUiStore()
const version = computed(() => uiStore.appVersion)
/** 打包注入的 build 号；未注入（开发态）时不显示，避免出现“build —” */
const buildNumber = computed(() => uiStore.appBuildNumber)

const features = [
  '多协议上传：SFTP / FTP / FTPS / FTPES / 本地目录',
  'Git 集成：未提交变更 / 提交历史 / 一键上传提交文件',
  '多目标管理：独立连接配置与目录映射'
]

/** 项目地址（仓库主页，含 releases / issues 入口）。区块标题已经说“项目地址”，行里不再重复标签 */
const projectUrl = 'https://github.com/huberyhe/ShipIt'

function openLink(url: string): void {
  void window.deployApi.openExternal(url)
}
</script>

<template>
  <BaseDialog title="关于 ShipIt" :icon="Rocket" width="440px" close-on-overlay @close="$emit('close')">
    <div class="about">
      <!-- 标题已在弹窗头部（关于 ShipIt），正文不再重复产品名：两个同名标题会让“当前在哪个层级”变模糊 -->
      <div class="meta-line">
        <span class="version-wrap">
          版本 <code class="version-num">{{ version || '—' }}</code>
          <template v-if="buildNumber">
            <span class="sep" aria-hidden="true">·</span>
            <code class="version-num build-num">build{{ buildNumber }}</code>
          </template>
        </span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="tagline">开发者文件发布工具</span>
        <IconButton
          class="project-open"
          size="xs"
          :label="`在浏览器中打开项目地址：${projectUrl}`"
          :title="projectUrl"
          @click="openLink(projectUrl)"
        ><ExternalLink :size="12" /></IconButton>
      </div>
      <p class="desc">将本地代码快速上传到多台服务器，并集成 Git 变更与提交历史查看，让发布与追溯一步到位。</p>

      <div class="features">
        <div v-for="f in features" :key="f" class="feature">
          <span class="dot"></span>{{ f }}
        </div>
      </div>

    </div>
  </BaseDialog>
</template>

<style scoped>
/*
 * 所有子元素共用同一条左边界（16px，与 BaseDialog 头部的 padding 一致）。
 * 此前每块各自 margin: 4/12px，左边缘分别是 16/20/28/28 —— 看起来就是"没对齐"。
 */
.about { padding: 16px; display: flex; flex-direction: column; }
/* 版本 + 定位：一行元信息，替代“正文再写一遍产品名” */
/*
 * 按中线对齐：baseline 会让“无文字基线”的图标按钮按盒底对齐，
 * 结果图标比文字高出一截（用户一眼就看到“没对齐”）。
 */
/* 这行是「文字 + code + 图标」混排：必须按**基线**对齐。
   用 align-items:center 时，`<code>` 的盒子（monospace 行高不同）按盒子居中 →
   视觉上版本号比「版本」两个字偏低，看起来不在一条线上。 */
.meta-line { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--fg2); }
/* 图标不是文字：基线对齐会把它顶高，单独拉回垂直居中 */
.meta-line > .icon-btn, .meta-line > button { align-self: center; }
/* 版本号与 build 号之间要有间距：version-wrap 里是 inline 内容，靠 gap 分隔 */
.version-wrap { display: inline-flex; align-items: baseline; gap: 4px; }  /* 4/8 网格：6px 曾被 audit 判为不在网格内 */
.version-num { font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace; font-size: 12px; line-height: 1.2; color: var(--fg); }
.sep { color: var(--fg2); }
.tagline { color: var(--fg2); }
.desc { margin: 12px 0 0; font-size: 12px; color: var(--fg); line-height: 1.7; }
.features {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid var(--bg3);
  display: flex; flex-direction: column; gap: 8px;
}
/* 项目地址以小按钮形式紧跟在定位文案后：不占额外行，也不用另起一个“地址”区块 */
/*
 * 图标与 12px 文字同重：12px 图标 + 20px 点击区（实测盒中线与文字中线偏差 0，
 * 之前“看着没对齐”是图标 13px、外圈 24px 的视觉重量比文字重，加上 10px 间距显得脱开）。
 */
.project-open { flex: 0 0 auto; margin-left: 0; align-self: center; }
.project-open :deep(svg) {
  display: block;
  /*
   * 光学对齐（不是布局修正）：实测图标盒中线与文字中线偏差 = 0，
   * 但 external-link 的箭头在右上角，墨迹重心偏上，看着像“高了一点”。
   * 下移 1px 让视觉重心回到文字中线；命中区仍是 20×20。
   */
  position: relative;
  top: 1px;
}

/* 圆点对齐首行文字中线：多行文案时不再"贴着第二行偏上" */
/* 单行特性：圆点与文字按中线对齐（之前用固定 margin-top，字号一变就偏） */
.feature { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.6; color: var(--fg); }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
</style>
