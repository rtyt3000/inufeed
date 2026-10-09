// shows each feed folder as one row in the chat list, and hides the feeds' channels from the main
// list and the folder tabs. There is no public API for the chat list, so this hooks the app:
// - every feed gets a stand-in group in the app's memory, with a dialog whose last message is the
//   newest post of the feed. Before MessagesController.sortDialogs, that dialog joins the app's
//   dialogs, so the app sorts, pins, archives, mutes and files it into folders like any chat
// - after sortDialogs / updateFilterDialogs, the feeds' channels are taken out of the lists, and the
//   stand-ins out of the lists they don't belong in (forward targets, groups the user owns...)
// - a tap on a feed row opens the feed
// - the app's requests about the stand-in groups never reach the server: chat actions on a feed row
//   are carried out on the feed instead
// The list hooks run on the UI thread for every rebuild, so they are routines

import { getFeedAvatar } from './feed-avatar.js'
import type { FeedAvatar } from './feed-avatar.js'
import { STAND_IN_BASE, STAND_IN_SPAN, getFeedFolders, getFolderChannels, standInFolder } from './folders.js'

const MAX_SLOTS = 32

/** The feed folder of a feed row's dialog id, or null */
export function feedFolderOfDialog(dialogId: number): number | null {
  return standInFolder(-dialogId)
}

export interface FeedRow {
  slot: number
  folderId: number
  title: string
  /** the app's own dialog ids of the feed channels */
  dialogIds: number[]
  pinned: boolean
  archived: boolean
  /** app folders (tabs) the row is shown in besides "All chats" */
  showIn: number[]
  avatar: FeedAvatar | null
}

/**
 * A stand-in group's photo for a feed avatar. The app looks for avatar files in its cache by their
 * location, and draws them from there without asking the server; the files are put there first
 */
function standInPhoto(slot: number, avatar: FeedAvatar): JavaObject {
  const FileLocation = cls('org.telegram.tgnet.TLRPC$TL_fileLocationToBeDeprecated')
  const FileLoader = cls('org.telegram.messenger.FileLoader').callStatic('getInstance', slot)
  // the app's own naming: small and big sizes of a photo
  const location = (localId: number): JavaObject => {
    const loc = new FileLocation()
    loc.setField('volume_id', -avatar.photoId)
    loc.setField('local_id', localId)
    loc.setField('dc_id', 2)
    const file = FileLoader.call('getPathToAttach', loc, true)
    if (!file.call('exists')) {
      const out = new (cls('java.io.FileOutputStream'))(file)
      try {
        out.call('write', avatar.jpeg)
      } finally {
        out.call('close')
      }
    }
    return loc
  }

  const photo = new (cls('org.telegram.tgnet.TLRPC$TL_chatPhoto'))()
  photo.setField('photo_id', avatar.photoId)
  photo.setField('dc_id', 2)
  photo.setField('photo_small', location(97))
  photo.setField('photo_big', location(99))
  return photo
}

const cls = (name: string): any => inu.jvm.cls(name)

let rowHooks: Disposer[] = []

/** the app's dialog ids of every feed channel, by account slot */
let feedChannels = new Map<number, Set<number>>()

/** feed row dialog ids put into the app's memory, by account slot */
let feedDialogs = new Map<number, number[]>()

/** marked ids of each feed's channels, by `slot:folderId` */
let channelsByFeed = new Map<string, number[]>()

/** A feed's channels as of the last sync, without asking the server */
export function cachedFeedChannels(slot: number, folderId: number): number[] | null {
  return channelsByFeed.get(`${slot}:${folderId}`) ?? null
}

export function isFeedChannel(slot: number, dialogId: number): boolean {
  return feedChannels.get(slot)?.has(dialogId) ?? false
}

