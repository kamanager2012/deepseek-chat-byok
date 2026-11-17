import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { isActiveProviderReady, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { ContextBar } from './ContextBar.js'
import { ExportGuideModal } from './ExportGuideModal.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：小白优先卡片先导入旧聊天、看导出教程，需要 AI 续写时再设置模型。 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const providerReady = useSettings((state) => isActiveProviderReady(state))
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        {!providerReady ? (
          <div className={styles.onboarding} aria-label={t('onboardingTitle')}>
            <div className={styles.badge}>{t('onboardingBadge')}</div>
            <div className={styles.onboardingTitle}>{t('onboardingTitle')}</div>
            <div className={styles.onboardingSubtitle}>{t('onboardingSubtitle')}</div>
            <div className={styles.actions}>
              <Button size="m" onClick={() => openSettings('data')}>
                {t('onboardingImport')}
              </Button>
              <Button variant="outlined" size="m" onClick={() => setGuideOpen(true)}>
                {t('onboardingHowToExport')}
              </Button>
              <Button variant="outlined" size="m" onClick={() => openSettings('api')}>
                {t('onboardingConfigure')}
              </Button>
            </div>
            <div className={styles.note}>{t('onboardingCostNote')}</div>
            <a
              className={styles.guideLink}
              href="get-started.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('onboardingInstallGuide')}
            </a>
          </div>
        ) : null}
        <ContextBar session={null} />
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
      {guideOpen ? <ExportGuideModal onClose={() => setGuideOpen(false)} /> : null}
    </div>
  )
}
