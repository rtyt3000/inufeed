// opens the app's own folder editor (FilterCreateActivity) for a feed folder. The app has dropped
// hidden folders, so the editor gets a MessagesController.DialogFilter built from the server's
// folder the same way the app builds its own (MessagesStorage.checkLoadedRemoteFilters). While the
// editor is open, folders.ts lets its saves through; once it closes, the app refetches its folders
// and the feed folder is hidden again

import { allowFeedFolderEdit, isFeedFolderEditAllowed, listFolders, reloadAppFolders } from './folders.js'

const cls = (name: string): any => inu.jvm.cls(name)

function simpleIds(peers: tl.TypeInputPeer[]): number[] {
  return peers
    .filter(peer => peer._ === 'inputPeerUser' || peer._ === 'inputPeerChat' || peer._ === 'inputPeerChannel')
    .map(peer => inu.utils.peers.toSimpleDialogId(inu.utils.peers.getMarkedPeerId(peer)))
}

/**
 * A java List<Long> of ids. The app's folder lists hold Longs; a number handed to Java, even
 * through a routine's Long.valueOf, comes back boxed as an Integer when it fits one, which the app
 * then fails to cast
 */
function longList(ids: number[]): JavaObject {
  const reflectArray = cls('java.lang.reflect.Array')
  const array = reflectArray.callStatic('newInstance', cls('java.lang.Long').getStaticField('TYPE'), ids.length)
  ids.forEach((id, index) => reflectArray.callStatic('setLong', array, index, id))
  return cls('java.util.stream.LongStream').callStatic('of', array)
    .call('boxed')
    .call('collect', cls('java.util.stream.Collectors').callStatic('toList'))
}

async function buildAppFilter(account: inu.Account, folderId: number): Promise<JavaObject | null> {
  const folder = (await listFolders(account)).find(f => f.id === folderId)
  if (!folder) return null

  const MessagesController = cls('org.telegram.messenger.MessagesController')
  const flag = (name: string): number => MessagesController.getStaticField(`DIALOG_FILTER_FLAG_${name}`)
  let flags = 0
  if (folder.contacts) flags |= flag('CONTACTS')
  if (folder.non_contacts) flags |= flag('NON_CONTACTS')
  if (folder.groups) flags |= flag('GROUPS')
  if (folder.broadcasts) flags |= flag('CHANNELS')
  if (folder.bots) flags |= flag('BOTS')
  if (folder.exclude_muted) flags |= flag('EXCLUDE_MUTED')
  if (folder.exclude_read) flags |= flag('EXCLUDE_READ')
  if (folder.exclude_archived) flags |= flag('EXCLUDE_ARCHIVED')
  if (folder._ === 'dialogFilterChatlist') {
    flags |= flag('CHATLIST')
    if (folder.has_my_invites) flags |= flag('CHATLIST_ADMIN')
  }

  const filter = new (cls('org.telegram.messenger.MessagesController$DialogFilter'))()
  filter.setField('id', folder.id)
  filter.setField('flags', flags)
  filter.setField('name', folder.title.text)
  filter.setField('entities', new (cls('java.util.ArrayList'))())
  filter.setField('title_noanimate', folder.title_noanimate ?? false)
  filter.setField('color', folder.color ?? -1)
  filter.setField('pendingUnreadCount', -1)
  if (folder.emoticon) filter.setField('inu_emoticon', folder.emoticon)

  const pinned = simpleIds(folder.pinned_peers)
  const included = [...new Set([...pinned, ...simpleIds(folder.include_peers)])]
  const excluded = folder._ === 'dialogFilter' ? simpleIds(folder.exclude_peers) : []
  filter.getField('alwaysShow').call('addAll', longList(included))
  filter.getField('neverShow').call('addAll', longList(excluded))
  const pinnedDialogs = filter.getField('pinnedDialogs')
  pinned.forEach((id, index) => pinnedDialogs.call('put', id, index + 1))
  return filter
}

