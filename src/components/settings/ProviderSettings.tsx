import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { ApiError, verifyProvider } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import {
  findProviderPreset,
  isValidHttpBaseUrl,
  normalizeBaseUrl,
  probeLocalProxy,
  PROVIDER_PRESETS,
  type ProviderConfig,
  type ProviderPresetId,
  type ProviderProtocol,
} from '../../services/api/providers.js'
import {
  getActiveProvider,
  removeProvider,
  selectActiveProvider,
  setContextBudget,
  setCorsProxyUrl,
  setSystemPrompt,
  SYSTEM_PROMPT_PRESETS,
  upsertProvider,
  useSettings,
} from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import styles from './ProviderSettings.module.css'

export const ProviderSettings = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const providers = useSettings((state) => state.providers)
  const activeProviderId = useSettings((state) => state.activeProviderId)
  const corsProxyUrl = useSettings((state) => state.corsProxyUrl)
  const contextMaxRounds = useSettings((state) => state.contextMaxRounds)
  const contextMaxTokens = useSettings((state) => state.contextMaxTokens)
  const systemPrompt = useSettings((state) => state.systemPrompt)

  const activeProvider = useMemo(
    () => getActiveProvider({ providers, activeProviderId }),
    [providers, activeProviderId]
  )

  const [draft, setDraft] = useState<ProviderConfig>(activeProvider)
  const [proxyDraft, setProxyDraft] = useState(corsProxyUrl || '/_proxy')
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])
  const [verifying, setVerifying] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const [localProxyAvailable, setLocalProxyAvailable] = useState(false)
  const datalistId = useId()
  const apiKeyId = useId()

  useEffect(() => {
    let active = true
    void probeLocalProxy().then((ok) => {
      if (active) {
        setLocalProxyAvailable(ok)
        if (ok) {
          setDraft((prev) =>
            prev.id === 'default-deepseek-official' && !prev.apiKey.trim() && !prev.useCorsProxy
              ? { ...prev, useCorsProxy: true }
              : prev
          )
        }
      }
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setDraft(activeProvider)
  }, [activeProvider])

  useEffect(() => {
    setDiscoveredModels([])
    setStatus(null)
    setShowApiKey(false)
  }, [activeProvider.id])

  useEffect(() => {
    setProxyDraft(corsProxyUrl || '/_proxy')
  }, [corsProxyUrl])

  const isDirty = useMemo(
    () =>
      draft.preset !== activeProvider.preset ||
      draft.protocol !== activeProvider.protocol ||
      draft.name !== activeProvider.name ||
      draft.baseUrl !== activeProvider.baseUrl ||
      draft.apiKey !== activeProvider.apiKey ||
      draft.model !== activeProvider.model ||
      draft.useCorsProxy !== activeProvider.useCorsProxy ||
      (draft.useCorsProxy && proxyDraft.trim() !== (corsProxyUrl || '/_proxy')),
    [draft, activeProvider, proxyDraft, corsProxyUrl]
  )

  const presetMeta = findProviderPreset(draft.preset)
  const modelSuggestions = useMemo(
    () => [...new Set([...discoveredModels, ...presetMeta.modelSuggestions])],
    [discoveredModels, presetMeta]
  )

  const applyPreset = (presetId: ProviderPresetId) => {
    const preset = findProviderPreset(presetId)
    setDraft((prev) => ({
      ...prev,
      preset: preset.id,
      name: locale === 'zh-CN' ? preset.nameZh : preset.nameEn,
      protocol: preset.protocol,
      baseUrl: preset.defaultBaseUrl,
      model: preset.defaultModel,
      ...(localProxyAvailable ? { useCorsProxy: true } : {}),
    }))
    setDiscoveredModels([])
    setStatus(null)
  }

  const addNewProfile = () => {
    const preset = findProviderPreset('opencode-go')
    const next: ProviderConfig = {
      id: createId(),
      preset: preset.id,
      name: locale === 'zh-CN' ? preset.nameZh : preset.nameEn,
      protocol: preset.protocol,
      baseUrl: preset.defaultBaseUrl,
      apiKey: '',
      model: preset.defaultModel,
      useCorsProxy: localProxyAvailable,
    }
    upsertProvider(next, true)
    setDraft(next)
    setStatus(null)
  }

  const validateDraft = (): ProviderConfig | null => {
    const cleanBase = normalizeBaseUrl(draft.baseUrl)
    const cleanModel = draft.model.trim()
    const cleanKey = draft.apiKey.trim()
    if (!isValidHttpBaseUrl(cleanBase)) {
      setStatus({ text: t('providerInvalidUrl'), error: true })
      return null
    }
    if (!cleanModel) {
      setStatus({ text: t('providerNeedModel'), error: true })
      return null
    }
    if (presetMeta.requiresApiKey && !cleanKey) {
      setStatus({ text: t('apiKeyPlaceholder'), error: true })
      return null
    }
    return {
      ...draft,
      name: draft.name.trim() || presetMeta.nameZh,
      baseUrl: cleanBase,
      apiKey: cleanKey,
      model: cleanModel,
    }
  }

  const saveDirect = () => {
    const valid = validateDraft()
    if (!valid) {
      return
    }
    if (valid.useCorsProxy) {
      setCorsProxyUrl(proxyDraft.trim() || '/_proxy')
    }
    upsertProvider(valid, true)
    setStatus({ text: t('providerSaved'), error: false })
  }

  const verifyAndSave = async () => {
    const valid = validateDraft()
    if (!valid || verifying) {
      return
    }
    const effectiveProxy = proxyDraft.trim() || '/_proxy'
    if (valid.useCorsProxy) {
      setCorsProxyUrl(effectiveProxy)
    }
    setVerifying(true)
    setStatus(null)
    try {
      const models = await verifyProvider(valid, effectiveProxy)
      if (models.length > 0) {
        setDiscoveredModels(models)
      }
      upsertProvider(valid, true)
      setStatus({
        text:
          models.length > 0
            ? t('providerVerifySuccess', { count: models.length })
            : t('providerVerifyNoModels'),
        error: false,
      })
    } catch (error) {
      const kind = classifyApiError(error)
      const message =
        kind === 'unauthorized'
          ? t('apiKeyInvalid')
          : kind === 'network'
            ? t('networkCorsHint')
            : t('apiKeyVerificationFailed', {
                message:
                  error instanceof ApiError && error.localMessage
                    ? t(error.localMessage.key, error.localMessage.params)
                    : error instanceof Error
                      ? error.message
                      : String(error),
              })
      setStatus({ text: message, error: true })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.heading}>{t('providerLabel')}</div>
        <div className={styles.profileBar}>
          <Select
            ariaLabel={t('providerLabel')}
            className={styles.profileSelect}
            value={activeProvider.id}
            options={providers.map((item) => ({
              value: item.id,
              label: `${item.name} (${item.model})`,
            }))}
            onChange={(value) => selectActiveProvider(value)}
          />
          <Button variant="outlined" size="m" onClick={addNewProfile}>
            {t('providerNewProfile')}
          </Button>
          {providers.length > 1 ? (
            <Button
              variant="dangerOutlined"
              size="m"
              onClick={() => removeProvider(activeProvider.id)}
            >
              {t('providerDeleteProfile')}
            </Button>
          ) : null}
        </div>

        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('providerPresetLabel')}</span>
            <Select
              ariaLabel={t('providerPresetLabel')}
              value={draft.preset}
              options={PROVIDER_PRESETS.map((p) => ({
                value: p.id,
                label: locale === 'zh-CN' ? p.nameZh : p.nameEn,
              }))}
              onChange={(val) => applyPreset(val as ProviderPresetId)}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('providerProtocolLabel')}</span>
            <Select
              ariaLabel={t('providerProtocolLabel')}
              value={draft.protocol}
              options={[
                { value: 'deepseek-anthropic', label: 'DeepSeek 官方 Anthropic（含工具）' },
                { value: 'openai', label: 'OpenAI Chat Completions 兼容' },
                { value: 'anthropic', label: 'Anthropic Messages 兼容' },
              ]}
              onChange={(val) =>
                setDraft((prev) => ({ ...prev, protocol: val as ProviderProtocol }))
              }
            />
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('providerProfileName')}</span>
            <input
              type="text"
              className={styles.input}
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('providerModelLabel')}</span>
            <input
              type="text"
              list={datalistId}
              className={styles.input}
              value={draft.model}
              placeholder="deepseek-flash / deepseek-v4.1-flash"
              onChange={(e) => setDraft((prev) => ({ ...prev, model: e.target.value }))}
            />
            <datalist id={datalistId}>
              {modelSuggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.fieldLabel}>{t('providerBaseUrlLabel')}</span>
            <input
              type="url"
              className={styles.input}
              value={draft.baseUrl}
              placeholder="https://api.deepseek.com"
              spellCheck={false}
              onChange={(e) => setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
            />
          </label>

          <div className={`${styles.field} ${styles.fieldFull}`}>
            <label htmlFor={apiKeyId} className={styles.fieldLabel}>
              {t('providerApiKeyLabel')}
            </label>
            <div className={styles.keyRow}>
              <input
                id={apiKeyId}
                type={showApiKey ? 'text' : 'password'}
                className={styles.input}
                value={draft.apiKey}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  presetMeta.requiresApiKey ? t('apiKeyPlaceholder') : t('providerApiKeyOptional')
                }
                onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
              <Button
                variant="outlined"
                size="m"
                onClick={() => setShowApiKey((visible) => !visible)}
              >
                {showApiKey ? t('providerHideApiKey') : t('providerShowApiKey')}
              </Button>
            </div>
          </div>
        </div>

        <div className={styles.hint}>
          {locale === 'zh-CN' ? presetMeta.hintZh : presetMeta.hintEn}
        </div>

        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={draft.useCorsProxy}
            onChange={(e) => setDraft((prev) => ({ ...prev, useCorsProxy: e.target.checked }))}
          />
          <span>{t('providerCorsProxyToggle')}</span>
        </label>

        {draft.useCorsProxy ? (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('providerCorsProxyUrlLabel')}</span>
            <input
              type="text"
              className={styles.input}
              value={proxyDraft}
              placeholder="/_proxy"
              spellCheck={false}
              onChange={(e) => setProxyDraft(e.target.value)}
            />
          </label>
        ) : null}

        <div className={styles.actions}>
          <Button
            variant="primary"
            size="m"
            disabled={verifying}
            onClick={() => void verifyAndSave()}
          >
            {verifying ? t('apiKeyVerifying') : t('providerSaveVerify')}
          </Button>
          <Button variant="outlined" size="m" disabled={verifying} onClick={saveDirect}>
            {t('providerSaveDirect')}
          </Button>
          {isDirty ? <span className={styles.hint}>{t('providerUnsavedHint')}</span> : null}
        </div>
        {status ? (
          <div className={status.error ? styles.statusError : styles.statusOk}>{status.text}</div>
        ) : null}
      </div>

      <div className={styles.section}>
        <div className={styles.heading}>{t('contextBudgetSection')}</div>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('contextMaxRoundsLabel')}</span>
            <Select
              ariaLabel={t('contextMaxRoundsLabel')}
              value={String(contextMaxRounds)}
              options={[
                { value: '6', label: t('contextRoundsOption', { count: 6 }) },
                { value: '12', label: t('contextRoundsOption', { count: 12 }) },
                { value: '20', label: t('contextRoundsOption', { count: 20 }) },
                { value: '40', label: t('contextRoundsOption', { count: 40 }) },
                { value: '0', label: t('contextUnlimited') },
              ]}
              onChange={(val) => setContextBudget(Number(val), contextMaxTokens)}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('contextMaxTokensLabel')}</span>
            <Select
              ariaLabel={t('contextMaxTokensLabel')}
              value={String(contextMaxTokens)}
              options={[
                { value: '8000', label: '~8K tokens' },
                { value: '24000', label: '~24K tokens' },
                { value: '64000', label: '~64K tokens' },
                { value: '0', label: t('contextUnlimited') },
              ]}
              onChange={(val) => setContextBudget(contextMaxRounds, Number(val))}
            />
          </div>

          <div className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.fieldLabel}>{t('contextSystemPromptLabel')}</span>
            <div className={styles.presetPills}>
              {SYSTEM_PROMPT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={styles.pill}
                  onClick={() => setSystemPrompt(preset.prompt)}
                >
                  {locale === 'zh-CN' ? preset.labelZh : preset.labelEn}
                </button>
              ))}
            </div>
            <textarea
              className={styles.textarea}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