function installRows(rows: FeedRow[]): void {
  for (const dispose of rowHooks) dispose()
  rowHooks = []

  const MessagesController = cls('org.telegram.messenger.MessagesController')
  const TL_channel = cls('org.telegram.tgnet.TLRPC$TL_channel')
  const TL_chatPhotoEmpty = cls('org.telegram.tgnet.TLRPC$TL_chatPhotoEmpty')
  const TL_dialog = cls('org.telegram.tgnet.TLRPC$TL_dialog')
  const TL_peerChannel = cls('org.telegram.tgnet.TLRPC$TL_peerChannel')
  const TL_peerNotifySettings = cls('org.telegram.tgnet.TLRPC$TL_peerNotifySettings')
  const HashSet = cls('java.util.HashSet')
  const Long = cls('java.lang.Long')

  // per-row state, captured by the routines as shared Object[]s
  const usable = rows.filter(row => row.slot >= 0 && row.slot < MAX_SLOTS)
  const ROW_SLOT = usable.map(row => row.slot)
  // tabs showing a row, as (row, folder) pairs
  const SHOW_ROW: number[] = []
  const SHOW_FOLDER: number[] = []
  // channels as (row, id) pairs
  const CHANNEL_ROW: number[] = []
  const CHANNEL_ID: number[] = []
  const DIALOGS: JavaObject[] = []
  // filled lazily by the routines: a HashSet<Long> of each slot's feed channels
  const SLOT_SETS: null[] = Array.from({ length: MAX_SLOTS }, () => null)
  const LOW = -(STAND_IN_BASE + STAND_IN_SPAN)
  const HIGH = -STAND_IN_BASE

  const dialogIds = new Map<number, number[]>()
  usable.forEach((row, index) => {
    for (const id of row.dialogIds) {
      CHANNEL_ROW.push(index)
      CHANNEL_ID.push(id)
    }
    for (const folderId of row.showIn) {
      SHOW_ROW.push(index)
      SHOW_FOLDER.push(folderId)
    }

    // a group rather than a channel: its rows name the sender, here the post's channel
    const chatId = STAND_IN_BASE + row.folderId
    // putChat(chat, true) leaves a chat the app already has alone, so a known stand-in is updated
    // in place: a renamed feed or a new avatar would not show otherwise
    const controller = MessagesController.callStatic('getInstance', row.slot)
    const known: JavaObject | null = controller.call('getChat', chatId)
    const chat = known ?? new TL_channel()
    chat.setField('id', chatId)
    chat.setField('title', row.title)
    let photo: JavaObject | null = null
    if (row.avatar) {
      try {
        photo = standInPhoto(row.slot, row.avatar)
      } catch (e) {
        console.error('feed: avatar files failed', e)
      }
    }
    chat.setField('photo', photo ?? new TL_chatPhotoEmpty())
    // the app draws no photo of a channel without an access hash; the stand-in is never asked for
    chat.setField('access_hash', 1)
    chat.setField('megagroup', true)
    if (!known) controller.call('putChat', chat, true)

    const peer = new TL_peerChannel()
    peer.setField('channel_id', chatId)
    const dialog = new TL_dialog()
    dialog.setField('id', -chatId)
    dialog.setField('peer', peer)
    dialog.setField('notify_settings', new TL_peerNotifySettings())
    dialog.setField('folder_id', row.archived ? 1 : 0)
    if (row.pinned) {
      dialog.setField('pinned', true)
      // above the user's own pins
      dialog.setField('pinnedNum', 1_000_000 + row.folderId)
    }
    DIALOGS.push(dialog)

    dialogIds.set(row.slot, [...dialogIds.get(row.slot) ?? [], -chatId])
  })
  feedDialogs = dialogIds

  rowHooks.push(inu.xposed.hookMethod(MessagesController.getDeclaredMethod('sortDialogs'), {
    before: inu.xposed.routine((ctx) => {
      const mc = ctx.thisObject
      const slot = mc.currentAccount
      // feed dialogs of an earlier sync (or of a feed that is gone) would be drawn twice
      const all = mc.allDialogs
      for (let i = all.size() - 1; i >= 0; i--) {
        const d = all.get(i)
        if (d.id <= LOW || d.id > HIGH) continue
        let current = false
        for (const dialog of DIALOGS) {
          if (dialog === d) current = true
        }
        if (!current) all.remove(d)
      }
      for (let k = 0; k < ROW_SLOT.length; k++) {
        if (ROW_SLOT[k] !== slot) continue
        const dialog = DIALOGS[k]
        let newest = null
        let unread = 0
        for (let j = 0; j < CHANNEL_ID.length; j++) {
          if (CHANNEL_ROW[j] !== k) continue
          const d = mc.dialogs_dict.get(CHANNEL_ID[j])
          // archived channels stay in the archive
          if (d === null || d.folder_id !== 0) continue
          unread += d.unread_count
          if (newest === null || d.last_message_date > newest.last_message_date) newest = d
        }
        if (newest === null) continue

        dialog.last_message_date = newest.last_message_date
        dialog.top_message = newest.top_message
        dialog.unread_count = unread
        mc.dialogs_dict.put(dialog.id, dialog)
        const messages = mc.dialogMessage.get(newest.id)
        if (messages !== null) mc.dialogMessage.put(dialog.id, messages)
        // the app may have dropped it, e.g. when it reloads its dialogs
        if (!mc.allDialogs.contains(dialog)) mc.allDialogs.add(dialog)
      }
    }),
    after: inu.xposed.routine((ctx) => {
      const mc = ctx.thisObject
      const slot = mc.currentAccount
      if (slot >= SLOT_SETS.length) return
      let slotSet = SLOT_SETS[slot]
      if (slotSet === null) {
        slotSet = new HashSet()
        for (let j = 0; j < CHANNEL_ID.length; j++) {
          if (ROW_SLOT[CHANNEL_ROW[j]] === slot) slotSet.add(Long.valueOf(CHANNEL_ID[j]))
        }
        SLOT_SETS[slot] = slotSet
      }

      const list = mc.getDialogs(0)
      for (let i = list.size() - 1; i >= 0; i--) {
        const d = list.get(i)
        if (d.id < 0 && slotSet.contains(Long.valueOf(d.id))) list.remove(d)
      }

      // a stand-in is no chat to forward to, add people to, or block
      const sideLists = [
        mc.dialogsForward, mc.dialogsCanAddUsers, mc.dialogsMyGroups, mc.dialogsGroupsOnly,
        mc.dialogsServerOnly, mc.dialogsChannelsOnly, mc.dialogsMyChannels, mc.dialogsUsersOnly,
        mc.dialogsForBlock,
      ]
      for (const side of sideLists) {
        for (let i = side.size() - 1; i >= 0; i--) {
          const d = side.get(i)
          if (d.id > LOW && d.id <= HIGH) side.remove(d)
        }
      }

      for (const filter of mc.selectedDialogFilter) {
        if (filter === null) continue
        const dialogs = filter.dialogs
        for (let i = dialogs.size() - 1; i >= 0; i--) {
          const d = dialogs.get(i)
          if (d.id < 0 && slotSet.contains(Long.valueOf(d.id))) {
            dialogs.remove(d)
          } else if (d.id > LOW && d.id <= HIGH) {
            // only folders the user put the feed in; a stand-in group would match "Groups"
            let shown = false
            for (let j = 0; j < SHOW_ROW.length; j++) {
              if (SHOW_FOLDER[j] === filter.id && DIALOGS[SHOW_ROW[j]] === d) shown = true
            }
            if (!shown) dialogs.remove(d)
          }
        }
      }
    }),
  }))

  // a single tab's list can be rebuilt on its own
  rowHooks.push(inu.xposed.hookMethod(MessagesController.getDeclaredMethod('updateFilterDialogs'), {
    after: inu.xposed.routine((ctx) => {
      const slot = ctx.thisObject.currentAccount
      if (slot >= SLOT_SETS.length) return
      const slotSet = SLOT_SETS[slot]
      const filter = ctx.args[0]
      if (slotSet === null || filter === null) return
      const dialogs = filter.dialogs
      for (let i = dialogs.size() - 1; i >= 0; i--) {
        const d = dialogs.get(i)
        if (d.id < 0 && slotSet.contains(Long.valueOf(d.id))) {
          dialogs.remove(d)
        } else if (d.id > LOW && d.id <= HIGH) {
          let shown = false
          for (let j = 0; j < SHOW_ROW.length; j++) {
            if (SHOW_FOLDER[j] === filter.id && DIALOGS[SHOW_ROW[j]] === d) shown = true
          }
          if (!shown) dialogs.remove(d)
        }
      }
    }),
  }))

  resortAll()
}

