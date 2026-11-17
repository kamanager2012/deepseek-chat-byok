import { create } from 'zustand'
import { isActiveProviderReady } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 模型与 API / 数据管理 */
export type SettingsSection = 'general' | 'api' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  pendingImportFile: null as File | null,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const openImportWithFile = (file: File) =>
  useSettingsDialog.setState({ open: true, section: 'data', pendingImportFile: file })

export const consumePendingImportFile = (): File | null => {
  const file = useSettingsDialog.getState().pendingImportFile
  if (file) {
    useSettingsDialog.setState({ pendingImportFile: null })
  }
  return file
}

export const closeSettings = () =>
  useSettingsDialog.setState({ open: false, pendingImportFile: null })

/** 没有可用 Provider 配置时打开设置并选中「模型与 API」，返回是否已就绪 */
export const ensureApiKey = () => {
  if (isActiveProviderReady()) {
    return true
  }
  openSettings('api')
  return false
}
