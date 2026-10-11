import { readFlag, writeFlag } from '../shared/storage.js'
import { answerStandInRequests, isFeedChannel, openFeedOnTap, syncChatList } from './chat-list.js'
import { openFeedProfile } from './feed-profile.js'
import {
  addFeedFolder,
  getFeedFolder,
  getFeedFolders,
  hideFeedFolderFromTabs,
  listFolders,
  reloadAppFolders,
  removeFeedFolder,
  updateFeedFolder,
} from './folders.js'
import { openRepliesInChannel } from './reply-taps.js'
import { markFeedRead, openFeed } from './timeline.js'

const MARK_READ_KEY = 'markRead'

function resync(): void {
  syncChatList().catch(() => {})
}

function report(what: string): (e: unknown) => void {
  return (e) => {
    console.error(`feed: ${what} failed`, e)
  }
}

function restore(account: inu.Account, folderId: number): void {
  const folder = getFeedFolder(account.userId, folderId)
  removeFeedFolder(account.userId, folderId)
  reloadAppFolders(account.id)
  resync()
  settings.invalidate()
  if (folder) inu.ui.toast(`«${folder.title}» снова во вкладках`)
}

function profile(account: inu.Account, folderId: number): void {
  openFeedProfile(account, folderId, {
    changed: async () => {
      await syncChatList()
      settings.invalidate()
    },
    chooseTabs: () => {
      chooseTabs(account, folderId).catch(report('choosing tabs'))
    },
    restore: () => restore(account, folderId),
  })
}

function open(account: inu.Account, folderId: number): void {
  const folder = getFeedFolder(account.userId, folderId)
  if (!folder) return
  openFeed(account, folder, readFlag(MARK_READ_KEY, true), {
    restore: () => restore(account, folderId),
    settings: () => profile(account, folderId),
  }).catch((e) => {
    report('open')(e)
    inu.ui.toast('Не удалось открыть ленту')
  })
}

async function chooseTabs(account: inu.Account, folderId: number): Promise<void> {
  const feed = getFeedFolder(account.userId, folderId)
  if (!feed) return
  const feedIds = new Set(getFeedFolders(account.userId).map(f => f.id))
  const tabs = (await listFolders(account)).filter(f => !feedIds.has(f.id))
  if (tabs.length === 0) {
    inu.ui.toast('Нет других папок')
    return
  }
  const shown = feed.showIn ?? []
  const picked = await inu.ui.chooser({
    title: `«${feed.title}» в папках`,
    items: tabs.map(f => f.title.text),
    selected: tabs.flatMap((f, index) => shown.includes(f.id) ? [index] : []),
    multiple: true,
  })
  if (picked === null) return
  updateFeedFolder(account.userId, folderId, { showIn: picked.map(index => tabs[index].id) })
  // the app learns which folders list the feed from the folders it fetches
  reloadAppFolders(account.id)
  resync()
}

async function makeFeed(account: inu.Account): Promise<void> {
  const feedIds = new Set(getFeedFolders(account.userId).map(f => f.id))
  const candidates = (await listFolders(account)).filter(f => !feedIds.has(f.id))
  if (candidates.length === 0) {
    inu.ui.toast('Нет папок, которые можно сделать лентой')
    return
  }
  const index = await inu.ui.chooser({
    title: 'Какая папка станет лентой?',
    items: candidates.map(f => f.title.text),
  })
  if (index === null) return
  const folder = candidates[index]
  addFeedFolder(account.userId, { id: folder.id, title: folder.title.text })
  reloadAppFolders(account.id)
  await syncChatList()
  settings.invalidate()
  inu.ui.toast(`«${folder.title.text}» теперь один чат в списке чатов`)
}

async function feedMenu(account: inu.Account, folderId: number): Promise<void> {
  const feed = getFeedFolder(account.userId, folderId)
  if (!feed) return
  const actions: [string, () => void | Promise<void>][] = [
    ['Открыть', () => open(account, folderId)],
    ['Каналы и настройки', () => profile(account, folderId)],
    ['Показывать в папках…', () => chooseTabs(account, folderId)],
    ['Вернуть папку во вкладки', () => restore(account, folderId)],
  ]
  const index = await inu.ui.chooser({
    title: feed.title,
    items: actions.map(([text], i) => i === actions.length - 1 ? { text, danger: true } : text),
  })
  if (index !== null) await actions[index][1]()
}

const settings = inu.ui.settingsPage({
  title: 'Лента',
  items: () => {
    const account = inu.account()
    const folders = getFeedFolders(account.userId)
    return [
      inu.ui.header('Ленты'),
      ...folders.map(folder => inu.ui.button({
        id: `feed-${folder.id}`,
        text: folder.title,
        subtitle: 'Нажмите, чтобы открыть, удерживайте для настроек',
        icon: inu.icons.common('channel'),
        onClick: () => open(account, folder.id),
        onSecondaryClick: () => {
          feedMenu(account, folder.id).catch(report('feed menu'))
        },
      })),
      inu.ui.button({
        id: 'make-feed',
        text: 'Сделать ленту из папки',
        icon: inu.icons.common('channel'),
        onClick: () => {
          makeFeed(account).catch(report('making a feed'))
        },
      }),
      inu.ui.separator('Папка пропадёт из вкладок, а её каналы соберутся в один чат в списке чатов. Действует только на этом устройстве.'),

      inu.ui.check({
        id: 'markRead',
        text: 'Отмечать посты прочитанными',
        checked: readFlag(MARK_READ_KEY, true),
        onChange: (checked) => {
          writeFlag(MARK_READ_KEY, checked)
          settings.invalidate()
        },
      }),
    ]
  },
})

inu.registerSettings(settings)

hideFeedFolderFromTabs(resync)
openFeedOnTap((slot, folderId) => open(inu.account(slot), folderId))
openRepliesInChannel(isFeedChannel)
// chat actions on a feed row, from the app's own menus and swipes
answerStandInRequests({
  open: (slot, folderId) => open(inu.account(slot), folderId),
  pin: (slot, folderId, pinned) => {
    updateFeedFolder(inu.account(slot).userId, folderId, { pinned })
    resync()
  },
  archive: (slot, folderId, archived) => {
    updateFeedFolder(inu.account(slot).userId, folderId, { archived })
    resync()
  },
  markRead: (slot, folderId) => {
    markFeedRead(inu.account(slot), folderId).catch(report('marking a feed read'))
  },
  remove: (slot, folderId) => restore(inu.account(slot), folderId),
})
inu.onAccountsChanged(resync)
resync()