/** Rebuilds every account's lists and redraws them, so a changed feed applies right away */
function resortAll(): void {
  const MessagesController = cls('org.telegram.messenger.MessagesController')
  const NotificationCenter = cls('org.telegram.messenger.NotificationCenter')
  const AndroidUtilities = cls('org.telegram.messenger.AndroidUtilities')
  const DIALOGS_NEED_RELOAD: number = NotificationCenter.getStaticField('dialogsNeedReload')

  for (const account of inu.accounts()) {
    const controller = MessagesController.callStatic('getInstance', account.id)
    const center = NotificationCenter.callStatic('getInstance', account.id)
    const resort = inu.jvm.routine(function () {
      controller.sortDialogs(null)
      center.postNotificationName(DIALOGS_NEED_RELOAD, [])
    })
    AndroidUtilities.callStatic('runOnUIThread', resort)
  }

  // an unchanged row is not rebound, so a renamed feed would keep its old title
  const LaunchActivity = cls('org.telegram.ui.LaunchActivity')
  const DialogsActivity = cls('org.telegram.ui.DialogsActivity')
  const rebind = inu.jvm.routine(function () {
    const launch = LaunchActivity.instance
    if (launch === null) return
    for (const fragment of launch.getActionBarLayout().getFragmentStack()) {
      if (!(fragment instanceof DialogsActivity) || fragment.viewPages === null) continue
      for (const page of fragment.viewPages) {
        if (page !== null && page.dialogsAdapter !== null) page.dialogsAdapter.notifyDataSetChanged()
      }
    }
  })
  AndroidUtilities.callStatic('runOnUIThread', rebind)
}

