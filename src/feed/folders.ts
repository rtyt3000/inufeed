// feed folders are chosen per account and hidden from the app's folder tabs: the app's own
// messages.getDialogFilters responses are filtered, while the plugin's own calls bypass the
// interceptors and still see them

export interface FeedFolder {
  id: number
  title: string
  /** the feed row is pinned to the top of the lists it is in */
  pinned?: boolean
  /** the feed row is in the archive instead of "All chats" */
  archived?: boolean
  /** app folders (tabs) the feed row is shown in besides "All chats" */
  showIn?: number[]
  /** of those, the folders it is pinned in, with its place among the folder's pinned chats */
  pinnedIn?: Record<number, number>
  /** the feed's own avatar, see feed-avatar.ts */
  photoId?: number
  /** the avatar is drawn from the folder's icon, and follows it */
  iconAvatar?: boolean
}

export type ListedFolder = Extract<tl.TypeDialogFilter, { id: number }>

/**
 * Each feed's row is a stand-in group that exists only in the app's memory. Its id is this plus
 * the folder id, far above real chat ids
 */
export const STAND_IN_BASE = 777_000_000_000
/** folder ids are small; this bounds the stand-in id range */
export const STAND_IN_SPAN = 1_000_000

/** The feed folder of a stand-in group's channel id, or null */
export function standInFolder(channelId: number | string): number | null {
  const id = Number(channelId)
  return id >= STAND_IN_BASE && id < STAND_IN_BASE + STAND_IN_SPAN ? id - STAND_IN_BASE : null
}

export function standInPeer(folderId: number): tl.TypeInputPeer {
  return { _: 'inputPeerChannel', channel_id: STAND_IN_BASE + folderId, access_hash: '0' }
}

function standInFolderOfPeer(peer: tl.TypeInputPeer): number | null {
  return peer._ === 'inputPeerChannel' ? standInFolder(peer.channel_id) : null
}

function storageKey(userId: number): string {
  return `feedFolders:${userId}`
}

/** the single-folder format of earlier versions */
function legacyStorageKey(userId: number): string {
  return `feedFolder:${userId}`
}

export function getFeedFolders(userId: number): FeedFolder[] {
  try {
    const stored = localStorage.getItem(storageKey(userId))
    if (stored !== null) return JSON.parse(stored) as FeedFolder[]
    const legacy = localStorage.getItem(legacyStorageKey(userId))
    if (legacy !== null) return [JSON.parse(legacy) as FeedFolder]
  } catch {}
  return []
}

export function getFeedFolder(userId: number, folderId: number): FeedFolder | null {
  return getFeedFolders(userId).find(f => f.id === folderId) ?? null
}

function setFeedFolders(userId: number, folders: FeedFolder[]): void {
  localStorage.setItems({ [storageKey(userId)]: JSON.stringify(folders) })
  localStorage.removeItem(legacyStorageKey(userId))
}

export function addFeedFolder(userId: number, folder: FeedFolder): void {
  setFeedFolders(userId, [...getFeedFolders(userId).filter(f => f.id !== folder.id), folder])
}

export function updateFeedFolder(userId: number, folderId: number, patch: Partial<Omit<FeedFolder, 'id'>>): void {
  setFeedFolders(userId, getFeedFolders(userId).map(f => f.id === folderId ? { ...f, ...patch } : f))
}

export function removeFeedFolder(userId: number, folderId: number): void {
  setFeedFolders(userId, getFeedFolders(userId).filter(f => f.id !== folderId))
}

/** feed folders open in the app's folder editor, which may save them; `userId:folderId` */
const editing = new Set<string>()

export function isFeedFolderEditAllowed(userId: number, folderId: number): boolean {
  return editing.has(`${userId}:${folderId}`)
}

export function allowFeedFolderEdit(userId: number, folderId: number, allowed: boolean): void {
  if (allowed) editing.add(`${userId}:${folderId}`)
  else editing.delete(`${userId}:${folderId}`)
}

