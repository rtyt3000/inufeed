import type { FeedFolder } from './folders.js'
import { cachedFeedChannels } from './chat-list.js'
import { STAND_IN_BASE, getFolderChannels } from './folders.js'

const PAGE_SIZE = 30
const BATCH_SIZE = 20
const READ_DEBOUNCE_MS = 1000
/** already read posts loaded below the read position on open */
const READ_CONTEXT = 10
/** a first page can't hold more; with more unread posts the feed opens at the oldest that fits */
const MAX_FIRST_PAGE = 180

/**
 * Marks a channel read up to `maxId` the way the app's own chat screen does: it updates the app's
 * counters and notifications and sends the read to the server. `account.readHistory` only does the
 * latter, and the server doesn't echo it back to this session, so the counters would stay stale
 */
function markReadInApp(slot: number, peer: number, maxId: number, date: number, countDiff: number): void {
  const controller = inu.jvm.cls('org.telegram.messenger.MessagesController').callStatic('getInstance', slot)
  const dialogId = inu.utils.peers.toSimpleDialogId(peer)
  const read = inu.jvm.routine(function () {
    controller.markDialogAsRead(dialogId, maxId, maxId, date, false, 0, countDiff, true, 0)
  })
  inu.jvm.cls('org.telegram.messenger.AndroidUtilities').callStatic('runOnUIThread', read)
}

/** Marks every channel of a feed read, as "mark as read" on its row does */
export async function markFeedRead(account: inu.Account, folderId: number): Promise<void> {
  for (const peer of await getFolderChannels(account, folderId)) {
    const dialog = account.getDialog(peer)
    if (!dialog || dialog._ !== 'dialog' || dialog.unread_count === 0) continue
    markReadInApp(account.id, peer, dialog.top_message, 0, dialog.unread_count)
  }
}

/** The newest post seen in the feed, which is where it opens next time */
interface ReadPosition {
  date: number
  id: number
}

function positionKey(userId: number, folderId: number): string {
  return `feedPosition:${userId}:${folderId}`
}

function loadPosition(userId: number, folderId: number): ReadPosition | null {
  try {
    // single-folder versions kept one position per account
    const stored = localStorage.getItem(positionKey(userId, folderId)) ?? localStorage.getItem(`feedPosition:${userId}`)
    return stored === null ? null : JSON.parse(stored) as ReadPosition
  } catch {
    return null
  }
}

function savePosition(userId: number, folderId: number, position: ReadPosition): void {
  localStorage.setItem(positionKey(userId, folderId), JSON.stringify(position))
}

interface Source {
  peer: number
  /** fetched but not yet shown, newest first */
  buffer: inu.Message[]
  offsetId: number
  done: boolean
}

interface Shown {
  peer: number
  id: number
  date: number
}

/**
 * A post's bubble is drawn with its author's avatar, and a channel post's author (`from_id`) is
 * usually missing; in a feed the source channel is the author
 */
function feedEntry(peer: number, message: inu.Message): inu.ui.ChatHistoryEntry {
  const raw = structuredClone(message.raw)
  if (raw._ === 'message' && raw.from_id == null) {
    const parsed = inu.utils.peers.parseMarkedPeerId(peer)
    if (parsed.type === 'channel') raw.from_id = { _: 'peerChannel', channel_id: parsed.id }
    else if (parsed.type === 'chat') raw.from_id = { _: 'peerChat', chat_id: parsed.id }
  }
  return { message: raw, key: entryKey(peer, message.id) }
}

function entryKey(peer: number, id: number): string {
  return `${peer}:${id}`
}

function isNewer(a: { date: number, id: number }, b: { date: number, id: number }): boolean {
  return a.date !== b.date ? a.date > b.date : a.id > b.id
}

/** posts kept per channel; older ones are fetched again when scrolled to */
const CACHE_LIMIT = 500

/**
 * Posts already loaded, per account and channel: a run from the newest post down, without gaps,
 * so reopening and scrolling a feed doesn't ask the server again. It lives as long as the plugin
 */
