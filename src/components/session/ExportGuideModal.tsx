import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openImportWithFile, openSettings } from '../settings/settingsDialogState.js'
import styles from './ExportGuideModal.module.css'

type GuideTabId = 'app' | 'web' | 'import'

const GUIDE_TABS: readonly {
  id: GuideTabId
  labelKey: TranslationKey
  stepsKey: TranslationKey
}[] = [
  { id: 'app', labelKey: 'exportGuideTabApp', stepsKey: 'exportGuideAppSteps' },
  { id: 'web', labelKey: 'exportGuideTabWeb', stepsKey: 'exportGuideWebSteps' },
  { id: 'import', labelKey: 'exportGuideTabImport', stepsKey: 'exportGuideImportSteps' },
]

/** 面向 DeepSeek 用户的三步导出与导入教程，并允许选好 ZIP 后直接跳进导入预览 */
export const ExportGuideModal = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [tab, setTab] = useState<GuideTabId>('app')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const current = GUIDE_TABS.find((item) => item.id === tab) ?? GUIDE_TABS[0]

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
          {GUIDE_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={clsx(styles.tab, tab === item.id && styles.tabActive)}
              onClick={() => setTab(item.id)}
            >
              {t(item.labelKey)}
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
