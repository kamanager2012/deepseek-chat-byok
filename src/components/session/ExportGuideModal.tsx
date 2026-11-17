import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openImportWithFile, openSettings } from '../settings/settingsDialogState.js'
import styles from './ExportGuideModal.module.css'

type PlatformId = 'deepseek' | 'chatgpt' | 'claude'

const PLATFORMS: readonly { id: PlatformId; label: string; stepsKey: TranslationKey }[] = [
  { id: 'deepseek', label: 'DeepSeek', stepsKey: 'exportGuideDeepSeekSteps' },
  { id: 'chatgpt', label: 'ChatGPT', stepsKey: 'exportGuideChatGptSteps' },
  { id: 'claude', label: 'Claude', stepsKey: 'exportGuideClaudeSteps' },
]

/** 分平台展示三步导出教程，并允许选好 ZIP 后直接跳进导入预览，无需先翻设置弹窗 */
export const ExportGuideModal = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [platform, setPlatform] = useState<PlatformId>('deepseek')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const current = PLATFORMS.find((item) => item.id === platform) ?? PLATFORMS[0]

  return (
    <Modal
      title={t('exportGuideTitle')}
      closable
      className={styles.modal}
      onClose={onClose}
      footer={
        <div className={styles.footerActions}>
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              onClose()
              openSettings('data')
            }}
          >
            {t('exportGuideOpenSettings')}
          </Button>
          <Button variant="primary" size="m" onClick={() => fileInputRef.current?.click()}>
            {t('exportGuidePickFile')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.intro}>{t('exportGuideIntro')}</div>
        <div role="tablist" className={styles.tabs}>
          {PLATFORMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={platform === item.id}
              className={clsx(styles.tab, platform === item.id && styles.tabActive)}
              onClick={() => setPlatform(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.stepsCard}>
          {t(current.stepsKey)}
        </div>
        <div className={styles.tip}>{t('exportGuideZipTip')}</div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              onClose()
              openImportWithFile(file)
            }
          }}
        />
      </div>
    </Modal>
  )
}
