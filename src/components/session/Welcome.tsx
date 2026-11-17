import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { isActiveProviderReady, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { ContextBar } from './ContextBar.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：未配置时可先导入、查看旧对话，发送时再要求 Key。 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const providerReady = useSettings((state) => isActiveProviderReady(state))
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        {!providerReady ? (
          <div className={styles.onboarding} aria-label={t('onboardingTitle')}>
            <div className={styles.onboardingTitle}>{t('onboardingTitle')}</div>
            <div className={styles.actions}>
              <Button size="m" onClick={() => openSettings('data')}>
                {t('onboardingImport')}
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
    </div>
  )
}