// without the hooks the feed rows would stay in the lists, and the channels would stay hidden
inu.onUnload(() => {
  for (const dispose of rowHooks) dispose()
  rowHooks = []

  const MessagesController = cls('org.telegram.messenger.MessagesController')
  const NotificationCenter = cls('org.telegram.messenger.NotificationCenter')
  const DIALOGS_NEED_RELOAD: number = NotificationCenter.getStaticField('dialogsNeedReload')
  const noArgs = cls('java.lang.reflect.Array').callStatic('newInstance', cls('java.lang.Object'), 0)
  const slots = inu.accounts().map(account => account.id)
  const dialogs = feedDialogs

  return new Promise<void>((resolve) => {
    // routines stop with the plugin, but runnables created during cleanup still run
    const cleanup = inu.jvm.runnable(() => {
      try {
        for (const slot of slots) {
          const controller = MessagesController.callStatic('getInstance', slot)
          const all = controller.getField('allDialogs')
          for (const id of dialogs.get(slot) ?? []) {
            const dialog = controller.getField('dialogs_dict').call('get', id)
            if (dialog) all.call('remove', dialog)
            controller.getField('dialogs_dict').call('remove', id)
            controller.getField('dialogMessage').call('remove', id)
          }
          controller.call('sortDialogs', null)
          NotificationCenter.callStatic('getInstance', slot).call('postNotificationName', DIALOGS_NEED_RELOAD, noArgs)
        }
      } finally {
        resolve()
      }
    })
    cls('org.telegram.messenger.AndroidUtilities').callStatic('runOnUIThread', cleanup)
  })
})

let syncing: Promise<void> = Promise.resolve()