interface ChannelCache {
  /** newest first */
  messages: inu.Message[]
  /** the channel has nothing older */
  complete: boolean
}

const historyCache = new Map<string, ChannelCache>()

function cacheKey(account: inu.Account, peer: number): string {
  return `${account.id}:${peer}`
}

/** The cache of a channel with its newest posts brought up to date */
async function freshCache(account: inu.Account, peer: number): Promise<ChannelCache> {
  // the app's own cache is quick, and has new posts as soon as they arrive
  const newest = (await account.getHistory(peer, { limit: BATCH_SIZE })).sort((a, b) => b.id - a.id)
  const key = cacheKey(account, peer)
  const cache = historyCache.get(key)
  const oldestNew = newest[newest.length - 1]?.id ?? 0
  if (cache && cache.messages.length > 0 && oldestNew <= cache.messages[0].id) {
    // the newest posts reach the cached run: replace its head, which may hold edited posts
    const older = cache.messages.filter(m => m.id < oldestNew)
    cache.messages = [...newest, ...older]
    return cache
  }
  // nothing cached, or a gap between the cache and the newest posts
  const fresh: ChannelCache = { messages: newest, complete: newest.length < BATCH_SIZE }
  historyCache.set(key, fresh)
  return fresh
}

/** Posts of a channel older than `beforeId`, from the cache or else the server */
async function olderPosts(account: inu.Account, peer: number, beforeId: number): Promise<inu.Message[]> {
  const cache = historyCache.get(cacheKey(account, peer))
  if (!cache) return []
  const cached = cache.messages.filter(m => m.id < beforeId).slice(0, BATCH_SIZE)
  if (cached.length > 0 || cache.complete) return cached

  // the cached read ignores offsetId and returns the newest posts again, so this asks the server
  const fetched = (await account.getHistory(peer, { offsetId: beforeId, limit: BATCH_SIZE, force: true }))
    .filter(m => m.id < beforeId)
    .sort((a, b) => b.id - a.id)
  const oldest = cache.messages[cache.messages.length - 1]?.id ?? Infinity
  if (beforeId <= oldest) {
    cache.messages.push(...fetched)
    if (fetched.length === 0) cache.complete = true
    if (cache.messages.length > CACHE_LIMIT) {
      cache.messages = cache.messages.slice(0, CACHE_LIMIT)
      cache.complete = false
    }
  }
  return fetched
}

/** Keeps cached posts in step with edits and deletions seen while a feed is open */
function updateCached(account: inu.Account, peer: number, edit: (messages: inu.Message[]) => inu.Message[]): void {
  const cache = historyCache.get(cacheKey(account, peer))
  if (cache) cache.messages = edit(cache.messages)
}

/** Merges the histories of several channels into one stream, newest first */
class Merger {
  private sources: Source[]

  constructor(private account: inu.Account, peers: number[]) {
    this.sources = peers.map(peer => ({ peer, buffer: [], offsetId: 0, done: false }))
  }

  get exhausted(): boolean {
    return this.sources.every(s => s.done && s.buffer.length === 0)
  }

  private async refill(): Promise<void> {
    const empty = this.sources.filter(s => !s.done && s.buffer.length === 0)
    if (empty.length === 0) return

    await Promise.all(empty.map(async (source) => {
      try {
        const batch = source.offsetId === 0
          ? (await freshCache(this.account, source.peer)).messages.slice(0, BATCH_SIZE)
          : await olderPosts(this.account, source.peer, source.offsetId)
        if (batch.length === 0) {
          source.done = true
          return
        }
        source.offsetId = batch[batch.length - 1].id
        source.buffer.push(...batch.filter(m => !m.isService))
      } catch (e) {
        console.warn('feed: history failed for', source.peer, e)
        source.done = true
      }
    }))
  }