export async function openFolderSettings(account: inu.Account, folderId: number): Promise<void> {
  const filter = await buildAppFilter(account, folderId)
  if (!filter) {
    inu.ui.toast('Папка не найдена')
    return
  }
  allowFeedFolderEdit(account.userId, folderId, true)
  const present = inu.jvm.runnable(() => {
    // an error thrown here would stop the whole plugin
    try {
      const top = cls('org.telegram.ui.LaunchActivity').callStatic('getLastFragment')
      top?.call('presentFragment', new (cls('org.telegram.ui.FilterCreateActivity'))(filter))
    } catch (e) {
      allowFeedFolderEdit(account.userId, folderId, false)
      later(() => {
        console.error('feed: opening the folder editor failed', e)
        inu.ui.toast('Не удалось открыть настройки папки')
      })
    }
  })
  cls('org.telegram.messenger.AndroidUtilities').callStatic('runOnUIThread', present)
}

function later(task: () => void): void {
  // UI-thread hooks can't use plugin-thread APIs
  Promise.resolve().then(task).catch((e) => {
    console.error('feed: folder settings task failed', e)
  })
}

/**
 * Tapping the title of a feed screen calls `onTitleTap` (as a chat's title opens its profile), and
 * closing a folder editor the plugin opened hides the folder again
 */
export function handleFolderSettings(
  openFeedOf: (title: string) => { slot: number, folderId: number } | null,
  onTitleTap: (slot: number, folderId: number) => void,
  onEditorClosed: () => void,
): void {
  const ChatActivity = cls('org.telegram.ui.ChatActivity')
  const ChatAvatarContainer = cls('org.telegram.ui.Components.ChatAvatarContainer')
  const FilterCreateActivity = cls('org.telegram.ui.FilterCreateActivity')
  const UserConfig = cls('org.telegram.messenger.UserConfig')
  const PLUGIN_MODE: number = ChatActivity.getStaticField('inu_MODE_PLUGIN_HISTORY')

  /** the open feed a plugin chat screen shows, by its title */
  const feedOf = (avatarContainer: JavaObject): { slot: number, folderId: number } | null => {
    const text = avatarContainer.call('getTitleTextView').call('getText')
    return openFeedOf(typeof text === 'string' ? text : String(text?.call('toString') ?? ''))
  }

  // the app makes the header of a plugin chat screen inert, so it gets a listener of its own
  const HeaderClick = inu.jvm.defineClass({
    interfaces: [inu.jvm.cls('android.view.View$OnClickListener')],
    fields: { container: 'org.telegram.ui.Components.ChatAvatarContainer' },
    methods: {
      onClick: (self) => {
        const feed = feedOf(self.getField('container'))
        if (feed) later(() => onTitleTap(feed.slot, feed.folderId))
      },
    },
  })

  inu.xposed.hookMethod(ChatActivity.getDeclaredMethod('createView'), {
    after: (ctx) => {
      const activity = ctx.thisObject!
      if (activity.call('getChatMode') !== PLUGIN_MODE) return
      const container: JavaObject | null = activity.getField('avatarContainer')
      if (!container) return
      const listener = new HeaderClick()
      listener.setField('container', container)
      container.call('setOnClickListener', listener)
    },
  })

  // in case a version of the app does open profiles from plugin screens
  inu.xposed.hookAllOverloads(ChatAvatarContainer, 'openProfile', {
    filter: inu.jvm.routine(function () {
      const fragment = this.parentFragment
      return fragment !== null && fragment.getChatMode() === PLUGIN_MODE
    }),
    before: (ctx) => {
      const fragment: JavaObject | null = ctx.thisObject!.getField('parentFragment')
      if (!fragment || fragment.call('getChatMode') !== PLUGIN_MODE) return
      const feed = feedOf(ctx.thisObject!)
      if (!feed) return
      ctx.setReturnValue(null)
      later(() => onTitleTap(feed.slot, feed.folderId))
    },
  })

  inu.xposed.hookMethod(FilterCreateActivity.getDeclaredMethod('onFragmentDestroy'), {
    after: (ctx) => {
      const fragment = ctx.thisObject!
      const filter: JavaObject | null = fragment.getField('filter')
      if (!filter) return
      const folderId: number = filter.getField('id')
      const slot: number = fragment.call('getCurrentAccount')
      const userId: number = UserConfig.callStatic('getInstance', slot).call('getClientUserId')
      later(() => {
        if (!isFeedFolderEditAllowed(userId, folderId)) return
        allowFeedFolderEdit(userId, folderId, false)
        // a save made the app add the folder back to its tabs
        reloadAppFolders(slot)
        onEditorClosed()
      })
    },
  })
}
