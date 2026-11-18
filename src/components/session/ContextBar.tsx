import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { applyContextBudget, sessionToMarkdown } from '../../services/chat/contextBudget.js'
import { estimateSessionCost, formatCnyCost, formatUsdCost } from '../../services/api/pricing.js'
import { isProviderConfigured } from '../../services/api/providers.js'
import { distillSessionMemory, updateSessionMemory } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { getActiveProvider, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './ContextBar.module.css'

const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n)

export const ContextBar = ({ session }: { session: Session | null }) => {
  const t = useTranslate()
  const providers = useSettings((state) => state.providers)
  const activeProviderId = useSettings((state) => state.activeProviderId)
  const contextMaxRounds = useSettings((state) => state.contextMaxRounds)
  const contextMaxTokens = useSettings((state) => state.contextMaxTokens)
  const provider = useMemo(
    () => getActiveProvider({ providers, activeProviderId }),
    [providers, activeProviderId]
  )

  const visibleMessages = useMemo(() => (session ? getVisibleMessages(session) : []), [session])
  const budget = useMemo(
    () =>
      applyContextBudget(visibleMessages, {
        maxRounds: contextMaxRounds,
        maxTokens: contextMaxTokens,
      }),
    [visibleMessages, contextMaxRounds, contextMaxTokens]
  )

  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [distilling, setDistilling] = useState(false)
  const distillAbortRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      distillAbortRef.current?.abort()
      distillAbortRef.current = null
    },
    [session?.id]
  )

  const openMemory = () => {
    if (!session) {
      return
    }
    setMemoryDraft(session.memoryPrompt ?? '')
    setMemoryOpen(true)
  }

  const closeMemory = () => {
    distillAbortRef.current?.abort()
    distillAbortRef.current = null
    setDistilling(false)
    setMemoryOpen(false)
  }

  const runDistill = async () => {
    if (!session || distilling) {
      return
    }
    if (!isProviderConfigured(provider)) {
      closeMemory()
      openSettings('api')
      showToast({ key: 'providerNeedKeyTag' })
      return
    }
    distillAbortRef.current?.abort()
    const controller = new AbortController()
    distillAbortRef.current = controller
    setDistilling(true)
    try {
      const summary = await distillSessionMemory(session.id, controller.signal)
      if (controller.signal.aborted) {
        return
      }
      if (summary) {
        setMemoryDraft(summary)
        showToast({ key: 'sessionMemoryDistilled' })
      } else {
        showToast({ key: 'sessionMemoryNoDropped' })
      }
    } catch {
      if (!controller.signal.aborted) {
        showToast({ key: 'commonNetworkErrorToast', type: 'error' })
      }
    } finally {
      if (distillAbortRef.current === controller) {
        distillAbortRef.current = null
        setDistilling(false)
      }
    }
  }

  const exportMarkdown = () => {
    if (!session) {
      return
    }
    const md = sessionToMarkdown(session, visibleMessages, false)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${(session.title || 'chat').replace(/[/\\:*?"<>|]/g, '_')}.md`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const providerReady = isProviderConfigured(provider)
  const sessionCost = useMemo(
    () => (session ? estimateSessionCost(session, provider.model) : null),
    [session, provider.model]
  )

  const labelText =
    (session
      ? t('contextBudgetBar', {
          provider: provider.name,
          model: provider.model,
          kept: budget.keptRounds,
          total: budget.totalRounds,
          tokens: formatTokens(budget.estimatedHistoryTokens),
        }) +
        (budget.droppedRounds.length > 0
          ? t('contextBudgetTrimmedHint', { dropped: budget.droppedRounds.length })
          : '') +
        (sessionCost && sessionCost.totalCostUsd > 0
          ? t('contextCostShort', {
              cny: formatCnyCost(sessionCost.totalCostUsd),
              usd: formatUsdCost(sessionCost.totalCostUsd),
            })
          : '')
      : `${provider.name} · ${provider.model}`) +
    (providerReady ? '' : ` · ${t('providerNeedKeyTag')}`)

  const chipTitle =
    sessionCost && sessionCost.totalCostUsd > 0
      ? `${provider.baseUrl} · ${t(
          sessionCost.totalSavedUsd > 0 ? 'contextCostTooltipSaved' : 'contextCostTooltip',
          {
            cny: formatCnyCost(sessionCost.totalCostUsd),
            usd: formatUsdCost(sessionCost.totalCostUsd),
            savedCny: formatCnyCost(sessionCost.totalSavedUsd),
            savedUsd: formatUsdCost(sessionCost.totalSavedUsd),
          }
        )}`
      : provider.baseUrl

  const memorySuggested = budget.droppedRounds.length > 0 && !session?.memoryPrompt

  return (
    <>
      <div className={styles.bar}>
        <button
          type="button"
          className={styles.infoChip}
          onClick={() => openSettings('api')}
          title={chipTitle}
        >
          <span>{labelText}</span>
        </button>
        {session ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={clsx(styles.infoChip, session.memoryPrompt && styles.actionChipActive)}
              title={memorySuggested ? t('sessionMemorySuggestHint') : undefined}
              onClick={openMemory}
            >
              {t('sessionMemoryButton')}
              {memorySuggested ? ' *' : ''}
            </button>
            <button type="button" className={styles.infoChip} onClick={exportMarkdown}>
              {t('exportMarkdown')}
            </button>
          </div>
        ) : null}
      </div>

      {memoryOpen && session ? (
        <Modal
          title={t('sessionMemoryModalTitle')}
          className={styles.memoryModal}
          onClose={closeMemory}
          footer={
            <div className={styles.footerActions}>
              <Button
                variant="outlined"
                size="m"
                disabled={distilling || budget.totalRounds === 0}
                onClick={() => void runDistill()}
              >
                {distilling ? t('sessionMemoryDistilling') : t('sessionMemoryDistill')}
              </Button>
              <Button
                variant="primary"
                size="m"
                disabled={distilling}
                onClick={() => {
                  updateSessionMemory(session.id, memoryDraft)
                  closeMemory()
                }}
              >
                {t('sessionMemorySave')}
              </Button>
            </div>
          }
        >
          <div className={styles.memoryBody}>
            <div className={styles.hint}>{t('sessionMemoryPlaceholder')}</div>
            <textarea
              className={styles.memoryTextarea}
              placeholder={t('sessionMemoryPlaceholder')}
              value={memoryDraft}
              onChange={(e) => setMemoryDraft(e.target.value)}
            />
          </div>
        </Modal>
      ) : null}
    </>
  )
}