  async take(count: number): Promise<{ peer: number, message: inu.Message }[]> {
    const out: { peer: number, message: inu.Message }[] = []
    while (out.length < count) {
      // a channel with an empty buffer could still hold the newest message, so refill before picking
      await this.refill()

      let best: Source | null = null
      for (const source of this.sources) {
        if (source.buffer.length === 0) continue
        if (!best || isNewer(source.buffer[0], best.buffer[0])) best = source
      }
      if (!best) break

      // a fully filtered batch leaves the buffer empty without finishing the source
      const message = best.buffer.shift()!
      out.push({ peer: best.peer, message })

      // an album is drawn as one bubble, with its caption, only when its parts are adjacent, and
      // other channels' posts share its date
      const album = message.groupedId
      while (album !== null) {
        if (best.buffer.length === 0) {
          if (best.done) break
          await this.refill()
          if (best.buffer.length === 0) break
        }
        if (best.buffer[0].groupedId !== album) break
        out.push({ peer: best.peer, message: best.buffer.shift()! })
      }
    }
    return out
  }
}

let current: inu.ui.ChatHistory | null = null

export async function openFeed(
  account: inu.Account,
  folder: FeedFolder,
  markRead: boolean,
  actions: { restore(): void, settings(): void },
): Promise<void> {
  current?.close()

  // the chat list keeps the channels of every feed; asking the server takes a while
  const peers = cachedFeedChannels(account.id, folder.id) ?? await getFolderChannels(account, folder.id)
  if (peers.length === 0) {
    inu.ui.toast(`В папке «${folder.title}» нет каналов`)
    return
  }
  const peerSet = new Set(peers)
  const chats = account.getChats(peers).filter((c): c is tl.TypeChat => c !== null)

  const shown = new Map<string, Shown>()
  const pendingRead = new Map<number, number>()
  const sentRead = new Map<number, number>()
  for (const peer of peers) {
    const dialog = account.getDialog(peer)
    if (dialog && dialog._ === 'dialog') sentRead.set(peer, dialog.read_inbox_max_id)
  }

  let merger = new Merger(account, peers)
  // the screen may ask for pages concurrently; the merger is stateful, so serialize
  let queue: Promise<unknown> = Promise.resolve()

  function toEntries(items: { peer: number, message: inu.Message }[]): inu.ui.ChatHistoryEntry[] {
    return items.map(({ peer, message }) => {
      const key = entryKey(peer, message.id)
      shown.set(key, { peer, id: message.id, date: message.date })
      return feedEntry(peer, message)
    })
  }

  let position = loadPosition(account.userId, folder.id)

  async function loadFirstPage(): Promise<inu.ui.ChatHistoryPage> {
    merger = new Merger(account, peers)
    shown.clear()

    // load down to the feed's read position, plus some read posts for context
    const items: { peer: number, message: inu.Message }[] = []
    let read = 0
    do {
      const batch = await merger.take(PAGE_SIZE)
      if (batch.length === 0 || !position) {
        items.push(...batch)
        break
      }
      items.push(...batch)
      read += batch.filter(item => !isNewer(item.message, position!)).length
    } while (read < READ_CONTEXT && items.length + PAGE_SIZE <= MAX_FIRST_PAGE)

    const entries = toEntries(items)
    const page: inu.ui.ChatHistoryPage = { entries, chats }
    if (!merger.exhausted) page.next = 'older'

    if (position) {
      const unread = items.filter(item => isNewer(item.message, position!))
      // newest first, so the last one is the oldest unread
      if (unread.length > 0) {
        const oldest = unread[unread.length - 1]
        page.firstUnread = entryKey(oldest.peer, oldest.message.id)
      }
      page.unreadCount = unread.length
    }
    // the screen opens at the newest post then, and onRead only fires when scrolling down to one
    if (!page.firstUnread && entries.length > 0) markSeen(entries[0].key!)
    return page
  }

  async function loadPage(cursor: string | null, direction: 'older' | 'newer'): Promise<inu.ui.ChatHistoryPage> {
    if (cursor === null) return loadFirstPage()
    // the first page always reaches the newest post; live posts arrive through append
    if (direction === 'newer') return { entries: [] }

    const page: inu.ui.ChatHistoryPage = { entries: toEntries(await merger.take(PAGE_SIZE)), chats }
    if (!merger.exhausted) page.next = 'older'
    return page
  }

  let pendingPosition: Shown | null = null
  let readTimer: ReturnType<typeof setTimeout> | null = null

  /** Records `key` as the newest post the user has seen */
  function markSeen(key: string): void {
    const last = shown.get(key)
    if (!last) return
    if (!pendingPosition || isNewer(last, pendingPosition)) pendingPosition = last
    if (markRead) {
      // everything at or before the newest seen post counts as read, in every channel
      for (const item of shown.values()) {
        if (isNewer(item, last)) continue
        if (item.id > (pendingRead.get(item.peer) ?? 0)) pendingRead.set(item.peer, item.id)
      }
    }
    readTimer ??= setTimeout(flushRead, READ_DEBOUNCE_MS)
  }
  function flushRead(): void {
    readTimer = null
    if (pendingPosition && (!position || isNewer(pendingPosition, position))) {
      position = { date: pendingPosition.date, id: pendingPosition.id }
      savePosition(account.userId, folder.id, position)
    }
    pendingPosition = null
    if (!markRead) return
    for (const [peer, maxId] of pendingRead) {
      const readBefore = sentRead.get(peer) ?? 0
      if (maxId <= readBefore) continue
      sentRead.set(peer, maxId)
      const date = shown.get(entryKey(peer, maxId))?.date ?? 0
      // channel message ids are sequential, so this is how many posts became read
      markReadInApp(account.id, peer, maxId, date, maxId - readBefore)
    }
    pendingRead.clear()
  }

  const history = inu.ui.openChatHistory({
    title: folder.title,
    subtitle: `${peers.length} ${channelsWord(peers.length)}`,
    // the feed's stand-in group: its own avatar, or its initials
    icon: inu.icons.avatar(-(1_000_000_000_000 + STAND_IN_BASE + folder.id), { account: account.id }),
    account: account.id,
    avatars: true,
    load: (cursor, direction) => {
      const result = queue.then(() => loadPage(cursor, direction))
      queue = result.catch(() => {})
      return result
    },
    onRead: markSeen,
    // a hidden folder is gone from the app's folder settings too, so it is managed from here
    menu: () => [
      {
        text: 'Каналы и настройки',
        icon: inu.icons.common('settings'),
        onClick: () => actions.settings(),
      },
      {
        text: 'Вернуть папку во вкладки',
        icon: inu.icons.common('close'),
        onClick: () => {
          history.close()
          actions.restore()
        },
      },
    ],
  })
  current = history

  const live = [
    inu.onNewMessage((message, from) => {
      if (from.id !== account.id || message.isService) return
      const peer = message.dialogId
      if (peer === null || !peerSet.has(peer)) return
      const key = entryKey(peer, message.id)
      shown.set(key, { peer, id: message.id, date: message.date })
      history.append({ entries: [feedEntry(peer, message)] })
    }),
    inu.onMessageEdited((message, from) => {
      if (from.id !== account.id) return
      const peer = message.dialogId
      if (peer === null || !peerSet.has(peer)) return
      history.replace({ entries: [feedEntry(peer, message)] })
      updateCached(account, peer, messages => messages.map(m => m.id === message.id ? message : m))
    }),
    inu.onMessageDeleted((peer, ids, from) => {
      if (from.id !== account.id || peer === null || !peerSet.has(peer)) return
      history.remove(ids.map(id => entryKey(peer, id)))
      updateCached(account, peer, messages => messages.filter(m => !ids.includes(m.id)))
    }),
  ]

  history.closed.then(() => {
    for (const dispose of live) dispose()
    if (readTimer !== null) {
      clearTimeout(readTimer)
      flushRead()
    }
    if (current === history) current = null
  }).catch((e) => {
    console.warn('feed: close handling failed', e)
  })
}

function channelsWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'канал'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'канала'
  return 'каналов'
}