/** Re-reads every account's feed folders and refreshes the chat list rows */
export function syncChatList(): Promise<void> {
  syncing = syncing.then(async () => {
    const rows: FeedRow[] = []
    const byFeed = new Map<string, number[]>()
    for (const account of inu.accounts()) {
      for (const folder of getFeedFolders(account.userId)) {
        const channels = await getFolderChannels(account, folder.id)
        byFeed.set(`${account.id}:${folder.id}`, channels)
        rows.push({
          slot: account.id,
          folderId: folder.id,
          title: folder.title,
          dialogIds: channels.map(id => inu.utils.peers.toSimpleDialogId(id)),
          pinned: folder.pinned ?? false,
          archived: folder.archived ?? false,
          showIn: folder.showIn ?? [],
          avatar: getFeedAvatar(account.userId, folder.id),
        })
      }
    }
    const channels = new Map<number, Set<number>>()
    for (const row of rows) {
      const set = channels.get(row.slot) ?? new Set<number>()
      for (const id of row.dialogIds) set.add(id)
      channels.set(row.slot, set)
    }
    feedChannels = channels
    channelsByFeed = byFeed
    installRows(rows)
  }).catch((e) => {
    console.error('feed: chat list sync failed', e)
  })
  return syncing
}

/** What chat actions on a feed row do to the feed */
export interface FeedRowActions {
  open(slot: number, folderId: number): void
  pin(slot: number, folderId: number, pinned: boolean): void
  archive(slot: number, folderId: number, archived: boolean): void
  markRead(slot: number, folderId: number): void
  remove(slot: number, folderId: number): void
}

function standInOfPeer(peer: tl.TypeInputPeer): number | null {
  return peer._ === 'inputPeerChannel' ? standInFolder(peer.channel_id) : null
}

function standInOfChannel(channel: tl.TypeInputChannel): number | null {
  return channel._ === 'inputChannel' ? standInFolder(channel.channel_id) : null
}

const emptyUpdates = (): tl.TypeUpdates =>
  ({ _: 'updates', updates: [], users: [], chats: [], date: Math.floor(Date.now() / 1000), seq: 0 })

/**
 * The stand-in groups exist only in the app's memory. The app still asks the server about chats it
 * shows (e.g. preloading their history), and chat actions on a feed row become requests about its
 * stand-in; both are answered here
 */