/** Makes the app refetch its folders, which applies a changed feed folder to the tabs */
export function reloadAppFolders(accountSlot: number): void {
  const controller = inu.jvm.cls('org.telegram.messenger.MessagesController').callStatic('getInstance', accountSlot)
  const reload = inu.jvm.routine(function () {
    controller.loadRemoteFilters(true)
  })
  inu.jvm.cls('org.telegram.messenger.AndroidUtilities').callStatic('runOnUIThread', reload)
}

/** Every folder of the account, including the hidden one */
export async function listFolders(account: inu.Account): Promise<ListedFolder[]> {
  const res = await account.invokeRpc({ _: 'messages.getDialogFilters' })
  if (!res) return []
  // the response is a live TL view; its vectors aren't JS arrays
  return structuredClone(res).filters.filter((f): f is ListedFolder => f._ !== 'dialogFilterDefault')
}

/** Marked ids of the broadcast channels in a folder, pinned first */
export async function getFolderChannels(account: inu.Account, folderId: number): Promise<number[]> {
  const folder = (await listFolders(account)).find(f => f.id === folderId)
  if (!folder) return []

  const ids = new Set<number>()
  for (const peer of [...folder.pinned_peers, ...folder.include_peers]) {
    if (peer._ !== 'inputPeerChannel') continue
    const id = inu.utils.peers.getMarkedPeerId(peer)
    // supergroups are channels too; unknown chats are kept rather than guessed at
    const chat = account.getChat(id)
    if (chat && !chat.broadcast) continue
    ids.add(id)
  }
  return [...ids]
}

/**
 * Records which folders the user put feed rows in, from a folder being saved, and returns the
 * folder without the stand-in groups, which the server doesn't know
 */
const FLAG_FIELDS = [
  'contacts', 'non_contacts', 'groups', 'broadcasts', 'bots',
  'exclude_muted', 'exclude_read', 'exclude_archived', 'title_noanimate',
] as const
const FLAG_EMOTICON = 1 << 25
const FLAG_COLOR = 1 << 27

/**
 * A copy of a folder the app is sending. The app sets a request's flag fields (broadcasts, groups...)
 * and computes its `flags` only when serializing it, while a view of the request reads flag fields
 * from `flags`: a plain copy would lose "all channels", "all groups" and the like. The app's own
 * object has them
 */
function copyOutgoingFolder(folder: ListedFolder): ListedFolder {
  const copy = structuredClone(folder)
  let java: JavaObject
  try {
    java = inu.jvm.fromTl(folder)
  } catch {
    return copy
  }
  const fields = copy as unknown as Record<string, unknown>
  for (const name of FLAG_FIELDS) {
    if (java.getField(name)) fields[name] = true
  }
  const flags: number = java.getField('flags')
  const emoticon: string | null = java.getField('emoticon')
  if (emoticon) fields.emoticon = emoticon
  else if (flags & FLAG_EMOTICON) delete fields.emoticon
  if (flags & FLAG_COLOR) fields.color = java.getField('color')
  else delete fields.color
  return copy
}

function takeStandIns(userId: number, folder: ListedFolder): { folder: ListedFolder, changed: boolean } {
  const copy = copyOutgoingFolder(folder)
  const shown = new Set<number>()
  /** feed folder => its place among the pinned chats */
  const pinned = new Map<number, number>()
  copy.include_peers = copy.include_peers.filter((peer) => {
    const feedId = standInFolderOfPeer(peer)
    if (feedId === null) return true
    shown.add(feedId)
    return false
  })
  copy.pinned_peers = copy.pinned_peers.filter((peer, index) => {
    const feedId = standInFolderOfPeer(peer)
    if (feedId === null) return true
    shown.add(feedId)
    pinned.set(feedId, index)
    return false
  })
  if (copy._ === 'dialogFilter') copy.exclude_peers = copy.exclude_peers.filter(peer => standInFolderOfPeer(peer) === null)

  let changed = false
  for (const feed of getFeedFolders(userId)) {
    const showIn = (feed.showIn ?? []).filter(id => id !== folder.id)
    if (shown.has(feed.id)) showIn.push(folder.id)
    const pinnedIn = { ...feed.pinnedIn }
    delete pinnedIn[folder.id]
    if (pinned.has(feed.id)) pinnedIn[folder.id] = pinned.get(feed.id)!
    if (JSON.stringify([feed.showIn ?? [], feed.pinnedIn ?? {}]) === JSON.stringify([showIn, pinnedIn])) continue
    updateFeedFolder(userId, feed.id, { showIn, pinnedIn })
    changed = true
  }
  return { folder: copy, changed }
}

