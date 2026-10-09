import { readFlag, writeFlag } from '../shared/storage.js'
import { answerStandInRequests, isFeedChannel, openFeedOnTap, syncChatList } from './chat-list.js'
import { openFeedProfile } from './feed-profile.js'
import { addFeedButtonToFolderEditor } from './folder-editor.js'
import { handleFolderSettings, openFolderSettings } from './folder-settings.js'
import {
  getFeedFolder,
  getFeedFolders,
  hideFeedFolderFromTabs,
  listFolders,
  reloadAppFolders,
  removeFeedFolder,
  updateFeedFolder,
} from './folders.js'
import { openRepliesInChannel } from './reply-taps.js'
import { markFeedRead, openFeed, openFeedWithTitle } from './timeline.js'

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

function folderSettings(account: inu.Account, folderId: number): void {
  openFolderSettings(account, folderId).catch((e) => {
    report('opening folder settings')(e)
    inu.ui.toast('Не удалось открыть настройки папки')
  })
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
    advancedSettings: () => folderSettings(account, folderId),
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
      inu.ui.separator('Чтобы сделать ленту, откройте настройки папки и нажмите «Показывать как ленту». Папка пропадёт из вкладок, а её каналы соберутся в один чат. Действует только на этом устройстве.'),
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
addFeedButtonToFolderEditor(resync)
handleFolderSettings(openFeedWithTitle, (slot, folderId) => profile(inu.account(slot), folderId), resync)
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
