import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translate } from '../../i18n/index.js'
import { redactApiSecrets } from '../../services/api/client.js'
import { exportEmergencyBackup } from '../../services/chat/backup.js'
import styles from './ErrorBoundary.module.css'

type Props = {
  children: ReactNode
}

type State = {
  errorMessage: string | null
  exporting: boolean
  exportStatus: string | null
  exportWarning: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {
    errorMessage: null,
    exporting: false,
    exportStatus: null,
    exportWarning: false,
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const raw = error instanceof Error ? error.message : String(error)
    return {
      errorMessage: redactApiSecrets(raw || 'Unexpected rendering error'),
    }
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // 异常摘要已脱敏展示于降级界面，不将本地敏感状态外传
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleEmergencyBackup = async () => {
    if (this.state.exporting) {
      return
    }
    this.setState({ exporting: true, exportStatus: null, exportWarning: false })
    try {
      const result = await exportEmergencyBackup()
      const url = URL.createObjectURL(result.blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = result.name
        document.body.append(a)
        a.click()
        a.remove()
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      if (result.skippedIds.length > 0) {
        const idsPreview =
          result.skippedIds.length > 3
            ? `${result.skippedIds.slice(0, 3).join(', ')}...`
            : result.skippedIds.join(', ')
        this.setState({
          exporting: false,
          exportWarning: true,
          exportStatus: translate('crashRecoveryExportPartial', {
            exported: result.exportedCount,
            total: result.totalCount,
            skipped: result.skippedIds.length,
            ids: idsPreview,
          }),
        })
        return
      }
      this.setState({
        exporting: false,
        exportWarning: false,
        exportStatus: translate('crashRecoveryExported', { count: result.exportedCount }),
      })
    } catch (err) {
      const msg = redactApiSecrets(err instanceof Error ? err.message : String(err))
      this.setState({ exporting: false, exportWarning: true, exportStatus: msg })
    }
  }

  override render(): ReactNode {
    const { errorMessage, exporting, exportStatus, exportWarning } = this.state
    if (!errorMessage) {
      return this.props.children
    }
    return (
      <div className={styles.wrap} role="alert">
        <div className={styles.card}>
          <h1 className={styles.title}>{translate('crashRecoveryTitle')}</h1>
          <p className={styles.desc}>{translate('crashRecoveryDesc')}</p>
          <pre className={styles.detail}>{errorMessage}</pre>
          {exportStatus ? (
            <p className={exportWarning ? styles.warning : styles.status}>{exportStatus}</p>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={this.handleReload}>
              {translate('crashRecoveryReload')}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={exporting}
              onClick={this.handleEmergencyBackup}
            >
              {translate('crashRecoveryExport')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