/** `onFeedFolderEdited` runs when a feed folder, or where feed rows are shown, changes */
export function hideFeedFolderFromTabs(onFeedFolderEdited: () => void): void {
  inu.interceptRpc('messages.getDialogFilters', async (ctx, next) => {
    const res = await next()
    const feeds = getFeedFolders(ctx.account.userId)
    if (!res || feeds.length === 0) return undefined

    const hidden = new Set(feeds.map(f => f.id))
    const copy = structuredClone(res)
    copy.filters = copy.filters.filter(f => f._ === 'dialogFilterDefault' || !hidden.has(f.id))
    // the folders the user put feed rows in list their stand-in groups, so the app shows them there
    for (const filter of copy.filters) {
      if (filter._ !== 'dialogFilter') continue
      for (const feed of feeds) {
        if (!feed.showIn?.includes(filter.id)) continue
        const pinnedAt = feed.pinnedIn?.[filter.id]
        if (pinnedAt === undefined) filter.include_peers.push(standInPeer(feed.id))
        else filter.pinned_peers.splice(pinnedAt, 0, standInPeer(feed.id))
      }
    }
    return copy
  })

  inu.interceptRpc('messages.updateDialogFilter', async (ctx, next) => {
    const userId = ctx.account.userId
    const folderId = ctx.request.id
    const hidden = getFeedFolder(userId, folderId)

    if (!hidden) {
      if (!ctx.request.filter) {
        // a deleted folder shows no feed rows
        for (const feed of getFeedFolders(userId)) {
          if (feed.showIn?.includes(folderId)) updateFeedFolder(userId, feed.id, { showIn: feed.showIn.filter(id => id !== folderId) })
        }
        return next()
      }
      const { folder, changed } = takeStandIns(userId, ctx.request.filter)
      const result = await next({ ...structuredClone(ctx.request), filter: folder as tl.RawDialogFilter })
      if (changed) onFeedFolderEdited()
      return result
    }

    // the app doesn't know the hidden folders, so a new folder could get one's id and overwrite it.
    // Edits through the folder editor the plugin opened are the exception
    if (!editing.has(`${userId}:${folderId}`)) {
      // the app numbers a new folder after the ones it knows, which can be a hidden one's number
      if (!ctx.request.filter) throw new inu.RpcError(400, 'FILTER_ID_INVALID')
      const taken = new Set((await listFolders(ctx.account)).map(f => f.id))
      let free = 2
      while (taken.has(free)) free++
      const { folder } = takeStandIns(userId, ctx.request.filter)
      folder.id = free
      const result = await next({ ...structuredClone(ctx.request), id: free, filter: folder as tl.RawDialogFilter })
      // the app keeps the number it chose until it refetches
      reloadAppFolders(ctx.account.id)
      onFeedFolderEdited()
      return result
    }
    const deleted = !ctx.request.filter
    const title = ctx.request.filter?.title.text
    const result = await next()
    if (deleted) removeFeedFolder(userId, folderId)
    else if (title !== undefined) updateFeedFolder(userId, folderId, { title })
    onFeedFolderEdited()
    return result
  })

  inu.interceptUpdate('updateDialogFilter', ({ update, account }) => {
    if (!getFeedFolder(account.userId, update.id)) return 'deliver'
    onFeedFolderEdited()
    return 'drop'
  })
}
