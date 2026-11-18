import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  BackupError,
  inspectBackupArchive,
  type ImportBackupOptions,
  type MergeConflictPolicy,
  type SessionIndexEntry,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './ImportDialog.module.css'

type ImportDialogProps = {
  file: File
  onCancel: () => void
  onConfirm: (options: ImportBackupOptions) => Promise<void>
}

const isChunkLoadError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }
  return (
    error.name === 'ChunkLoadError' ||
    /Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/iu.test(
      error.message
    )
  )
}

export const ImportDialog = ({ file, onCancel, onConfirm }: ImportDialogProps) => {
  const t = useTranslate()
  const existingSessions = useChatStore((state) => state.sessions)
  const existingIds = useMemo(() => new Set(existingSessions.map((s) => s.id)), [existingSessions])
  const [entries, setEntries] = useState<SessionIndexEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [conflictPolicy, setConflictPolicy] = useState<MergeConflictPolicy>('keep-existing')
  const [stripSearchBlocks, setStripSearchBlocks] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setLoadError(null)
    void inspectBackupArchive(file)
      .then((list) => {
        if (cancelled) {
          return
        }
        setEntries(list)
        // 超过 40 条会话的超大归档默认先选最近 20 条，防手机浏览器误全量导入过载，可一键全选
        const initial = list.length > 40 ? list.slice(0, 20) : list
        setSelectedIds(new Set(initial.map((item) => item.id)))
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        if (isChunkLoadError(error)) {
          const reloadKey = 'ds-chunk-reload-once'
          if (typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(reloadKey)) {
            sessionStorage.setItem(reloadKey, '1')
            window.location.reload()
            return
          }
        }
        setLoadError(error instanceof BackupError ? t(error.key) : t('historyImportFailed'))
      })
    return () => {
      cancelled = true
    }
  }, [file, t])

  const filtered = useMemo(() => {
    if (!entries) {
      return []
    }
    const q = query.trim().toLowerCase()
    if (!q) {
      return entries
    }
    return entries.filter((item) => (item.title ?? '').toLowerCase().includes(q))
  }, [entries, query])

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const conflictCount = useMemo(() => {
    let count = 0
    for (const id of selectedIds) {
      if (existingIds.has(id)) {
        count += 1
      }
    }
    return count
  }, [existingIds, selectedIds])

  const runConfirm = async () => {
    if (busy || !entries || selectedIds.size === 0) {
      return
    }
    setBusy(true)
    try {
      const allSelected = selectedIds.size === entries.length
      await onConfirm({
        selectedIds: allSelected ? undefined : selectedIds,
        mode,
        conflictPolicy,
        copyTitleSuffix: t('historyImportCopySuffix'),
        stripSearchBlocks,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('historyImportPreviewTitle')}
      className={styles.modal}
      onClose={() => {
        if (!busy) {
          onCancel()
        }
      }}
      footer={
        <>
          <Button variant="outlined" size="m" disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            variant={mode === 'replace' ? 'dangerOutlined' : 'primary'}
            size="m"
            disabled={busy || !entries || selectedIds.size === 0}
            onClick={() => void runConfirm()}
          >
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {loadError ? (
          <div>{loadError}</div>
        ) : entries === null ? (
          <div>{t('historyImportReadingIndex')}</div>
        ) : (
          <>
            <div className={styles.toolbar}>
              <input
                type="search"
                className={styles.searchInput}
                placeholder={t('historyImportSearchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  if (query.trim()) {
                    setSelectedIds((prev) => {
                      const next = new Set(prev)
                      for (const item of filtered) {
                        next.add(item.id)
                      }
                      return next
                    })
                  } else {
                    setSelectedIds(new Set(entries.map((item) => item.id)))
                  }
                }}
              >
                {t('historyImportSelectAll')}
              </Button>
              <Button
                variant="outlined"
                size="s"
                onClick={() => setSelectedIds(new Set(entries.slice(0, 20).map((item) => item.id)))}
              >
                {t('historyImportSelectRecent')}
              </Button>
              <Button variant="outlined" size="s" onClick={() => setSelectedIds(new Set())}>
                {t('historyImportSelectNone')}
              </Button>
            </div>
            <div className={styles.countInfo}>
              {t('historyImportCountInfo', {
                total: entries.length,
                selected: selectedIds.size,
              })}
            </div>
            <div className={styles.safeBanner}>{t('historyImportSafeBanner')}</div>
            <div className={styles.list}>
              {filtered.map((item) => (
                <label key={item.id} className={styles.item}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => toggleId(item.id)}
                  />
                  <span className={styles.itemTitle}>{item.title || t('untitledChat')}</span>
                  {existingIds.has(item.id) ? (
                    <span className={styles.conflictBadge}>{t('historyImportConflictTag')}</span>
                  ) : null}
                  <span className={styles.itemMeta}>
                    {item.message_count} · {item.updated_at.slice(0, 10)}
                  </span>
                </label>
              ))}
            </div>
            <div className={styles.options}>
              <label className={styles.optionRow}>
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === 'merge'}
                  onChange={() => setMode('merge')}
                />
                <span>{t('historyImportModeMerge')}</span>
              </label>
              {mode === 'merge' && conflictCount > 0 ? (
                <div className={styles.conflictBox}>
                  <div className={styles.conflictHeader}>
                    {t('historyImportConflictSummary', { count: conflictCount })}
                  </div>
                  <label className={styles.optionRow}>
                    <input
                      type="radio"
                      name="merge-conflict-policy"
                      checked={conflictPolicy === 'keep-existing'}
                      onChange={() => setConflictPolicy('keep-existing')}
                    />
                    <span>{t('historyImportConflictKeepExisting')}</span>
                  </label>
                  <label className={styles.optionRow}>
                    <input
                      type="radio"
                      name="merge-conflict-policy"
                      checked={conflictPolicy === 'keep-both'}
                      onChange={() => setConflictPolicy('keep-both')}
                    />
                    <span>{t('historyImportConflictKeepBoth')}</span>
                  </label>
                  <label className={styles.optionRow}>
                    <input
                      type="radio"
                      name="merge-conflict-policy"
                      checked={conflictPolicy === 'overwrite'}
                      onChange={() => setConflictPolicy('overwrite')}
                    />
                    <span>{t('historyImportConflictOverwrite')}</span>
                  </label>
                </div>
              ) : null}
              <details className={styles.advancedOptions}>
                <summary className={styles.advancedSummary}>
                  {t('historyImportMoreOptions')}
                </summary>
                <div className={styles.advancedBody}>
                  <label className={styles.optionRow}>
                    <input
                      type="radio"
                      name="import-mode"
                      checked={mode === 'replace'}
                      onChange={() => setMode('replace')}
                    />
                    <span>{t('historyImportModeReplace')}</span>
                  </label>
                  <label className={styles.optionRow}>
                    <input
                      type="checkbox"
                      checked={stripSearchBlocks}
                      onChange={(e) => setStripSearchBlocks(e.target.checked)}
                    />
                    <span>{t('historyImportStripSearch')}</span>
                  </label>
                </div>
              </details>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