export function answerStandInRequests(actions: FeedRowActions): void {
  const log = (method: string): void => console.log(`feed: answered ${method} for a feed row`)

  inu.interceptRpc('messages.getHistory', (ctx, next) => {
    if (standInOfPeer(ctx.request.peer) === null) return next()
    log('messages.getHistory')
    return { _: 'messages.messages', messages: [], topics: [], chats: [], users: [] }
  })

  inu.interceptRpc('updates.getChannelDifference', (ctx, next) => {
    if (standInOfChannel(ctx.request.channel) === null) return next()
    log('updates.getChannelDifference')
    return { _: 'updates.channelDifferenceEmpty', final: true, pts: ctx.request.pts }
  })

  inu.interceptRpc('channels.getFullChannel', (ctx, next) => {
    if (standInOfChannel(ctx.request.channel) === null) return next()
    log('channels.getFullChannel')
    throw new inu.RpcError(400, 'CHANNEL_INVALID')
  })

  inu.interceptRpc('channels.getChannels', (ctx, next) => {
    // requests are live TL views, whose vectors aren't JS arrays
    const ids = structuredClone(ctx.request).id
    const real = ids.filter(channel => standInOfChannel(channel) === null)
    if (real.length === ids.length) return next()
    log('channels.getChannels')
    if (real.length === 0) return { _: 'messages.chats', chats: [] }
    return next({ _: 'channels.getChannels', id: real })
  })

  inu.interceptRpc('messages.getPeerDialogs', (ctx, next) => {
    const peers = structuredClone(ctx.request).peers
    const real = peers.filter(peer => peer._ !== 'inputDialogPeer' || standInOfPeer(peer.peer) === null)
    if (real.length === peers.length) return next()
    log('messages.getPeerDialogs')
    // an empty request is invalid; asking for Saved Messages instead is harmless
    return next({
      _: 'messages.getPeerDialogs',
      peers: real.length > 0 ? real : [{ _: 'inputDialogPeer', peer: { _: 'inputPeerSelf' } }],
    })
  })

  inu.interceptRpc('messages.toggleDialogPin', (ctx, next) => {
    const peer = ctx.request.peer
    const folderId = peer._ === 'inputDialogPeer' ? standInOfPeer(peer.peer) : null
    if (folderId === null) return next()
    actions.pin(ctx.account.id, folderId, ctx.request.pinned ?? false)
    return { _: 'boolTrue' }
  })

  inu.interceptRpc('messages.reorderPinnedDialogs', (ctx, next) => {
    const request = structuredClone(ctx.request)
    const order = request.order.filter(peer => peer._ !== 'inputDialogPeer' || standInOfPeer(peer.peer) === null)
    if (order.length === request.order.length) return next()
    return next({ ...request, order })
  })

  // the app keeps notification settings of its own; the server has nothing to store
  inu.interceptRpc('account.updateNotifySettings', (ctx, next) => {
    const peer = ctx.request.peer
    if (peer._ !== 'inputNotifyPeer' || standInOfPeer(peer.peer) === null) return next()
    return { _: 'boolTrue' }
  })

  inu.interceptRpc('channels.readHistory', (ctx, next) => {
    const folderId = standInOfChannel(ctx.request.channel)
    if (folderId === null) return next()
    actions.markRead(ctx.account.id, folderId)
    return { _: 'boolTrue' }
  })

  inu.interceptRpc('folders.editPeerFolders', (ctx, next) => {
    const folderPeers = structuredClone(ctx.request).folder_peers
    const real = folderPeers.filter((entry) => {
      const folderId = standInOfPeer(entry.peer)
      if (folderId === null) return true
      actions.archive(ctx.account.id, folderId, entry.folder_id === 1)
      return false
    })
    if (real.length === folderPeers.length) return next()
    return real.length > 0 ? next({ _: 'folders.editPeerFolders', folder_peers: real }) : emptyUpdates()
  })

  // "delete chat" on a feed row turns the feed back into a folder
  inu.interceptRpc('channels.leaveChannel', (ctx, next) => {
    const folderId = standInOfChannel(ctx.request.channel)
    if (folderId === null) return next()
    actions.remove(ctx.account.id, folderId)
    return emptyUpdates()
  })
}

function later(task: () => void): void {
  // UI-thread hooks can't use plugin-thread APIs
  Promise.resolve().then(task).catch((e) => {
    console.error('feed: chat list task failed', e)
  })
}

/** A tap on a feed row opens the feed; selecting rows and their menus stay the app's */
export function openFeedOnTap(open: (slot: number, folderId: number) => void): void {
  const DialogsActivity = inu.jvm.cls('org.telegram.ui.DialogsActivity')
  const DialogCell = inu.jvm.cls('org.telegram.ui.Cells.DialogCell')
  const LOW = -(STAND_IN_BASE + STAND_IN_SPAN)
  const HIGH = -STAND_IN_BASE

  inu.xposed.hookMethod(DialogsActivity.getDeclaredMethod('onItemClick'), {
    filter: inu.jvm.routine(function (view) {
      return view instanceof DialogCell && view.getDialogId() > LOW && view.getDialogId() <= HIGH
        && !this.actionBar.isActionModeShowed()
    }),
    // a failing filter lets the hook run, so the view is checked again
    before: (ctx) => {
      const view = ctx.args[0]
      if (!DialogCell.isInstance(view)) return
      const folderId = feedFolderOfDialog((view as JavaObject).call('getDialogId'))
      const activity = ctx.thisObject!
      if (folderId === null || activity.getField('actionBar').call('isActionModeShowed')) return
      const slot: number = activity.call('getCurrentAccount')
      ctx.setReturnValue(null)
      later(() => open(slot, folderId))
    },
  })
}
