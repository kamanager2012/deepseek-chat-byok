import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translate } from '../../i18n/index.js'
import { redactApiSecrets } from '../../services/api/client.js'
import * as db from '../../services/chat/db.js'
import { exportArchive } from '../../services/chat/history/exportArchive.js'
import type { Session } from '../../services/chat/types.js'
import { formatDate } from '../../utils/format.js'
import styles from './ErrorBoundary.module.css'

type Props = {
  children: ReactNode
}

type State = {
  errorMessage: string | null
  exporting: boolean
  exportStatus: string | null
}

/** 顶层渲染异常兜底：避免极端畸形数据造成整页白屏，并允许直接从 IndexedDB 导出急救备份 */
async function* readSessionsFromDb(
  summaries: Awaited<ReturnType<typeof db.loadSessionSummaries>>
): AsyncGenerator<Session> {
  for (const summary of summaries) {
    const loaded = await db.loadSession(summary.id)
    if (loaded) {
      yield { ...loaded, ...summary }
    }
  }
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {
    errorMessage: null,
    exporting: false,
    exportStatus: null,
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
    this.setState({ exporting: true, exportStatus: null })
    try {
      const summaries = await db.loadSessionSummaries()
      const blob = await exportArchive(readSessionsFromDb(summaries))
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = `deepseek_emergency-${formatDate(new Date())}.zip`
        document.body.append(a)
        a.click()
        a.remove()
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      this.setState({
        exporting: false,
        exportStatus: translate('crashRecoveryExported', { count: summaries.length }),
      })
    } catch (err) {
      const msg = redactApiSecrets(err instanceof Error ? err.message : String(err))
      this.setState({ exporting: false, exportStatus: msg })
    }
  }

  override render(): ReactNode {
    const { errorMessage, exporting, exportStatus } = this.state
    if (!errorMessage) {
      return this.props.children
    }
    return (
      <div className={styles.wrap} role="alert">
        <div className={styles.card}>
          <h1 className={styles.title}>{translate('crashRecoveryTitle')}</h1>
          <p className={styles.desc}>{translate('crashRecoveryDesc')}</p>
          <pre className={styles.detail}>{errorMessage}</pre>
          {exportStatus ? <p className={styles.status}>{exportStatus}</p> : null}
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
