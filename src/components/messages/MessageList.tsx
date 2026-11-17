import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const INITIAL_WINDOW_SIZE = 60
const WINDOW_STEP = 60
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const prependingAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_WINDOW_SIZE)
  const messages = useMemo(() => getVisibleMessages(session), [session])

  useEffect(() => {
    setVisibleLimit(INITIAL_WINDOW_SIZE)
    prependingAnchorRef.current = null
  }, [session.id])
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const hiddenCount = Math.max(0, messages.length - visibleLimit)
  const windowedMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages
  const uploadRetryId = getUploadRetryId(messages, streaming)

  // 切换版本后将选择器留在原位置；若新分支更长导致锚点被折叠，先扩大窗口再恢复位置。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const anchorIndex = messages.findIndex((message) => message.id === anchor.messageId)
      if (anchorIndex >= 0 && anchorIndex < hiddenCount) {
        setVisibleLimit((prev) => Math.max(prev, messages.length - anchorIndex + 10))
        return
      }
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, hiddenCount, messages, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  useLayoutEffect(() => {
    const anchor = prependingAnchorRef.current
    const scroll = scrollRef.current
    if (!anchor || !scroll) {
      return
    }
    scroll.scrollTop = anchor.scrollTop + (scroll.scrollHeight - anchor.scrollHeight)
    scrollTopRef.current = scroll.scrollTop
    prependingAnchorRef.current = null
  }, [hiddenCount])

  const expandWindow = (nextLimit: number) => {
    const scroll = scrollRef.current
    if (scroll) {
      prependingAnchorRef.current = {
        scrollHeight: scroll.scrollHeight,
        scrollTop: scroll.scrollTop,
      }
      stickyRef.current = false
    }
    setVisibleLimit(nextLimit)
  }

  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column}>
            {hiddenCount > 0 ? (
              <div className={styles.windowBanner}>
                <span>{t('messageWindowEarlier', { count: hiddenCount })}</span>
                <div className={styles.windowActions}>
                  <button
                    type="button"
                    className={styles.windowButton}
                    onClick={() => expandWindow(visibleLimit + WINDOW_STEP)}
                  >
                    {t('messageWindowLoadMore')}
                  </button>
                  <button
                    type="button"
                    className={styles.windowButton}
                    onClick={() => expandWindow(messages.length)}
                  >
                    {t('messageWindowShowAll')}
                  </button>
                </div>
              </div>
            ) : null}
            {windowedMessages.map((message, offset) => {
              const index = hiddenCount + offset
              return message.role === 'user' ? (
                <UserMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  retryUploadId={uploadRetryId}
                  isFirst={index === 0}
                  isLast={index === lastIndex || index === lastIndex - 1}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  isLast={index === lastIndex}
                  streaming={streaming && index === lastIndex}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              )
            })}
          </div>
        </div>
        {footer}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
